// --- PWA: 注册 Service Worker（可离线） ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(console.warn);
}

// --- IndexedDB 简单封装 ---
let db;
const DB_NAME = 'receiptDB';
const STORE = 'items';

const openReq = indexedDB.open(DB_NAME, 1);
openReq.onupgradeneeded = (e) => {
  const _db = e.target.result;
  const os = _db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
  os.createIndex('name', 'name', { unique: false });
  os.createIndex('date', 'date', { unique: false });
};
openReq.onsuccess = (e) => { db = e.target.result; refreshSelectAndChart(); };
openReq.onerror = (e) => console.error('IDB error', e);

// --- DOM refs ---
const input = document.getElementById('receipt-upload');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');
const ocrRawEl = document.getElementById('ocr-raw');
const tableBody = document.querySelector('#parsed-table tbody');
const itemSelect = document.getElementById('item-select');
const chartCanvas = document.getElementById('price-chart');
let chart;

// --- Tesseract worker (更稳的官方流程) ---
let worker;
async function ensureWorker(lang = 'eng') {
  if (worker) return worker;
  worker = await Tesseract.createWorker({
    logger: (m) => {
      if (m.status === 'recognizing text') {
        progressEl.style.display = 'block';
        progressEl.value = m.progress;
      }
      statusEl.textContent = `${m.status} ${(m.progress*100|0)}%`;
    }
  });
  await worker.loadLanguage(lang);
  await worker.initialize(lang);
  return worker;
}

// --- 监听上传 ---
input.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  progressEl.value = 0;
  statusEl.textContent = 'Loading OCR…';

  // 使用英文收据：'eng'；中文小票可改 'chi_sim'（需要配置 langPath，后述）
  const w = await ensureWorker('eng');

  try {
    const { data: { text } } = await w.recognize(file);
    progressEl.style.display = 'none';
    statusEl.textContent = 'OCR done.';
    ocrRawEl.textContent = text;

    const items = parseReceiptText(text);
    renderParsed(items);
    await saveItems(items);
    await refreshSelectAndChart();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'OCR failed.';
    progressEl.style.display = 'none';
  }
});

// --- 行解析（MVP 规则：够用就好） ---
// --- 行解析（优化版） ---
// --- 行解析（增强版） ---
function parseReceiptText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // 增加更严格的排除规则，过滤更多无用行
  const EXCLUDE = /(subtotal|total|tax|change|balance|visa|mastercard|debit|credit|cash|tender|coupon|savings|refund|invoice|member|acct|payment|network|approved|receipts|available|website|visit|search|fuel|customer|phone|no\scum|mode)/i;

  // 价格在行尾：任意名称 …… 12.99 或 $12.99
  const END_PRICE = /^(.*?)[\s$]*([\$]?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*$/;

  // 数量单价模式，如 "x2 @ 3.49" 或 "2 x 3.49"
  const QTY_AT_PRICE = /^(.*?)(?:x|\*)\s?(\d+(?:\.\d{2})?)\s*@\s*\$?(\d+(?:\.\d{2})?)\b.*$/i;

  // 规格抽取
  const UNIT = /(\d+(?:\.\d+)?)\s*(oz|lb|g|kg|ml|l|gal|ct|pk)\b/i;

  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const raw of lines) {
    const line = raw.replace(/\s{2,}/g, ' ').trim();

    // 过滤规则：
    // 1. 如果行太短，直接跳过
    // 2. 如果包含排除关键词，直接跳过
    if (!line || line.length < 5 || EXCLUDE.test(line)) continue;

    let name = '', priceTotal = null, qtyValue = null, qtyUnit = null;
    
    // 尝试匹配 "qty @ price" 模式
    const qa = line.match(QTY_AT_PRICE);
    if (qa) {
      name = qa[1].trim();
      const count = parseFloat(qa[2]);
      const each = parseFloat(qa[3]);
      if (!isNaN(count) && !isNaN(each) && each > 0) {
        priceTotal = +(count * each).toFixed(2);
      }
    }

    // 如果没有匹配到，则用“行尾价格”规则
    if (priceTotal === null) {
      const m = line.match(END_PRICE);
      if (!m) continue;
      name = (m[1] || '').trim();
      const priceStr = (m[2] || '').replace(/[^0-9.]/g, '');
      priceTotal = parseFloat(priceStr);
      if (!name || isNaN(priceTotal) || priceTotal === 0) continue;
      
      // 增加过滤：如果价格太高或太低（不像是商品价），也过滤掉
      if (priceTotal > 5000 || priceTotal < 0.01) continue;
    }

    // 抽取规格
    const u = line.match(UNIT);
    if (u) {
      qtyValue = parseFloat(u[1]);
      qtyUnit = u[2].toLowerCase();
    }
    
    // 再次过滤：如果名字太短，且不是单价模式，很可能是噪音
    if (name.length < 3 && !qa) continue;

    const unitPrice = computeUnitPrice(priceTotal, qtyValue, qtyUnit);

    results.push({
      name: normalizeName(name),
      priceTotal,
      qtyValue: qtyValue ?? null,
      qtyUnit: qtyUnit ?? null,
      unitPrice,
      date: today
    });
  }
  return results;
}

