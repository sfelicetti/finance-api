// server.js
// trigger render deploy
import express from "express";
import cors from "cors";
import YahooFinance from "yahoo-finance2";

const app = express();
app.use(cors({ origin: true }));

const yahooFinance = new YahooFinance();

// PING
app.get("/", (req, res) => {
  res.send("OK");
});

// === NUOVO ENDPOINT /api/history ===
// Esempio: /api/history?symbols=AAPL,MSFT&from=2024-01-01&to=2024-02-01
app.get("/api/history", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const period1 = req.query.from;
    const period2 = req.query.to || new Date().toISOString().slice(0, 10);
    const interval = "1d";

    if (!symbols.length) {
      return res.status(400).json({ error: "symbols query param required" });
    }
    if (!period1) {
      return res.status(400).json({ error: "from param required (YYYY-MM-DD)" });
    }

    const out = await Promise.all(
      symbols.map(async (symbol) => {
        // 1) Serie storica
        const series = await yahooFinance.historical(symbol, {
          period1,
          period2,
          interval,
          events: "history",
          includeAdjustedClose: true,
        });

        // Nessun dato → ritorna oggetto vuoto
        if (!series || !series.length) {
          return {
            symbol,
            shortName: null,
            currency: null,
            current: null,
            min: null,
            max: null,
            potentialPct: null,
            series: [],
          };
        }

        // 2) Quote attuale (fallback → ultimo close)
        let q = null;
        try { q = await yahooFinance.quote(symbol); } catch (_) {}

        const current =
          q?.regularMarketPrice ??
          series[series.length - 1].close;

        // 3) Calcolo min/max
        const lows  = series.map(r => r.low).filter(v => Number.isFinite(v));
        const highs = series.map(r => r.high).filter(v => Number.isFinite(v));

        const min = lows.length  ? Math.min(...lows)  : null;
        const max = highs.length ? Math.max(...highs) : null;

        // 4) Upside %
        const potentialPct =
          current && max ? ((max / current - 1) * 100) : null;

        // 5) Serie ridotta per il client
        const cleanSeries = series.map(r => ({
          date: r.date,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          adjClose: r.adjClose,
          volume: r.volume,
        }));

        return {
          symbol,
          shortName: q?.shortName || symbol,
          currency: q?.currency || null,
          current,
          min,
          max,
          potentialPct,
          series: cleanSeries,
        };
      })
    );

    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "History fetch error", details: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("API server running on port", PORT);
});
