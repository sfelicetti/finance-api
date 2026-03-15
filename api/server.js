// server.js
// trigger render deploy
import express from "express";
import cors from "cors";
import compression from "compression";
import YahooFinance from "yahoo-finance2";

const app = express();

// CORS: in produzione valuta di restringere l'origine; per sviluppo va bene aperto
app.use(cors({ origin: true }));
app.use(compression());

const yahooFinance = new YahooFinance();

// Helpers
const isYYYYMMDD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { retries = 1, delayMs = 400 } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (retries > 0) {
      await sleep(delayMs);
      return withRetry(fn, { retries: retries - 1, delayMs: Math.round(delayMs * 1.5) });
    }
    throw e;
  }
}

// Promise pool (concurrency limit)
async function mapPool(items, worker, concurrency = 6) {
  const results = new Array(items.length);
  let i = 0;
  let active = 0;
  return new Promise((resolve) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(results);
      while (active < concurrency && i < items.length) {
        const cur = i++;
        active++;
        Promise.resolve()
          .then(() => worker(items[cur], cur))
          .then((res) => { results[cur] = res; })
          .catch((err) => { results[cur] = { __error: String(err?.message || err) }; })
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
}

/**
 * Ricava un "nome descrittivo" per il simbolo:
 * 1) quote.longName / shortName / displayName
 * 2) quoteSummary(price).longName / shortName
 * 3) search(symbol).quotes[0].longname / shortname
 */
async function resolvePrettyName(symbol, quoteObj) {
  // 1) Dati da quote()
  let name =
    quoteObj?.longName ||
    quoteObj?.shortName ||
    quoteObj?.displayName ||
    null;

  if (name) return name;

  // 2) Fallback: quoteSummary(price)
  try {
    const qs = await withRetry(
      () => yahooFinance.quoteSummary(symbol, { modules: ["price"] }),
      { retries: 1, delayMs: 400 }
    );
    const price = qs?.price;
    name = price?.longName || price?.shortName || null;
    if (name) return name;
  } catch (_) {
    // ignora, si passa al fallback successivo
  }

  // 3) Ultimo fallback: search()
  try {
    const sr = await withRetry(
      () => yahooFinance.search(symbol),
      { retries: 1, delayMs: 400 }
    );
    const q0 = Array.isArray(sr?.quotes) ? sr.quotes.find(q => (q?.symbol || q?.symbol === symbol)) || sr.quotes[0] : null;
    name = q0?.longname || q0?.shortname || null;
    if (name) return name;
  } catch (_) {
    // ignora
  }

  // Fallback finale → simbolo
  return symbol;
}

// PING
app.get("/", (req, res) => {
  res.send("OK");
});

// === /api/history ===
// /api/history?symbols=AAPL,MSFT&from=2024-01-01&to=2024-02-01&interval=1d
app.get("/api/history", async (req, res) => {
  try {
    // symbols parsing + dedup + normalizzazione
    const rawSymbols = String(req.query.symbols || "")
      .split(/[,\s;]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const symbols = Array.from(new Set(rawSymbols));

    const period1 = String(req.query.from || "").trim();
    const period2 = String(req.query.to || "").trim() || new Date().toISOString().slice(0, 10);
    const interval = String(req.query.interval || "1d").trim();

    const maxSymbols = 60;
    if (!symbols.length) {
      return res.status(400).json({ error: "symbols query param required" });
    }
    if (symbols.length > maxSymbols) {
      return res.status(400).json({ error: `too many symbols (max ${maxSymbols})` });
    }
    if (!period1 || !isYYYYMMDD(period1)) {
      return res.status(400).json({ error: "from param required (YYYY-MM-DD)" });
    }
    if (!isYYYYMMDD(period2)) {
      return res.status(400).json({ error: "to param invalid (YYYY-MM-DD)" });
    }
    if (new Date(period1) > new Date(period2)) {
      return res.status(400).json({ error: "from must be <= to" });
    }

    const out = await mapPool(
      symbols,
      async (symbol) => {
        try {
          // 1) Serie storica con retry "soft"
          const series = await withRetry(
            () =>
              yahooFinance.historical(symbol, {
                period1,
                period2,
                interval,
                events: "history",
                includeAdjustedClose: true,
              }),
            { retries: 1, delayMs: 500 }
          );

          if (!Array.isArray(series) || series.length === 0) {
            return {
              symbol,
              name: null,
              shortName: null,
              currency: null,
              current: null,
              min: null,
              max: null,
              potentialPct: null,
              series: [],
              error: "no historical data",
            };
          }

          // 2) Quote attuale (retry soft, fallback ultimo close)
          let q = null;
          try {
            q = await withRetry(() => yahooFinance.quote(symbol), { retries: 1, delayMs: 400 });
          } catch (_) {
            // fallback su ultimo close
          }

          const lastClose = series[series.length - 1]?.close;
          const current = Number.isFinite(q?.regularMarketPrice)
            ? q.regularMarketPrice
            : (Number.isFinite(lastClose) ? lastClose : null);

          // 3) Min/max nel range
          const lows  = series.map(r => r.low).filter((v) => Number.isFinite(v));
          const highs = series.map(r => r.high).filter((v) => Number.isFinite(v));

          const min = lows.length  ? Math.min(...lows)  : null;
          const max = highs.length ? Math.max(...highs) : null;

          // 4) Upside %
          const potentialPct =
            Number.isFinite(current) && Number.isFinite(max) ? ((max / current - 1) * 100) : null;

          // 5) Riduzione serie per il client
          const cleanSeries = series.map(r => ({
            date: r.date,
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            adjClose: r.adjClose,
            volume: r.volume,
          }));

          // 6) Nome descrittivo robusto (quote → quoteSummary.price → search)
          const name = await resolvePrettyName(symbol, q);

          return {
            symbol,
            name,                         // <-- usato dal client per la colonna "Nome" e per UI
            shortName: q?.shortName || null,
            currency: q?.currency || null,
            current,
            min,
            max,
            potentialPct,
            series: cleanSeries,
          };
        } catch (err) {
          // Errore isolato per questo simbolo → non blocchiamo gli altri
          return {
            symbol,
            name: null,
            shortName: null,
            currency: null,
            current: null,
            min: null,
            max: null,
            potentialPct: null,
            series: [],
            error: String(err?.message || err),
          };
        }
      },
      6 // concurrency
    );

    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(502).json({
      error: "History fetch error",
      details: String(err?.message || err),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("API server running on port", PORT);
});