// 规格统一 & 单位价（权衡：简化实现，够用即可）
function computeUnitPrice(total, qty, unit) {
  if (!qty || !unit) return null;
  // 把重量统一到 oz，体积统一到 L，数量用 ct/pk
  const u = unit.toLowerCase();
  let baseQty = qty, baseUnit = u;

  if (u === 'lb') { baseQty = qty * 16; baseUnit = 'oz'; }
  else if (u === 'kg') { baseQty = qty * 1000; baseUnit = 'g'; }
  else if (u === 'ml') { baseQty = qty / 1000; baseUnit = 'l'; }
  else if (u === 'gal') { baseQty = qty * 3.785; baseUnit = 'l'; }
  // ct/pk 直接按件数
  // oz/g/l/ct/pk 原样

  if (!baseQty || baseQty <= 0) return null;
  const price = +(total / baseQty).toFixed(4);
  return `${price} $/${baseUnit}`;
}

function normalizeName(s) {
  // 去除常见的单位和标识符，如 ea, pk, ct
  return s
    .replace(/\b(?:ea|pk|ct)\b/ig, '')
    // 移除不必要的符号和多余空格
    .replace(/[^\w\s\d.-]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// --- 渲染解析结果表 ---
function renderParsed(items) {
  tableBody.innerHTML = '';
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${it.name}</td>
      <td>${it.priceTotal?.toFixed(2) ?? ''}</td>
      <td>${it.qtyValue ?? ''}</td>
      <td>${it.qtyUnit ?? ''}</td>
      <td>${it.unitPrice ?? ''}</td>
      <td>${it.date}</td>
    `;
    tableBody.appendChild(tr);
  }
}

// --- 存到 IndexedDB ---
function saveItems(items) {
  return new Promise((resolve, reject) => {
    if (!db || !items?.length) return resolve();
    const tx = db.transaction([STORE], 'readwrite');
    const os = tx.objectStore(STORE);
    for (const it of items) os.add(it);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

// --- 读库 → 下拉框 & 图表 ---
async function refreshSelectAndChart() {
  const all = await idbGetAll(STORE);
  // 下拉：按名称去重
  const names = [...new Set(all.map(i => i.name))].sort();
  itemSelect.innerHTML = names.map(n => `<option value="${encodeURIComponent(n)}">${n}</option>`).join('');
  itemSelect.onchange = () => renderChartFor(decodeURIComponent(itemSelect.value));
  if (names.length) {
    itemSelect.value = encodeURIComponent(names[0]);
    renderChartFor(names[0]);
  }
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const tx = db.transaction([store], 'readonly');
    const os = tx.objectStore(store);
    const req = os.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e);
  });
}

// --- 画折线图（按所选商品） ---
async function renderChartFor(name) {
  const all = await idbGetAll(STORE);
  const rows = all.filter(r => r.name === name);
  if (!rows.length) return;

  // 用 unitPrice 优先；否则退化到 total price
  // 解析 "$/unit" 里的数值部分
  const pts = rows.map(r => {
    const up = r.unitPrice ? parseFloat(r.unitPrice) : null;
    return { date: r.date, y: up ?? r.priceTotal };
  }).sort((a,b) => a.date.localeCompare(b.date));

  const labels = pts.map(p => p.date);
  const data = pts.map(p => p.y);

  const ctx = chartCanvas.getContext('2d');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{ label: `${name} (unit or total)`, data, fill:false, tension:0.25 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: { y: { beginAtZero: false } }
    }
  });
}

