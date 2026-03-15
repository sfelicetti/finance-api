// Riferimenti UI
const API_BASE_INPUT = document.getElementById('apiBase');
const SYMBOLS_INPUT = document.getElementById('symbols');
const FROM_INPUT = document.getElementById('from');
const TO_INPUT = document.getElementById('to');
const OSC_PCT_INPUT = document.getElementById('oscPct');
const META_MODE_SELECT = document.getElementById('metaMode');
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
const DOWNLOAD_BTN = document.getElementById('downloadBtn');
let priceChart = null;

// Defaults (persistenza)
API_BASE_INPUT.value = localStorage.getItem('apiBase') || 'https://finance-api-xwk1.onrender.com';
SYMBOLS_INPUT.value  = localStorage.getItem('symbols') || 'AAPL, MSFT, NVDA, GOOGL';
OSC_PCT_INPUT.value  = localStorage.getItem('oscPct')   || '30';
META_MODE_SELECT.value = localStorage.getItem('metaMode') || 'fast';

// default range: ultimi 30 giorni
(function initDates(){
  const today = new Date();
  const dTo = new Date(localStorage.getItem('to') || today);
  const dFrom = new Date(localStorage.getItem('from') || (new Date(today.getTime()-29*24*60*60*1000)));
  FROM_INPUT.value = dFrom.toISOString().slice(0,10);
  TO_INPUT.value = dTo.toISOString().slice(0,10);
})();

// Persist metaMode on change
META_MODE_SELECT.addEventListener('change', () => {
  localStorage.setItem('metaMode', META_MODE_SELECT.value);
});

// Ripristina stato checkbox da localStorage + sincronizza label bottone
FETCH_FROM_FILE.checked = localStorage.getItem('fetchFromFile') === 'true';
function syncFetchBtnLabel() {
  FETCH_BTN.textContent = FETCH_FROM_FILE.checked ? 'Fetch (da file)' : 'Fetch';
}
syncFetchBtnLabel();
FETCH_FROM_FILE.addEventListener('change', () => {
  localStorage.setItem('fetchFromFile', String(FETCH_FROM_FILE.checked));
  syncFetchBtnLabel();
});

// Enter nella textbox simboli => avvia fetch
SYMBOLS_INPUT.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    FETCH_BTN.click();
  }
});

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

function parseSymbols(text){
  // Supporta separatori: virgola, punto e virgola, spazi, tab, newline
  return String(text)
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toUpperCase());
}

