// Riferimenti UI
const API_BASE_INPUT = document.getElementById('apiBase');
const SYMBOLS_INPUT = document.getElementById('symbols');
const FROM_INPUT = document.getElementById('from');
const TO_INPUT = document.getElementById('to');
const OSC_PCT_INPUT = document.getElementById('oscPct');
const FETCH_BTN = document.getElementById('fetchBtn');
const FILE_INPUT = document.getElementById('symbolsFile');

const STATUS_DOT = document.getElementById('statusDot');
const STATUS_TEXT = document.getElementById('statusText');
const LAST_UPDATE = document.getElementById('lastUpdate');
const ERROR_BOX = document.getElementById('errorBox');

const TBL = document.getElementById('tbl');
const TBODY = document.getElementById('tbody');
const FETCH_FROM_FILE = document.getElementById('fetchFromFile');
// --- Chart controls ---
const CHART_SYMBOL = document.getElementById('chartSymbol');
const CHART_CANVAS = document.getElementById('chartCanvas');
let priceChart = null;

// Defaults
API_BASE_INPUT.value = localStorage.getItem('apiBase') || 'https://finance-api-xwk1.onrender.com';
SYMBOLS_INPUT.value  = localStorage.getItem('symbols') || 'AAPL, MSFT, NVDA, GOOGL';
OSC_PCT_INPUT.value = localStorage.getItem('oscPct') || '30';

// default range: ultimi 30 giorni
(function initDates(){
  const today = new Date();
  const dTo = new Date(localStorage.getItem('to') || today);
  const dFrom = new Date(localStorage.getItem('from') || (new Date(today.getTime()-29*24*60*60*1000)));
  FROM_INPUT.value = dFrom.toISOString().slice(0,10);
  TO_INPUT.value = dTo.toISOString().slice(0,10);
})();

let sortKey = 'symbol';
let sortDir = 1; // 1 asc, -1 desc
let currentData = [];

function setStatus(state, text) {
  STATUS_DOT.classList.remove('ok', 'err', 'load');
  if (state === 'ok') STATUS_DOT.classList.add('ok');
  else if (state === 'err') STATUS_DOT.classList.add('err');
  else STATUS_DOT.classList.add('load');
  STATUS_TEXT.textContent = text;
}

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + fmtNum(n, 2) + '%';
}

// Quando clicchi su Fetch: apri il file picker; se selezioni un file, carica simboli e poi procedi con la fetch

FETCH_BTN.addEventListener('click', async (e) => {
  e.preventDefault();

  if (FETCH_FROM_FILE.checked) {
    try {
      const text = await pickSymbolsFromFile();
      if (typeof text === 'string') {
        const parsed = parseSymbols(text);
        if (parsed.length) {
          SYMBOLS_INPUT.value = parsed.join(', ');
          localStorage.setItem('symbols', SYMBOLS_INPUT.value);
        }
      }
    } catch (err) {
      console.warn('File symbols: lettura annullata o fallita', err);
    }
  }

  // In ogni caso esegui la fetch con il contenuto del campo
  fetchHistory();
});


function pickSymbolsFromFile(){
  return new Promise((resolve, reject) => {
    // reset del value per permettere selezioni ripetute dello stesso file
    FILE_INPUT.value = '';
    const onChange = async () => {
      FILE_INPUT.removeEventListener('change', onChange);
      const file = FILE_INPUT.files && FILE_INPUT.files[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        resolve(text);
      } catch (e) {
        reject(e);
      }
    };
    FILE_INPUT.addEventListener('change', onChange, { once: true });
    FILE_INPUT.click();
  });
}

function parseSymbols(text){
  // Supporta separatori: virgola, punto e virgola, spazi, tab, newline
  return String(text)
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toUpperCase());
}

TBL.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
    renderTable(currentData);
    TBL.querySelectorAll('th.sortable').forEach(el => el.classList.remove('active'));
    th.classList.add('active');
  });
});

CHART_SYMBOL.addEventListener('change', () => {
  if (CHART_SYMBOL.value) updateChartFor(CHART_SYMBOL.value);
});

