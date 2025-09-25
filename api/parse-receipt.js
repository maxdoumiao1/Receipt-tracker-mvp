// api/parse-receipt.js —— Node 运行时 + CORS + 手动读 body + 字段归一化
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 读取原始 JSON body（非 Next 项目需要自己解析）
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// 小工具：单位与单价
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

export default async function handler(req, res) {
  // —— CORS ——（从 GitHub Pages 或别的域调用也能过）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY missing' });
  }

  try {
    const body = typeof req.body === 'object' && req.body ? req.body : await readJSON(req);
    const { receiptText } = body || {};
    if (!receiptText) return res.status(400).json({ error: 'Missing receipt text' });

    // —— 要求模型固定输出 { "items": [...] } 结构 —— 
    const rsp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',  // 你也可换 gpt-4o
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

    // —— 安全解析 & 兜底 —— 
    let obj = {};
    try { obj = JSON.parse(rsp.choices?.[0]?.message?.content || '{}'); } catch { obj = {}; }
    let items = Array.isArray(obj) ? obj : Array.isArray(obj.items) ? obj.items : [];

    // —— 字段归一化 + 单价 + 日期 —— 
    const today = new Date().toISOString().slice(0, 10);
    items = items.map((it) => {
      const name = (it.name || it.item || it.title || 'Item').toString().slice(0, 120);
      const priceTotal = toNum(it.priceTotal ?? it.total ?? it.amount ?? it.price);
      const qtyValue = toNum(it.qtyValue ?? it.quantity ?? it.qty);
      const qtyUnit  = normUnit(it.qtyUnit ?? it.unit);
      const unitPrice = calcUnitPrice(priceTotal, qtyValue, qtyUnit);
      return { name, priceTotal, qtyValue, qtyUnit, unitPrice, date: today };
    });

    if (!items.length) {
      items = [{ name: 'Unparsed Receipt', priceTotal: null, qtyValue: null, qtyUnit: '', unitPrice: null, date: today }];
    }

    return res.status(200).json({ items });
  } catch (err) {
    console.error('OpenAI/Function Error:', err?.response?.data || err);
    return res.status(500).json({ error: 'Failed to parse receipt', detail: err?.message || String(err) });
  }
}

