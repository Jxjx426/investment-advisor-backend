// Counts attempted provider calls, including failures. Shared by quotes and research.
const DEFAULTS = { finnhub: [30, 1000], twelve: [6, 600], news: [5, 50], gemini: [2, 10] };
function createUsageBudget(db, env = process.env, clock = Date.now) {
  async function reserve(provider) {
    const defaults = DEFAULTS[provider];
    if (!defaults) throw new Error("Unknown provider.");
    const now = clock();
    const stamp = new Date(now).toISOString();
    const windows = [stamp.slice(0, 16), stamp.slice(0, 10)];
    const limits = defaults.map((value, index) => {
      const input = Number(env[`${provider.toUpperCase()}_${index ? "DAILY" : "MINUTE"}_LIMIT`] ?? value);
      if (!Number.isSafeInteger(input) || input < 0) throw new Error("Invalid API budget configuration.");
      return input;
    });
    await db.transaction(-733001, async (client) => {
      for (let i = 0; i < windows.length; i++) {
        const row = (await client.query("SELECT calls FROM tracker_api_usage WHERE provider=$1 AND window_key=$2", [provider, windows[i]])).rows[0];
        if (Number(row?.calls || 0) >= limits[i]) {
          const error = new Error(`${provider === "gemini" ? "AI" : "Market data"} request limit reached. Try again later.`);
          error.status = 429;
          error.retryAfter = i ? Math.ceil((Date.parse(stamp.slice(0, 10)) + 86400000 - now) / 1000) : 60;
          throw error;
        }
      }
      for (const key of windows) await client.query("INSERT INTO tracker_api_usage(provider,window_key,calls) VALUES($1,$2,1) ON CONFLICT(provider,window_key) DO UPDATE SET calls=tracker_api_usage.calls+1", [provider, key]);
      // Current windows suffice for limits; retain a month for inspection.
      await client.query("DELETE FROM tracker_api_usage WHERE window_key < $1", [new Date(now - 31 * 86400000).toISOString().slice(0, 10)]);
    });
  }
  return { reserve };
}
module.exports = { createUsageBudget };
