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
function parseFuelCostco(rawText) {
  // 只保留可打印 ASCII，去掉奇异符号，保留换行
  const text = rawText.replace(/[^\x20-\x7E\n]/g, ' ');
  const dateISO = extractDateISO(text);

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  // 找到包含 Pump 的行以及后面两行作为候选
  const idx = lines.findIndex(l => /pump/i.test(l));
  const cand = [];
  if (idx >= 0) {
    cand.push(lines[idx]);
    if (lines[idx+1]) cand.push(lines[idx+1]);
    if (lines[idx+2]) cand.push(lines[idx+2]);
  }
  // 也把包含 Gallons/Price 的行纳入候选
  cand.push(...lines.filter(l => /gallons|price/i.test(l)));

  let gallons = null, price = null;
  // 从候选行抽取数字，按“加仑大、单价小”的经验判断
  for (const ln of cand) {
    const nums = (ln.replace(/[^0-9. ]/g, ' ').match(/[0-9]+(?:\.[0-9]+)?/g) || []).map(parseFloat);
    if (!nums.length) continue;
    const decimals = nums.filter(n => String(n).includes('.'));
    // 可能出现 8(泵号)、12.401(加仑)、2.799(单价)
    if (decimals.length >= 2) {
      // 价格通常 1~10，加仑常在 3~30
      const maybePrice = decimals.find(n => n >= 1 && n <= 10);
      const maybeGall  = decimals.find(n => n > 5 && n <= 50);
      // 备选：取最小作为价、最大作为加仑
      price   = price   ?? maybePrice ?? Math.min(...decimals);
      gallons = gallons ?? maybeGall  ?? Math.max(...decimals);
    }
  }

  // 再尝试从 “Total Sale” 抓总价
  const totalMatch = text.match(/total\s+sale\s*[: ]\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const totalOCR   = totalMatch ? parseFloat(totalMatch[1]) : null;

  // 合理性校验：若 price>10 且 gallons<5，可能互换了，调换过来
  if (price != null && gallons != null && price > 10 && gallons < 5) {
    const t = price; price = gallons; gallons = t;
  }

  if (gallons != null && price != null) {
    const priceTotal = totalOCR != null
      ? +totalOCR.toFixed(2)
      : +(gallons * price).toFixed(2);
    return {
      name: 'Fuel (Regular)',
      priceTotal,
      qtyValue: +(+gallons).toFixed(3),
      qtyUnit: 'gal',
      unitPrice: `${(+price).toFixed(3)} $/gal`,
      date: dateISO
    };
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
