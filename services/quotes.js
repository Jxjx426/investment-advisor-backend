const { units, text } = require("../lib/accounting");
const TTL = 5 * 60 * 1000;

function createQuoteService(db, env = process.env, fetcher = fetch, budget) {
  const pending = new Map(), attempts = new Map();

  function quote(instrument, price, timestamp, currency, source, now) {
    if (!Number.isFinite(Number(price)) || Number(price) <= 0 ||
        !Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) {
      throw new Error("No valid quote returned.");
    }
    const decimal = text(units(Number(price).toFixed(8)));
    if (units(decimal) <= 0n) throw new Error("No valid quote returned.");
    const quotedAt = Number(timestamp) * 1000;
    if (quotedAt > now + 60000) throw new Error("Quote timestamp is in the future.");
    return {
      instrument, price: decimal, currency,
      quoted_at: new Date(quotedAt).toISOString(),
      fetched_at: new Date(now).toISOString(), source,
    };
  }

  async function primary(instrument, now) {
    const [market, symbol] = instrument.split(":");
    let url, source, currency;
    if (market === "US") {
      if (!env.FINNHUB_API_KEY) throw new Error("Finnhub key missing.");
      url = new URL("https://finnhub.io/api/v1/quote");
      url.search = new URLSearchParams({ symbol, token: env.FINNHUB_API_KEY });
      source = "Finnhub"; currency = "USD";
    } else {
      if (!env.TWELVE_DATA_API_KEY) throw new Error("Twelve Data key missing.");
      const fx = market === "FX";
      url = new URL(`https://api.twelvedata.com/${fx ? "exchange_rate" : "quote"}`);
      url.search = new URLSearchParams({
        symbol: fx ? "USD/MYR" : symbol, apikey: env.TWELVE_DATA_API_KEY,
        ...(fx ? {} : { mic_code: "XKLS", country: "Malaysia" }),
      });
      source = "Twelve Data"; currency = "MYR";
    }
    if (budget) await budget.reserve(market === "US" ? "finnhub" : "twelve");
    const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    if (!response.ok || data.status === "error") throw new Error("Quote provider unavailable.");
    if (market === "MY" && (data.currency !== "MYR" || data.mic_code !== "XKLS" ||
        (data.symbol != null && data.symbol !== symbol))) {
      throw new Error("Quote market or currency mismatch.");
    }
    return quote(instrument,
      market === "US" ? data.c : market === "FX" ? data.rate : data.close,
      market === "US" ? data.t : data.last_quote_at || data.timestamp,
      currency, source, now);
  }

  async function fallback(instrument, now) {
    const [market, symbol] = instrument.split(":");
    // Public delayed Bursa and USD/MYR quotes; never send provider keys here.
    const yahooSymbol = market === "MY" ? `${symbol}.KL` : "MYR=X";
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`);
    url.search = new URLSearchParams({ interval: "1d", range: "5d" });
    if (budget) await budget.reserve("yahoo");
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(8000), headers: { "User-Agent": "InvestmentTracker/1.0" },
    });
    const data = await response.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!response.ok || data.chart?.error || !meta || meta.symbol !== yahooSymbol ||
        meta.currency !== "MYR" || meta.exchangeName !== (market === "MY" ? "KLS" : "CCY")) {
      throw new Error("Fallback quote market or currency mismatch.");
    }
    return quote(instrument, meta.regularMarketPrice, meta.regularMarketTime,
      "MYR", "Yahoo Finance (delayed)", now);
  }

  async function get(instrument) {
    if (!/^(?:US:[A-Z][A-Z0-9.-]{0,14}|MY:\d{4,5}[A-Z]{0,2}|FX:USDMYR)$/.test(instrument)) {
      throw new Error("Invalid quote instrument.");
    }
    if (pending.has(instrument)) return pending.get(instrument);
    const job = load(instrument).finally(() => pending.delete(instrument));
    pending.set(instrument, job);
    return job;
  }

  async function load(instrument) {
    const read = async () => (await db.query(
      "SELECT * FROM tracker_quotes WHERE instrument=$1", [instrument],
    )).rows[0];
    let cached = await read();
    const now = Date.now();
    let failed = false;
    if (!cached || now - Date.parse(cached.fetched_at) > TTL) {
      if (now - (attempts.get(instrument) || 0) < TTL) failed = true;
      else {
        attempts.set(instrument, now);
        try {
          if (env.DISABLE_MARKET_DATA === "true") throw new Error("Market data disabled.");
          let candidate;
          try { candidate = await primary(instrument, now); }
          catch (error) {
            if (instrument.startsWith("US:") || env.YAHOO_FALLBACK === "false") throw error;
            candidate = await fallback(instrument, now);
          }
          // A slower/older provider response must not replace a newer cached price.
          await db.query(
            `INSERT INTO tracker_quotes(instrument,price,currency,quoted_at,fetched_at,source) VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(instrument) DO UPDATE SET price=excluded.price,currency=excluded.currency,quoted_at=excluded.quoted_at,fetched_at=excluded.fetched_at,source=excluded.source
             WHERE excluded.quoted_at>=tracker_quotes.quoted_at`,
            [candidate.instrument, candidate.price, candidate.currency, candidate.quoted_at, candidate.fetched_at, candidate.source],
          );
          cached = await read();
        } catch { failed = true; }
      }
    }
    if (!cached) return { instrument, price: null, status: "unavailable", quoted_at: null, source: null };
    return {
      ...cached,
      status: failed || now - Date.parse(cached.quoted_at) > 20 * 60 * 1000 ? "stale" : "available",
    };
  }
  return { get };
}
module.exports = { createQuoteService };
