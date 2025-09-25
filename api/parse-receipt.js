// api/parse-receipt.js  —— 适配你当前前端 & 允许跨域

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// —— 小工具：规范数值/单位 & 计算单价 ——
function toNumber(x) {
  const n = parseFloat(String(x ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function normUnit(u) {
  if (!u) return '';
  u = String(u).toLowerCase().trim();
  if (/gall?on|^gal$/.test(u)) return 'gal';
  if (/^lb?s?$|pound/.test(u)) return 'lb';
  if (/^kgs?$|kilogram/.test(u)) return 'kg';
  if (/^oz$|ounce/.test(u)) return 'oz';
  if (/^l$|liter|litre/.test(u)) return 'l';
  if (/^ml$/.test(u)) return 'ml';
  if (/^ct$|count|pcs?$|pk$/.test(u)) return 'ct';
  return u;
}
function unitPrice(total, qty, unit) {
  if (total == null || qty == null || !qty) return null;
  return `${(total / qty).toFixed(4)} $/${unit || ''}`.trim();
}

export default async function handler(req, res) {
  // —— CORS，允许从 GitHub Pages/其它域访问 ——
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { receiptText } = typeof req.body === 'object' ? req.body : {};
    if (!receiptText) {
      return res.status(400).json({ error: 'Missing receipt text' });
    }

    // —— 调 OpenAI，强制输出 { "items": [...] } 这个结构 ——
    const completion = await openai.chat.completions.create({
      // 你也可用 gpt-4o；这里用 mini 更省
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Extract line items from the receipt text. Return ONLY a JSON object with an "items" array. Each item MUST have: name (string), priceTotal (number or null), qtyValue (number or null), qtyUnit (string or empty). No extra commentary.'
        },
        { role: 'user', content: receiptText }
      ]
    });

    // —— 安全解析 & 兼容意外格式 ——
    let raw = {};
    try {
      raw = JSON.parse(completion.choices[0].message.content || '{}');
    } catch {
      raw = { items: [] };
    }
    let items = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];

    // —— 字段名归一化，补齐 unitPrice/date，防止前端渲染出错 ——
    const today = new Date().toISOString().slice(0, 10);
    items = items.map((it) => {
      const name = (it.name || it.item || it.title || 'Item').toString().slice(0, 120);
      const priceTotal = toNumber(it.priceTotal ?? it.total ?? it.amount ?? it.price);
      const qtyValue = toNumber(it.qtyValue ?? it.quantity ?? it.qty);
      const qtyUnit  = normUnit(it.qtyUnit ?? it.unit);
      const up = unitPrice(priceTotal, qtyValue, qtyUnit);
      return { name, priceTotal, qtyValue, qtyUnit, unitPrice: up, date: today };
    });

    if (!items.length) {
      items = [{ name: 'Unparsed Receipt', priceTotal: null, qtyValue: null, qtyUnit: '', unitPrice: null, date: today }];
    }

    return res.status(200).json({ items });
  } catch (error) {
    console.error('API Error:', error?.response?.data || error);
    return res.status(500).json({ error: 'Failed to parse receipt.' });
  }
}
