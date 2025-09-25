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

  try {
    // 使用 Tesseract.js 进行 OCR 识别
    const w = await ensureWorker('eng');
    const { data: { text } } = await w.recognize(file);

    progressEl.style.display = 'none';
    statusEl.textContent = 'OCR done.';
    ocrRawEl.textContent = text;
    
    statusEl.textContent = 'Sending to AI for parsing...';

    // 关键步骤：调用 Vercel 上的后端函数进行解析
    const parsedItems = await parseReceiptTextWithAI(text);
    
    // 如果解析成功
    if (parsedItems && parsedItems.length > 0) {
      renderParsed(parsedItems);
      await saveItems(parsedItems);
      await refreshSelectAndChart();
      statusEl.textContent = 'Parsing complete.';
    } else {
      statusEl.textContent = 'No items found. Please try another receipt.';
    }

  } catch (err) {
    console.error(err);
    statusEl.textContent = 'OCR or Parsing failed.';
    progressEl.style.display = 'none';
  }
});

// --- 新的解析函数，调用 Vercel 后端 ---
async function parseReceiptTextWithAI(text) {
  const serverlessUrl = 'https://project-6nho1.vercel.app/api/parse-receipt'; 

  try {
    const response = await fetch(serverlessUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ receiptText: text }),
    });

    if (!response.ok) {
      throw new Error(`Serverless function failed with status: ${response.status}`);
    }

    const data = await response.json();
    return data.items;
  } catch (error) {
    console.error('Error parsing with AI:', error);
    return [];
  }
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

