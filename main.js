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
      statusEl.textContent = `${m.status} ${(m.progress * 100 | 0)}%`;
    }
  });
  await worker.loadLanguage(lang);
  await worker.initialize(lang);
  // ★ OCR 参数优化：统一文本块 + 字符白名单，减少脏字符 ★
  await worker.setParameters({
    tessedit_pageseg_mode: '6', // 单块文本
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.$:/#-() "
    // tessedit_char_blacklist: "§£€¥•●◆○◇△▶◀[]{}" // 可选
  });
  return worker;
}

// --- 轻量图像预处理：灰度 + 二值化 + 放大（关键新增） ---
async function preprocessForOCR(fileOrDataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const scale = 2; // 放大 2 倍，必要时可调 1.5~3
      const w = img.width * scale;
      const h = img.height * scale;

      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');

      // 先把原图绘制上去
      ctx.drawImage(img, 0, 0, w, h);

      // 灰度 + 简单阈值（二值化）
      const imgData = ctx.getImageData(0, 0, w, h);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const gray = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
        // 阈值可调 160~210，越高背景越白
        const v = gray > 190 ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(imgData, 0, 0);

      // 输出 dataURL 给 tesseract 识别
      resolve(c.toDataURL('image/png'));
    };

    img.src = (typeof fileOrDataUrl === 'string')
      ? fileOrDataUrl
      : URL.createObjectURL(fileOrDataUrl);
  });
}

// --- 监听上传 ---
input.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  progressEl.value = 0;
  progressEl.style.display = 'block';
  statusEl.textContent = 'Loading OCR…';

  try {
    // ★ 先做预处理，再 OCR（核心改动） ★
    const pre = await preprocessForOCR(file);
    const w = await ensureWorker('eng');
    const { data: { text } } = await w.recognize(pre);

    progressEl.style.display = 'none';
    statusEl.textContent = 'OCR done.';
    ocrRawEl.textContent = text;

    statusEl.textContent = 'Sending to AI for parsing...';

    // 调用 Vercel 后端解析
    const parsedItems = await parseReceiptTextWithAI(text);

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

// --- 调 Vercel 后端 ---
async function parseReceiptTextWithAI(text) {
  // 若前端也部署在 Vercel 同一域名，走同域；否则回退到你的生产 API 域名
  const API_BASE = location.host.endsWith('vercel.app')
    ? location.origin
    : 'https://project-6nho1.vercel.app';
  const serverlessUrl = `${API_BASE}/api/parse-receipt`;

  try {
    const response = await fetch(serverlessUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptText: text }),
    });

    if (!response.ok) {
      const msg = await response.text().catch(() => '');
      throw new Error(`API ${response.status} ${response.statusText} :: ${msg}`);
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.items)) {
      throw new Error('API 返回格式不对，缺少 items 数组');
    }
    return data.items;
  } catch (error) {
    console.error('Error parsing with AI:', error);
    statusEl.textContent = `Server error: ${error.message}`;
    return [];
  }
}

// 规格统一 & 单位价（权衡：简化实现，够用即可）
function computeUnitPrice(total, qty, unit) {
  if (!qty || !unit) return null;
  const u = unit.toLowerCase();
  let baseQty = qty, baseUnit = u;

  if (u === 'lb') { baseQty = qty * 16; baseUnit = 'oz'; }
  else if (u === 'kg') { baseQty = qty * 1000; baseUnit = 'g'; }
  else if (u === 'ml') { baseQty = qty / 1000; baseUnit = 'l'; }
  else if (u === 'gal') { baseQty = qty * 3.785; baseUnit = 'l'; }

  if (!baseQty || baseQty <= 0) return null;
  const price = +(total / baseQty).toFixed(4);
  return `${price} $/${baseUnit}`;
}

function normalizeName(s) {
  return s
    .replace(/\b(?:ea|pk|ct)\b/ig, '')
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
      <td>${it.priceTotal?.toFixed?.(2) ?? (typeof it.priceTotal === 'number' ? it.priceTotal.toFixed(2) : '')}</td>
      <td>${it.qtyValue ?? ''}</td>
      <td>${it.qtyUnit ?? ''}</td>
      <td>${it.unitPrice ?? ''}</td>
      <td>${it.date ?? ''}</td>
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

  const pts = rows.map(r => {
    const up = r.unitPrice ? parseFloat(r.unitPrice) : null;
    return { date: r.date, y: up ?? r.priceTotal };
  }).sort((a, b) => a.date.localeCompare(b.date));

  const labels = pts.map(p => p.date);
  const data = pts.map(p => p.y);

  const ctx = chartCanvas.getContext('2d');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{ label: `${name} (unit or total)`, data, fill: false, tension: 0.25 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: { y: { beginAtZero: false } }
    }
  });
}

