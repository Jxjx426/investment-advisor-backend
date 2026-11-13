const { units, text } = require("../lib/accounting");
const TTL = 5 * 60 * 1000;
function createQuoteService(db, env = process.env, fetcher = fetch, budget) {
  const pending = new Map(),
    attempts = new Map();
  async function get(instrument) {
    if (pending.has(instrument)) return pending.get(instrument);
    const job = load(instrument).finally(() => pending.delete(instrument));
    pending.set(instrument, job);
    return job;
  }
  async function load(instrument) {
    let cached = (
      await db.query("SELECT * FROM tracker_quotes WHERE instrument = $1", [
        instrument,
      ])
    ).rows[0];
    const now = Date.now();
    let failed = false;
    if (!cached || now - Date.parse(cached.fetched_at) > TTL) {
      if (now - (attempts.get(instrument) || 0) < TTL) failed = true;
      else {
        attempts.set(instrument, now);
        try {
          if (env.DISABLE_MARKET_DATA === "true")
            throw new Error("Market data disabled in this environment.");
          const [market, symbol] = instrument.split(":");
          let url, source, currency;
          if (market === "US") {
            if (!env.FINNHUB_API_KEY) throw new Error("Finnhub key missing.");
            url = new URL("https://finnhub.io/api/v1/quote");
            url.search = new URLSearchParams({
              symbol,
              token: env.FINNHUB_API_KEY,
            });
            source = "Finnhub";
            currency = "USD";
          } else {
            if (!env.TWELVE_DATA_API_KEY)
              throw new Error("Twelve Data key missing.");
            const fx = market === "FX";
            url = new URL(
              `https://api.twelvedata.com/${fx ? "exchange_rate" : "quote"}`,
            );
            url.search = new URLSearchParams({
              symbol: fx ? "USD/MYR" : symbol,
              apikey: env.TWELVE_DATA_API_KEY,
              ...(fx ? {} : { mic_code: "XKLS", country: "Malaysia" }),
            });
            source = "Twelve Data";
            currency = "MYR";
          }
          if (budget) await budget.reserve(market === "US" ? "finnhub" : "twelve");
          const response = await fetcher(url, {
            signal: AbortSignal.timeout(8000),
          });
          const data = await response.json();
          const price =
            market === "US" ? data.c : market === "FX" ? data.rate : data.close;
          const timestamp =
            market === "US" ? data.t : data.last_quote_at || data.timestamp;
          if (
            !response.ok ||
            data.status === "error" ||
            !Number.isFinite(Number(price)) ||
            Number(price) <= 0 ||
            !Number.isFinite(Number(timestamp)) ||
            Number(timestamp) <= 0
          )
            throw new Error("No valid quote returned.");
          if (
            market === "MY" &&
            (data.currency !== "MYR" || data.mic_code !== "XKLS")
          )
            throw new Error("Quote market or currency mismatch.");
          const decimal = text(units(Number(price).toFixed(8)));
          const quoted_at = new Date(Number(timestamp) * 1000).toISOString();
          if (Date.parse(quoted_at) > now + 60000)
            throw new Error("Quote timestamp is in the future.");
          cached = {
            instrument,
            price: decimal,
            currency,
            quoted_at,
            fetched_at: new Date(now).toISOString(),
            source,
          };
          await db.query(
            `INSERT INTO tracker_quotes (instrument,price,currency,quoted_at,fetched_at,source) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT(instrument) DO UPDATE SET price=excluded.price,currency=excluded.currency,quoted_at=excluded.quoted_at,fetched_at=excluded.fetched_at,source=excluded.source`,
            Object.values(cached),
          );
        } catch {
          failed = true;
        }
      }
    }
    if (!cached)
      return {
        instrument,
        price: null,
        status: "unavailable",
        quoted_at: null,
        source: null,
      };
    return {
      ...cached,
      status:
        failed || now - Date.parse(cached.quoted_at) > 20 * 60 * 1000
          ? "stale"
          : "available",
    };
  }
  return { get };
}
module.exports = { createQuoteService };