// Quando clicchi su Fetch: se attivo "da file", apre il file picker e poi esegue
FETCH_BTN.addEventListener('click', async (e) => {
  e.preventDefault();

  if (FETCH_FROM_FILE.checked) {
    try {
      const text = await pickSymbolsFromFile();
      if (typeof text === 'string') {
        const parsed = Array.from(new Set(parseSymbols(text)));
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

TBL.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
    renderTable(currentData);
    // Aggiorna stato colonne e freccia asc/desc
    TBL.querySelectorAll('th.sortable').forEach(el => {
      el.classList.remove('active');
      const span = el.querySelector('.arrow');
      if (span) span.textContent = '↕';
    });
    th.classList.add('active');
    const arrow = th.querySelector('.arrow');
    if (arrow) arrow.textContent = (sortDir === 1) ? '↑' : '↓';
  });
});

CHART_SYMBOL.addEventListener('change', () => {
  if (CHART_SYMBOL.value) updateChartFor(CHART_SYMBOL.value);
});

// Download CSV del grafico corrente
DOWNLOAD_BTN.addEventListener('click', () => {
  downloadCurrentChartData();
});

async function fetchHistory(){
  ERROR_BOX.textContent = '';
  setStatus('load', 'Richiesta in corso…');

  const base = API_BASE_INPUT.value.trim().replace(/\/+$/, '');
  const symbols = Array.from(new Set(parseSymbols(SYMBOLS_INPUT.value)));
  const from = FROM_INPUT.value; const to = TO_INPUT.value;
  const meta = META_MODE_SELECT.value || 'fast';

  if (!base) { setStatus('err', 'API base mancante'); return; }
  if (!symbols.length) { setStatus('err', 'Nessun simbolo'); return; }
  if (!from) { setStatus('err', 'Data From mancante'); return; }
  if (to && new Date(from) > new Date(to)) {
    setStatus('err', 'Intervallo date non valido (From > To)');
    return;
  }

  // Persisti preferenze
  localStorage.setItem('apiBase', base);
  localStorage.setItem('symbols', SYMBOLS_INPUT.value);
  localStorage.setItem('from', from);
  if (to) localStorage.setItem('to', to);
  localStorage.setItem('oscPct', OSC_PCT_INPUT.value);
  localStorage.setItem('fetchFromFile', String(FETCH_FROM_FILE.checked));
  localStorage.setItem('metaMode', meta);

  const params = new URLSearchParams({ symbols: symbols.join(','), from });
  if (to) params.append('to', to);
  params.append('meta', meta); // <<< FAST | FULL

  const url = `${base}/api/history?${params.toString()}`;

  // helper per una singola chiamata con timeout
  const callOnce = async (timeoutMs) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  };

  try {
    // ping "anti-cold-start"
    try {
      const ping = await fetch(base + '/', { cache: 'no-store' });
      if (!ping.ok) console.warn('Ping non OK', ping.status);
    } catch(e) {
      console.warn('Ping fallito (API non raggiungibile?)', e);
    }

    let data;
    try {
      // primo tentativo: 30s
      data = await callOnce(30000);
    } catch (err) {
      // se è un AbortError (timeout), effettua UN SOLO retry breve (10s)
      if (err?.name === 'AbortError') {
        setStatus('load', 'Lento… ritento (1/1)');
        data = await callOnce(10000);
      } else {
        throw err;
      }
    }

    if (!Array.isArray(data)) throw new Error('Formato inatteso della risposta');

    // Calcola trend lato client secondo il nuovo algoritmo (soglia % sul valore attuale)
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

    if (err?.name === 'AbortError') {
      setStatus('err', 'Timeout');
      ERROR_BOX.textContent = 'Timeout: l’API non ha risposto in tempo. Verifica API Base o riprova tra poco.';
    } else if (/Failed to fetch|NetworkError/i.test(String(err))) {
      setStatus('err', 'Errore rete');
      ERROR_BOX.textContent = 'Errore di rete/CORS. Se stai aprendo la pagina come file:// lancia un server locale (es. http://localhost:8080).';
    } else {
      setStatus('err', 'Errore rete/API');
      ERROR_BOX.textContent = String(err.message || err);
    }
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
    const displayName = r.name || r.shortName || r.symbol || '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="sym">${r.symbol || '—'}</td>
      <td class="name" title="${String(displayName).replace(/"/g, '&quot;')}">${displayName}</td>
      <td class="mono">${fmtNum(r.current)}</td>
      <td class="mono">${fmtNum(r.min)}</td>
      <td class="mono">${fmtNum(r.max)}</td>
      <td class="mono">${r.trend || '—'}</td>
      <td class="mono ${clsPct}">${fmtPct(r.potentialPct)}</td>
      <td>${r.currency || '—'}</td>
    `;

    // Se il server ha fornito un errore per questo simbolo, segnalo nella riga
    if (r.error) {
      tr.classList.add('row-error');
      tr.title = `Errore: ${r.error}`;
    }

    tr.addEventListener('click', ()=>{
      if (r?.symbol) {
        TBODY.querySelectorAll('tr.selected').forEach(x => x.classList.remove('selected'));
        tr.classList.add('selected');
        CHART_SYMBOL.value = r.symbol;
        updateChartFor(r.symbol);
      }
    });
    TBODY.appendChild(tr);
  }
}

/**
 * Trend con soglia calcolata come % del valore attuale (valoreTo).
 * - Usa adjClose (fallback: close).
 * - Soglia = |valoreTo| * (pct/100).
 * - Oscillante se:
 *   A) iFrom < iMin < iMax < iTo e
 *      (from-min > S) e (max-min > S) e (max-to > S)
 *   B) iFrom < iMax < iMin < iTo e
 *      (max-from > S) e (max-min > S) e (to-min > S)
 * - Altrimenti: Crescente / Calante / Stallo (tolleranza).
 */
function computeTrendOscillation(series, pct) {
  // Estrae i close aggiustati (o close) mantenendo allineamento con la serie
  const closes = series.map(r => {
    const v = Number.isFinite(r.adjClose) ? r.adjClose : r.close;
    return Number.isFinite(v) ? v : null;
  });

  // Trova primo e ultimo valore valido (from / to)
  const iFrom = closes.findIndex(Number.isFinite);
  let iTo = -1;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i])) { iTo = i; break; }
  }

  if (iFrom < 0 || iTo < 0 || iFrom === iTo) {
    // Dati insufficienti
    return 'Oscillante';
  }

  const valoreFrom = closes[iFrom];
  const valoreTo   = closes[iTo];

  // Trova min/max (valore e indice) sui valori validi
  let valoreMin = Infinity, valoreMax = -Infinity;
  let iMin = -1, iMax = -1;
  for (let i = 0; i < closes.length; i++) {
    const v = closes[i];
    if (!Number.isFinite(v)) continue;
    if (v < valoreMin) { valoreMin = v; iMin = i; }
    if (v > valoreMax) { valoreMax = v; iMax = i; }
  }
  if (!Number.isFinite(valoreMin) || !Number.isFinite(valoreMax)) {
    return 'Oscillante';
  }

  // Soglia in funzione del valore attuale (valoreTo)
  const soglia = Math.abs(valoreTo) * (Math.max(0, Number(pct) || 0) / 100);

  // Ordine temporale e condizioni oscillazione
  const condA = (iFrom < iMin && iMin < iMax && iMax < iTo) &&
                ((valoreFrom - valoreMin) > soglia) &&
                ((valoreMax - valoreMin) > soglia) &&
                ((valoreMax - valoreTo)   > soglia);

  const condB = (iFrom < iMax && iMax < iMin && iMin < iTo) &&
                ((valoreMax - valoreFrom) > soglia) &&
                ((valoreMax - valoreMin)  > soglia) &&
                ((valoreTo  - valoreMin)  > soglia);

  if (condA || condB) return 'Oscillante';

  // Confronto finale (Crescente/Calante/Stallo) con piccola tolleranza
  const scale = Math.max(1, Math.abs(valoreMax), Math.abs(valoreFrom), Math.abs(valoreTo));
  const eps = scale * 1e-6;

  if (valoreTo > valoreFrom + eps) return 'Crescente';
  if (valoreTo < valoreFrom - eps) return 'Calante';
  return 'Stallo';
}

function populateChartControls(data){
  CHART_SYMBOL.innerHTML = '';
  const available = (data || []).filter(r => Array.isArray(r.series) && r.series.length);

  if (!available.length){
    CHART_SYMBOL.disabled = true;
    CHART_SYMBOL.innerHTML = '<option value="">(nessun dato)</option>';
    DOWNLOAD_BTN.disabled = true;
    drawEmptyChart();
    return;
  }

  for (const r of available){
    const opt = document.createElement('option');
    opt.value = r.symbol;
    opt.textContent = `${r.symbol} — ${r.name || r.shortName || ''}`;
    CHART_SYMBOL.appendChild(opt);
  }
  CHART_SYMBOL.disabled = false;
  DOWNLOAD_BTN.disabled = false;

  const preferred = (SYMBOLS_INPUT.value.split(',')[0] || '').trim().toUpperCase();
  if (preferred && available.some(x => x.symbol === preferred)) CHART_SYMBOL.value = preferred;

  updateChartFor(CHART_SYMBOL.value || available[0].symbol);
}

/////////////////////////////////
function updateChartFor(symbol) {
  const rec = (currentData || []).find(r => r.symbol === symbol);
  if (!rec || !Array.isArray(rec.series) || !rec.series.length) {
    drawEmptyChart();
    DOWNLOAD_BTN.disabled = true;
    return;
  }
  DOWNLOAD_BTN.disabled = false;

  // --- Estrazione date e serie ---
  const dates  = rec.series.map(s => new Date(s.date));
  const labels = dates.map(d => d.toLocaleDateString('it-IT'));

  // Mantieni le lunghezze uguali alle labels: valori non validi -> null
  const closes = rec.series.map(s => {
    const v = Number.isFinite(s.adjClose) ? s.adjClose : s.close;
    return Number.isFinite(v) ? v : null;
  });

  const lows  = rec.series.map(s => Number.isFinite(s.low)  ? s.low  : null);
  const highs = rec.series.map(s => Number.isFinite(s.high) ? s.high : null);

  // Min/max reali (ignorando i null)
  const finiteLows   = lows.filter(Number.isFinite);
  const finiteHighs  = highs.filter(Number.isFinite);
  const finiteCloses = closes.filter(Number.isFinite);

  const realMin = finiteLows.length  ? Math.min(...finiteLows)  : Math.min(...finiteCloses);
  const realMax = finiteHighs.length ? Math.max(...finiteHighs) : Math.max(...finiteCloses);
  const cur     = Number.isFinite(rec.current) ? rec.current : (finiteCloses.at(-1) ?? null);

  // Indici min/max (tolleranti)
  const idxMin = rec.series.findIndex(s => Number.isFinite(s.low)  && Math.abs(s.low  - realMin) < 1e-6);
  const idxMax = rec.series.findIndex(s => Number.isFinite(s.high) && Math.abs(s.high - realMax) < 1e-6);

  const minIndex = (idxMin >= 0) ? idxMin : closes.indexOf(realMin);
  const maxIndex = (idxMax >= 0) ? idxMax : closes.indexOf(realMax);

  // --- Margini Y del 5% ---
  const yMin = realMin * 0.95;
  const yMax = realMax * 1.05;

  // Linee orizzontali (stesse lunghezze delle labels)
  const fillLine = v => Array(labels.length).fill(v);
  const minLine  = fillLine(realMin);
  const maxLine  = fillLine(realMax);
  const curLine  = fillLine(cur);

  // Marker min/max
  const sparsePoint = (len, idx, value) =>
    Array.from({length: len}, (_, i) => (i === idx ? value : null));

  const minMarkerData = sparsePoint(labels.length, minIndex, realMin);
  const maxMarkerData = sparsePoint(labels.length, maxIndex, realMax);

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
      yAxisID: 'y',
      spanGaps: true // consente di "saltare" i null
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

    // Marker min/max
    {
      label: 'Min',
      data: minMarkerData,
      borderColor: '#16a34a',
      backgroundColor: '#16a34a',
      pointRadius: 7,
      pointHoverRadius: 9,
      showLine: false,
      yAxisID: 'y'
    },
    {
      label: 'Max',
      data: maxMarkerData,
      borderColor: '#dc2626',
      backgroundColor: '#dc2626',
      pointRadius: 7,
      pointHoverRadius: 9,
      showLine: false,
      yAxisID: 'y'
    }
  ];

  // --- Asse X intelligente e ottimizzato ---
  const xTicksRotation =
    labels.length > 60 ? 75 :
    labels.length > 40 ? 60 :
    labels.length > 20 ? 40 : 25;

  const step =
    labels.length > 80 ? 12 :
    labels.length > 60 ? 10 :
    labels.length > 40 ? 8  :
    labels.length > 20 ? 5  : 3;

  const options = {
    responsive: true,
    maintainAspectRatio: false,

    layout: { padding: { left: 20, right: 20, top: 10, bottom: 10 } },

    scales: {
      y: {
        beginAtZero: false,
        min: yMin,
        max: yMax,
        ticks: {
          color: '#cbd5e1',
          callback: v => fmtNum(v)
        },
        grid: { color: 'rgba(255,255,255,0.08)', lineWidth: 1 }
      },

      x: {
        offset: false,
        bounds: 'ticks',
        grid: { color: 'rgba(255,255,255,0.06)', lineWidth: 1 },

        ticks: {
          color: '#d1d5db',
          font: { size: 11, weight: '500', family: 'system-ui' },
          padding: 10,

          maxRotation: xTicksRotation,
          minRotation: xTicksRotation,

          callback: (val, index) => {
            const d = dates[index];
            const formatted = d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });

            if (index === 0 || index === labels.length - 1) return formatted;
            if (index % step === 0) return formatted;
            return '';
          }
        }
      }
    },

    plugins: {
      legend: {
        labels: { color: '#e5e7eb', font: { size: 11 } }
      },
      title: {
        display: true,
        text: (rec.name || rec.shortName || rec.symbol),
        color: '#e5e7eb',
        padding: { top: 4, bottom: 4 },
        font: { size: 14, weight: '600' }
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
    priceChart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, title: { display: true, text: 'Nessun dato', color: '#e5e7eb' } },
        scales: { x: { display: false }, y: { display: false } }
      }
    });
  } else {
    priceChart.data = { labels: [], datasets: [] };
    priceChart.options.plugins = priceChart.options.plugins || {};
    priceChart.options.plugins.title = { display: true, text: 'Nessun dato', color: '#e5e7eb' };
    priceChart.update();
  }
  DOWNLOAD_BTN.disabled = true;
}

/** Scarica i dati (CSV) del simbolo selezionato nel grafico */
async function downloadCurrentChartData() {
  const symbol = CHART_SYMBOL.value;
  if (!symbol) {
    ERROR_BOX.textContent = 'Nessun simbolo selezionato per il download.';
    return;
  }
  const rec = (currentData || []).find(r => r.symbol === symbol);
  if (!rec || !Array.isArray(rec.series) || !rec.series.length) {
    ERROR_BOX.textContent = 'Nessun dato disponibile per il simbolo selezionato.';
    return;
  }

  const name = rec.name || rec.shortName || rec.symbol || '';
  const currency = rec.currency || '';
  const from = FROM_INPUT.value || 'start';
  const to = TO_INPUT.value || 'today';

  // Intestazione richiesta: "SIMBOLO - NOME - <VALUTA>"
  const headerLine = `${symbol} - ${name} - <${currency}>`;
  // BOM UTF-8 per Excel + intestazioni
  const lines = ['\uFEFF' + headerLine, 'Data;Quotazione'];

  for (const s of rec.series) {
    const d = new Date(s.date);
    const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
    const raw = Number.isFinite(s.adjClose) ? s.adjClose : s.close;
    const priceStr = Number.isFinite(raw)
      ? Number(raw).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';
    lines.push(`${dateStr};${priceStr}`);
  }

  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });

  const safeSymbol = String(symbol).replace(/[\\/:*?"<>|]+/g, '_');
  const safeFrom = String(from || '').replace(/[\\/:*?"<>|]+/g, '-');
  const safeTo = String(to || '').replace(/[\\/:*?"<>|]+/g, '-');
  const defaultFileName = `${safeSymbol}_${safeFrom}_${safeTo}.csv`;

  // Se il browser supporta la File System Access API, consenti di scegliere cartella e nome file
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultFileName,
        types: [
          {
            description: 'CSV (valori separati da punto e virgola)',
            accept: { 'text/csv': ['.csv'] }
          }
        ]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return; // tutto ok
    } catch (err) {
      // Se l'utente annulla il salvataggio, non facciamo nulla; in altri errori, fallback
      if (err && err.name === 'AbortError') return;
      console.warn('showSaveFilePicker fallito, faccio fallback al download automatico.', err);
    }
  }

  // Fallback: download automatico nella cartella predefinita del browser
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = defaultFileName;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}

