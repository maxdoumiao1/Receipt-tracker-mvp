// api/parse-receipt.js — 优先规则解析 Costco 油票，失败再回退 LLM
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ——工具：读取 JSON body（Vercel 纯 Node 函数不自动解析）——
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ——工具：数值与单位规范——
const toNum = (x) => {
  const n = parseFloat(String(x ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const normUnit = (u) => {
  if (!u) return '';
  u = String(u).toLowerCase();
  if (/gall?on|^gal$/.test(u)) return 'gal';
  if (/^lb?s?$|pound/.test(u)) return 'lb';
  if (/^kgs?$/.test(u)) return 'kg';
  if (/^oz$/.test(u)) return 'oz';
  if (/^l$|liter|litre/.test(u)) return 'l';
  if (/^ml$/.test(u)) return 'ml';
  if (/^ct$|count|pcs?$|pk$/.test(u)) return 'ct';
  return u;
};
const calcUnitPrice = (total, qty, unit) =>
  total != null && qty ? `${(total / qty).toFixed(4)} $/${unit || ''}`.trim() : null;

// ——成本科油票专用解析（高优先）——
// —— 从 OCR 文本中提日期（优先 “Date: 09/10/25”）——
function extractDateISO(text) {
  const m = text.match(/date[:\s]*([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{2,4})/i)
        || text.match(/\b([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{2,4})\b/);
  if (!m) return new Date().toISOString().slice(0,10);
  const mm = m[1], dd = m[2], yy = m[3].length === 2 ? ('20' + m[3]) : m[3];
  return `${yy}-${mm}-${dd}`;
}

// —— 把数字里常见的 OCR 混淆字符纠正 ——
// 只用于“金额/数量”提取，不全局替换
function fixNumericGlyphs(s) {
  return s
    .replace(/[Oo]/g, '0')
    .replace(/[Il]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Uu]/g, '4');
}

// —— 将一行里所有“看起来像数字”的片段转成数值（包含 $2.799、12401、3u.71 等）——
function parseNumericTokens(line) {
  const tokens = [];
  const re = /(?:\$?\s*[0-9OIlSsUu]+(?:\.[0-9OIlSsUu]+)?)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const raw = m[0];
    const cleaned = fixNumericGlyphs(raw).replace(/[^0-9.]/g, '');
    if (!cleaned) continue;
    const val = parseFloat(cleaned);
    if (Number.isFinite(val)) {
      tokens.push({
        raw,
        cleaned,
        val,
        hasDot: cleaned.includes('.'),
        idx: m.index
      });
    }
  }
  return tokens;
}

// —— Costco/Fuel 专用解析（优先使用），从“Pump Gallons Price …”区域抽取 —— 
// —— 从 OCR 文本中提日期（保留你现有的 extractDateISO） ——
// ……（你的 extractDateISO / fixNumericGlyphs 已经在文件里，无需改动）……

// —— 仅用于提取 $ 后的金额（强制含小数或明确金额）——
function pickPriceFromLine(line) {
  // 先找 $x.xx 形式
  const m1 = line.match(/\$\s*([0-9OIlSsUu]+(?:\.[0-9OIlSsUu]{1,3})?)/);
  if (m1) {
    const cleaned = fixNumericGlyphs(m1[1]).replace(/[^0-9.]/g, '');
    const val = parseFloat(cleaned);
    if (Number.isFinite(val)) return val;
  }
  // 再找带 Price 且是小数的形式
  const m2 = line.match(/price[^0-9]*([0-9OIlSsUu]+(?:\.[0-9OIlSsUu]{1,3}))/i);
  if (m2) {
    const cleaned = fixNumericGlyphs(m2[1]).replace(/[^0-9.]/g, '');
    const val = parseFloat(cleaned);
    if (Number.isFinite(val)) return val;
  }
  return null;
}

// —— 从若干行里挑单价（只收 1~10，优先小数，避免把“3”这种标题里的数字当价）——
function findPrice(lines, idxs) {
  let cand = [];
  for (const i of idxs) {
    if (i < 0 || i >= lines.length) continue;
    const ln = lines[i];
    const p = pickPriceFromLine(ln);
    if (p != null && p >= 1 && p <= 10) {
      const hasDot = /\./.test(ln);
      cand.push({ p, hasDot, i });
    }
  }
  // 优先带小数点的；再按距离“pump行”近、数值更合理排序
  cand.sort((a, b) => (b.hasDot - a.hasDot) || (a.p - b.p));
  return cand.length ? cand[0].p : null;
}

// —— 提取 3 位小数（优先）或 4~5 位整数（按 /1000 还原）的加仑数 —— 
function gallonsFromLine(line) {
  const res = [];
  // 12.401 / 9.876 等带 3 位小数
  const r1 = line.match(/([0-9]{1,2}\.[0-9]{3})/g) || [];
  for (const s of r1) {
    const v = parseFloat(s);
    if (v > 2 && v <= 50) res.push(v);
  }
  // 12401 / 09876 等 4~5 位整数（很多 OCR 会把小数点丢了）
  const r2 = line.match(/\b([0-9]{4,5})\b/g) || [];
  for (const s of r2) {
    const v = parseFloat(s) / 1000;
    if (v > 2 && v <= 50) res.push(v);
  }
  return res;
}

// —— 在若干行里挑加仑（取最大；通常加仑 > 单价）——
function findGallons(lines, idxs) {
  let pool = [];
  for (const i of idxs) {
    if (i < 0 || i >= lines.length) continue;
    pool.push(...gallonsFromLine(lines[i]));
  }
  if (!pool.length) return null;
  // 优先取有 3 位小数的；否则取最大
  const with3 = pool.filter(v => /\.\d{3}$/.test(v.toFixed(3)));
  if (with3.length) return Math.max(...with3);
  return Math.max(...pool);
}

// —— Costco/Fuel 专用解析（替换成这版） —— 
function parseFuelCostco(rawText) {
  const text = rawText.replace(/[^\x20-\x7E\n]/g, ' ');
  const dateISO = extractDateISO(text);
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 锁定 “pump/gallon/price” 区域，取附近几行做候选
  let idx = lines.findIndex(l => /pump/i.test(l));
  if (idx === -1) idx = lines.findIndex(l => /gallon/i.test(l));
  const idxs = new Set([idx - 1, idx, idx + 1, idx + 2, idx + 3]);
  // 再把包含 $ 或 price/gallon 的行加入候选
  lines.forEach((l, i) => { if (/\$|price|gallon/i.test(l)) idxs.add(i); });
  const windowIdxs = [...idxs].filter(i => i >= 0 && i < lines.length);

  // 单价：只接受 $x.xx 或 Price x.xx（拒绝“3f/7”这种噪音整数）
  let price = findPrice(lines, windowIdxs);

  // 加仑：优先 3 位小数（或 4~5 位整数 /1000）
  let gallons = findGallons(lines, windowIdxs);

  // 如果价>10 且加仑<5，互换一次（极端兜底）
  if (price != null && gallons != null && price > 10 && gallons < 5) {
    const t = price; price = gallons; gallons = t;
  }

  // 尝试总价辅助（Total Sale）
  const totalMatch = text.match(/total\s+sale\s*[: ]*\$?\s*([0-9OIlSsUu.]+)/i);
  const totalOCR = totalMatch ? parseFloat(fixNumericGlyphs(totalMatch[1]).replace(/[^0-9.]/g,'')) : null;

  if (price != null && gallons != null) {
    const priceTotal = +(gallons * price).toFixed(2);
    return {
      name: 'Fuel (Regular)',
      priceTotal,
      qtyValue: +(+gallons).toFixed(3),
      qtyUnit: 'gal',
      unitPrice: `${(+price).toFixed(3)} $/gal`,
      date: dateISO
    };
  }

  // 如果没抓到加仑，但有总价+单价，用总价/单价反推加仑
  if (price != null && totalOCR != null && totalOCR > 0) {
    const g = +(totalOCR / price).toFixed(3);
    if (g > 2 && g <= 50) {
      return {
        name: 'Fuel (Regular)',
        priceTotal: +totalOCR.toFixed(2),
        qtyValue: g,
        qtyUnit: 'gal',
        unitPrice: `${(+price).toFixed(3)} $/gal`,
        date: dateISO
      };
    }
  }

  return null; // 交给 LLM 兜底
}

export default async function handler(req, res) {
  // ——CORS——
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = typeof req.body === 'object' && req.body ? req.body : await readJSON(req);
    const { receiptText } = body || {};
    if (!receiptText) return res.status(400).json({ error: 'Missing receipt text' });

    // 1) 先用规则解析 Costco 油票
    const fuel = parseFuelCostco(receiptText);
    if (fuel) {
      return res.status(200).json({ items: [fuel, { name: 'Total', priceTotal: fuel.priceTotal, qtyValue: null, qtyUnit: '', unitPrice: null, date: fuel.date }] });
    }

    // 2) 回退到 LLM（通用超市票据）
    if (!process.env.OPENAI_API_KEY) {
      // 没 key 时直接兜底返回未解析
      const today = new Date().toISOString().slice(0,10);
      return res.status(200).json({ items: [{ name:'Unparsed Receipt', priceTotal:null, qtyValue:null, qtyUnit:'', unitPrice:null, date: today }] });
    }

    const rsp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Extract line items from the receipt. Return ONLY a JSON object: {"items":[{name, priceTotal, qtyValue, qtyUnit}]}. Numbers as numbers. No extra text.'
        },
        { role: 'user', content: receiptText }
      ]
    });

    let obj = {};
    try { obj = JSON.parse(rsp.choices?.[0]?.message?.content || '{}'); } catch { obj = {}; }
    let items = Array.isArray(obj) ? obj : Array.isArray(obj.items) ? obj.items : [];
    const today = new Date().toISOString().slice(0,10);

    items = items.map(it => {
      const name = (it.name || it.item || it.title || 'Item').toString().slice(0,120);
      const priceTotal = toNum(it.priceTotal ?? it.total ?? it.amount ?? it.price);
      const qtyValue   = toNum(it.qtyValue   ?? it.quantity ?? it.qty);
      const qtyUnit    = normUnit(it.qtyUnit ?? it.unit);
      const up = calcUnitPrice(priceTotal, qtyValue, qtyUnit);
      return { name, priceTotal, qtyValue, qtyUnit, unitPrice: up, date: today };
    });

    if (!items.length) {
      items = [{ name:'Unparsed Receipt', priceTotal:null, qtyValue:null, qtyUnit:'', unitPrice:null, date: today }];
    }
    return res.status(200).json({ items });
  } catch (err) {
    console.error('Parse error:', err?.response?.data || err);
    return res.status(500).json({ error: 'Failed to parse receipt', detail: err?.message || String(err) });
  }
}
