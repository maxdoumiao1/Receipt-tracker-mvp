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

// ——从 OCR 文本中提日期（优先 “Date: 09/10/25”）——
function extractDateISO(text) {
  const m = text.match(/date[:\s]*([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{2,4})/i)
        || text.match(/\b([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{2,4})\b/);
  if (!m) return new Date().toISOString().slice(0,10);
  const mm = m[1], dd = m[2], yy = m[3].length === 2 ? ('20' + m[3]) : m[3];
  return `${yy}-${mm}-${dd}`;
}

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
function parseFuelCostco(rawText) {
  // 清理不可打印字符，保留换行
  const text = rawText.replace(/[^\x20-\x7E\n]/g, ' ');
  const dateISO = extractDateISO(text);

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 选候选行：包含 pump / gallon / price 的，以及下一两行
  let cand = [];
  const idx = lines.findIndex(l => /pump/i.test(l));
  if (idx >= 0) {
    cand.push(lines[idx]);
    if (lines[idx+1]) cand.push(lines[idx+1]);
    if (lines[idx+2]) cand.push(lines[idx+2]);
  }
  cand.push(...lines.filter(l => /gallon|price/i.test(l)));

  // 再找 Total Sale 行（用于可选核对）
  const totalMatch = text.match(/total\s+sale\s*[: ]*\$?\s*([0-9OIlSsUu.]+)/i);
  const totalOCR = totalMatch ? parseFloat(fixNumericGlyphs(totalMatch[1]).replace(/[^0-9.]/g,'')) : null;

  let gallons = null, price = null;

  for (const ln of cand) {
    const lower = ln.toLowerCase();
    const tokens = parseNumericTokens(ln);
    if (!tokens.length) continue;

    // 如果是以 “<泵号> ...” 开头，且第一个是 <=20 的整数，视为泵号，忽略它
    if (/pump/.test(lower) && tokens.length >= 2) {
      if (!tokens[0].hasDot && tokens[0].val <= 20) {
        tokens.shift(); // 去掉泵号
      }
    }

    // 优先从含 “price” 或 “$” 的 token 中取 price（1~10）
    if (/price/.test(lower) || /\$/.test(ln)) {
      const p = tokens
        .filter(t => t.val >= 1 && t.val <= 10)
        .sort((a,b) => a.val - b.val)[0];
      if (p && price == null) price = p.val;
    }

    // gallons 候选：>2 且通常比单价大；若是 4~5 位整数(如 12401)按/1000 还原
    const gCand = tokens
      .map(t => {
        if (!t.hasDot && t.val >= 1000 && t.val <= 99999 && /gallon|price|pump/i.test(ln))
          return t.val / 1000; // 把 12401 还原为 12.401
        return t.val;
      })
      .filter(v => v > 2);

    if (gCand.length) {
      // 取这一行里最大的作为 gallons（通常是 12.401 > 2.799）
      const g = Math.max(...gCand);
      if (gallons == null) gallons = g;
    }
  }

  // 互检：若 price/gallons 互相不合理（price>10 且 gallons<5），交换一次
  if (price != null && gallons != null && price > 10 && gallons < 5) {
    const t = price; price = gallons; gallons = t;
  }

  // 有 price & gallons → 直接计算总价；否则尝试用 totalOCR 辅助
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
    if (g > 2 && g < 50) {
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

  // 仍然解析不到就返回 null（由上层走 LLM 兜底）
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
