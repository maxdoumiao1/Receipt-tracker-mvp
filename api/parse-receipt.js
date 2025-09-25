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

// 仅用于提取 $ 后的金额（强制含小数或明确金额）
function pickPriceFromLine(line) {
  // $ 2.799
  const m1 = line.match(/\$\s*([0-9OIlSsUu]+(?:\.[0-9OIlSsUu]{1,3})?)/);
  if (m1) {
    const cleaned = fixNumericGlyphs(m1[1]).replace(/[^0-9.]/g, '');
    const v = parseFloat(cleaned);
    if (Number.isFinite(v)) return v;
  }
  // Price 2.799
  const m2 = line.match(/price[^0-9]*([0-9OIlSsUu]+(?:\.[0-9OIlSsUu]{1,3}))/i);
  if (m2) {
    const cleaned = fixNumericGlyphs(m2[1]).replace(/[^0-9.]/g, '');
    const v = parseFloat(cleaned);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// 仅在候选窗口内寻找单价（1~10），并排除无关行
function findPriceStrict(lines, idxs) {
  const EXCLUDE = /(total|amount|regular|product|sale|approved|visa|credit|payment|network|tranid|auth)/i;
  const cand = [];
  for (const i of idxs) {
    if (i < 0 || i >= lines.length) continue;
    const ln = lines[i];
    if (EXCLUDE.test(ln)) continue;
    const p = pickPriceFromLine(ln);
    if (p != null && p >= 1 && p <= 10) {
      const hasDot = /\./.test(ln);
      cand.push({ p, hasDot });
    }
  }
  cand.sort((a, b) => (b.hasDot - a.hasDot) || (a.p - b.p));
  return cand.length ? cand[0].p : null;
}

// 只从含 “pump/gallon” 的行抽加仑：优先 3 位小数；必要时 4~5 位整数/1000
function gallonsFromLineStrict(line) {
  const res = [];
  // 12.401 这种
  const r1 = line.match(/\b([0-9]{1,2}\.[0-9]{3})\b/g) || [];
  for (const s of r1) {
    const v = parseFloat(s);
    if (v > 2 && v <= 50) res.push(v);
  }
  // 12401 这种（小数点丢失）
  const r2 = line.match(/\b([0-9]{4,5})\b/g) || [];
  for (const s of r2) {
    const v = parseFloat(s) / 1000;
    if (v > 2 && v <= 50) res.push(v);
  }
  return res;
}

function findGallonsStrict(lines, idxs) {
  const EXCLUDE = /(total|amount|regular|product|sale|approved|visa|credit|payment|network|tranid|auth)/i;
  let pool = [];
  for (const i of idxs) {
    if (i < 0 || i >= lines.length) continue;
    const ln = lines[i];
    if (EXCLUDE.test(ln)) continue;
    if (!/pump|gallon/i.test(ln)) continue; // 只接受这些行
    pool.push(...gallonsFromLineStrict(ln));
  }
  if (!pool.length) return null;
  const with3 = pool.filter(v => /\.\d{3}$/.test(v.toFixed(3)));
  if (with3.length) return Math.max(...with3);
  return Math.max(...pool);
}

// —— Costco/Fuel 专用解析（更新版） ——
function parseFuelCostco(rawText) {
  const text = rawText.replace(/[^\x20-\x7E\n]/g, ' ');
  const dateISO = extractDateISO(text);
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 以 “pump” 行为中心构造候选窗口
  let idx = lines.findIndex(l => /pump/i.test(l));
  if (idx === -1) idx = lines.findIndex(l => /gallon/i.test(l));
  const windowIdxs = new Set();
  for (let k = -2; k <= 4; k++) windowIdxs.add(idx + k);

  // 额外纳入就在窗口内且含 price/$/gallon 的行
  lines.forEach((l, i) => {
    if (i >= idx - 2 && i <= idx + 4 && /\$|price|gallon/i.test(l)) windowIdxs.add(i);
  });
  const idxs = [...windowIdxs].filter(i => i >= 0 && i < lines.length);

  const price = findPriceStrict(lines, idxs);
  const gallons = findGallonsStrict(lines, idxs);

  // Total Sale（用于核对或反推）
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
  return null;
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