async function fetchHistory(){
  ERROR_BOX.textContent = '';
  setStatus('load', 'Richiesta in corso…');

  const base = API_BASE_INPUT.value.trim().replace(/\/+$/, '');
  const symbols = SYMBOLS_INPUT.value.split(',').map(s => s.trim()).filter(Boolean);
  const from = FROM_INPUT.value; const to = TO_INPUT.value;

  if (!base) { setStatus('err', 'API base mancante'); return; }
  if (!symbols.length) { setStatus('err', 'Nessun simbolo'); return; }
  if (!from) { setStatus('err', 'Data From mancante'); return; }

  // Persisti preferenze
  localStorage.setItem('apiBase', base);
  localStorage.setItem('symbols', SYMBOLS_INPUT.value);
  localStorage.setItem('from', from);
  if (to) localStorage.setItem('to', to);
  localStorage.setItem('oscPct', OSC_PCT_INPUT.value);

  const params = new URLSearchParams({ symbols: symbols.join(','), from });
  if (to) params.append('to', to);

  const url = `${base}/api/history?${params.toString()}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Formato inatteso della risposta');

    // Calcola trend lato client secondo la soglia e la regola concordata
    const oscPct = parseFloat(OSC_PCT_INPUT.value) || 30;
    for (const r of data) {
      if (Array.isArray(r.series) && r.series.length >= 2) {
        r.trend = computeTrendOscillation(r.series, oscPct);
      } else {
        r.trend = '—';
      }
    }

    currentData = data;
    renderTable(currentData);
    populateChartControls(currentData);

    setStatus('ok', `OK (${data.length} items)`);
    LAST_UPDATE.textContent = `Ultimo aggiornamento: ${new Date().toLocaleTimeString('it-IT')}`;
  } catch (err) {
    console.error(err);
    setStatus('err', 'Errore rete/API');
    ERROR_BOX.textContent = String(err.message || err);
  }
}

function renderTable(rows){
  const sorted = [...rows].sort((a,b)=>{
    const va = a[sortKey], vb = b[sortKey];
    if (va == null && vb == null) return 0;
    if (va == null) return 1 * sortDir;
    if (vb == null) return -1 * sortDir;
    if (typeof va === 'string' || typeof vb === 'string') return va.toString().localeCompare(vb.toString(),'it')*sortDir;
    return (va - vb) * sortDir;
  });

  TBODY.innerHTML = '';
  if (!sorted.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="center" colspan="8">Nessun dato</td>`;
    TBODY.appendChild(tr);
    return;
  }

  for (const r of sorted){
    const clsPct = (r.potentialPct ?? 0) >= 0 ? 'pos' : 'neg';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="sym">${r.symbol || '—'}</td>
      <td class="name" title="${r.shortName || ''}">${r.shortName || '—'}</td>
      <td class="mono">${fmtNum(r.current)}</td>
      <td class="mono">${fmtNum(r.min)}</td>
      <td class="mono">${fmtNum(r.max)}</td>
      <td class="mono">${r.trend || '—'}</td>
      <td class="mono ${clsPct}">${fmtPct(r.potentialPct)}</td>
      <td>${r.currency || '—'}</td>
    `;
    tr.addEventListener('click', ()=>{
      if (r?.symbol) {
        CHART_SYMBOL.value = r.symbol;
        updateChartFor(r.symbol);
      }
    });
    TBODY.appendChild(tr);
  }
}

function computeTrendOscillation(series, pct, eps = 0.01) {
  const closes = series
    .map(r => (Number.isFinite(r.adjClose) ? r.adjClose : r.close))
    .filter(Number.isFinite);

  if (closes.length < 2) return 'Oscillante';

  const threshold = Math.max(0, Number(pct) || 0) / 100;

  let peak = closes[0];
  let trough = closes[0];
  for (let i = 1; i < closes.length; i++) {
    const p = closes[i];

    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd >= threshold) return 'Oscillante';

    if (p < trough) trough = p;
    const rise = (p - trough) / trough;
    if (rise >= threshold) return 'Oscillante';
  }

  const first = closes[0], last = closes[closes.length - 1];
  if (last > first * (1 + eps)) return 'Crescente';
  if (last < first * (1 - eps)) return 'Calante';
  return 'Oscillante';
}

function populateChartControls(data){
  CHART_SYMBOL.innerHTML = '';
  const available = (data || []).filter(r => Array.isArray(r.series) && r.series.length);

  if (!available.length){
    CHART_SYMBOL.disabled = true;
    CHART_SYMBOL.innerHTML = '<option value="">(nessun dato)</option>';
    drawEmptyChart();
    return;
  }

  for (const r of available){
    const opt = document.createElement('option');
    opt.value = r.symbol;
    opt.textContent = `${r.symbol} — ${r.shortName || ''}`;
    CHART_SYMBOL.appendChild(opt);
  }
  CHART_SYMBOL.disabled = false;

  const preferred = (SYMBOLS_INPUT.value.split(',')[0] || '').trim().toUpperCase();
  if (preferred && available.some(x => x.symbol === preferred)) CHART_SYMBOL.value = preferred;

  updateChartFor(CHART_SYMBOL.value || available[0].symbol);
}

/////////////////////////////////
function updateChartFor(symbol) {
  const rec = (currentData || []).find(r => r.symbol === symbol);
  if (!rec || !Array.isArray(rec.series) || !rec.series.length) {
    drawEmptyChart();
    return;
  }

  // --- Estrazione serie ---
  const labels = rec.series.map(s => new Date(s.date).toLocaleDateString('it-IT'));

  const closes = rec.series.map(s =>
    Number.isFinite(s.adjClose) ? s.adjClose : s.close
  ).filter(Number.isFinite);

  const lows  = rec.series.map(s => s.low).filter(Number.isFinite);
  const highs = rec.series.map(s => s.high).filter(Number.isFinite);

  // Se lows o highs mancano, fallback ai closes
  const realMin = lows.length ? Math.min(...lows) : Math.min(...closes);
  const realMax = highs.length ? Math.max(...highs) : Math.max(...closes);

  const cur = rec.current ?? closes[closes.length-1];

  // Trova indice reale min/max (tollerante)
  const idxMin = rec.series.findIndex(s => Math.abs(s.low - realMin) < 1e-6);
  const idxMax = rec.series.findIndex(s => Math.abs(s.high - realMax) < 1e-6);

  const minIndex = (idxMin >= 0) ? idxMin : closes.indexOf(realMin);
  const maxIndex = (idxMax >= 0) ? idxMax : closes.indexOf(realMax);

  // --- Margini basati sui min/max REALI ---
  const yMin = realMin * 0.95;
  const yMax = realMax * 1.05;

  // Linee orizzontali
  const minLine = Array(labels.length).fill(realMin);
  const maxLine = Array(labels.length).fill(realMax);
  const curLine = Array(labels.length).fill(cur);

  // Marker (singolo punto)
  const minMarkerData = labels.map((_, i) => (i === minIndex ? realMin : null));
  const maxMarkerData = labels.map((_, i) => (i === maxIndex ? realMax : null));

  // --- Datasets ---
  const datasets = [
    {
      label: `Chiusura ${rec.symbol}`,
      data: closes,
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96,165,250,0.12)',
      fill: true,
      pointRadius: 0,
      tension: 0.15,
      borderWidth: 2,
      yAxisID: 'y'
    },
    {
      label: 'Min (range)',
      data: minLine,
      borderColor: '#16a34a',
      borderDash: [6,4],
      pointRadius: 0,
      borderWidth: 1,
      yAxisID: 'y'
    },
    {
      label: 'Max (range)',
      data: maxLine,
      borderColor: '#dc2626',
      borderDash: [6,4],
      pointRadius: 0,
      borderWidth: 1,
      yAxisID: 'y'
    },
    {
      label: 'Prezzo attuale',
      data: curLine,
      borderColor: '#f59e0b',
      borderDash: [4,4],
      pointRadius: 0,
      borderWidth: 1,
      yAxisID: 'y'
    },

    // --- Marker corretti ---
    {
      label: 'Min',
      data: minMarkerData,
      borderColor: '#16a34a',
      backgroundColor: '#16a34a',
      pointRadius: 6,
      pointHoverRadius: 8,
      showLine: false,
      yAxisID: 'y'
    },
    {
      label: 'Max',
      data: maxMarkerData,
      borderColor: '#dc2626',
      backgroundColor: '#dc2626',
      pointRadius: 6,
      pointHoverRadius: 8,
      showLine: false,
      yAxisID: 'y'
    }
  ];

  // --- Opzioni ---
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: {
        min: yMin,
        max: yMax,
        ticks: {
          color: '#9ca3af',
          callback: v => fmtNum(v)
        },
        grid: { color: 'rgba(255,255,255,0.08)' }
      },
      x: {
        ticks: { color: '#9ca3af' },
        grid: { color: 'rgba(255,255,255,0.06)' }
      }
    },
    plugins: {
      legend: { labels: { color: '#e5e7eb' } },
      title: {
        display: true,
        text: rec.shortName || rec.symbol,
        color: '#e5e7eb'
      }
    }
  };

  const data = { labels, datasets };

  if (!priceChart) {
    priceChart = new Chart(CHART_CANVAS.getContext('2d'), { type: 'line', data, options });
  } else {
    priceChart.data = data;
    priceChart.options = options;
    priceChart.update();
  }
}
/////////////////////////////////


function drawEmptyChart(){
  const ctx = CHART_CANVAS.getContext('2d');
  if (!priceChart){
    priceChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: 'Nessun dato', color: '#e5e7eb' } }, scales: { x: { display: false }, y: { display: false } } } });
  } else {
    priceChart.data = { labels: [], datasets: [] };
    priceChart.options.plugins = priceChart.options.plugins || {};
    priceChart.options.plugins.title = { display: true, text: 'Nessun dato', color: '#e5e7eb' };
    priceChart.update();
  }
}
