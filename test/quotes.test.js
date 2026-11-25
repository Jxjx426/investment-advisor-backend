process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createDatabase } = require("../db");
const { createQuoteService } = require("../services/quotes");
const { createUsageBudget } = require("../services/usage");
const { createApp } = require("../index");
const { normalize } = require("../lib/accounting");
const json = (data, status = 200) => ({ ok: status < 400, json: async () => data });
const denied = () => json({ status: "error", message: "Provider plan does not include this market" }, 403);
const yahoo = (overrides = {}) => json({ chart: { error: null, result: [{ meta: {
  symbol: "1155.KL", currency: "MYR", exchangeName: "KLS",
  regularMarketPrice: 10.1, regularMarketTime: Math.floor(Date.now() / 1000) - 60,
  ...overrides,
} }] } });
async function fixture(t) {
  const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: ":memory:" });
  await db.init(); t.after(() => db.close()); return db;
}

test("valid primary Bursa quotes remain preferred; a different primary symbol is rejected", async t => {
  const db = await fixture(t); let calls = 0;
  const primary = createQuoteService(db, { TWELVE_DATA_API_KEY: "test", YAHOO_FALLBACK: "false" }, async () => {
    calls++; return json({symbol:"1155",currency:"MYR",mic_code:"XKLS",close:10.2,timestamp:Math.floor(Date.now()/1000)});
  });
  assert.equal((await primary.get("MY:1155")).source,"Twelve Data"); assert.equal(calls,1);
  const wrong = createQuoteService(db, { TWELVE_DATA_API_KEY: "test", YAHOO_FALLBACK: "false" }, async () =>
    json({symbol:"1155",currency:"MYR",mic_code:"XKLS",close:10.2,timestamp:Math.floor(Date.now()/1000)}));
  assert.equal((await wrong.get("MY:0097")).price,null);
});

test("Bursa plan failures use validated, key-free delayed quotes and share the cache/budget", async t => {
  const db = await fixture(t), urls = [];
  const service = createQuoteService(db, { TWELVE_DATA_API_KEY: "private-test-key" }, async url => {
    urls.push(url);
    return url.hostname === "api.twelvedata.com" ? denied() : yahoo({ symbol: "0097.KL" });
  }, createUsageBudget(db));
  const [first, second] = await Promise.all([service.get("MY:0097"), service.get("MY:0097")]);
  assert.equal(first.price, "10.10000000"); assert.deepEqual(first, second);
  assert.equal(first.source, "Yahoo Finance (delayed)"); assert.equal(first.status, "available");
  assert.equal(urls.length, 2); assert.equal(urls[1].pathname, "/v8/finance/chart/0097.KL");
  assert(!urls[1].href.includes("private-test-key"));
  assert.equal((await service.get("MY:0097")).price, first.price); assert.equal(urls.length, 2);
  const usage = (await db.query("SELECT provider,calls FROM tracker_api_usage WHERE length(window_key)=10 ORDER BY provider")).rows;
  assert.deepEqual(usage, [{ provider: "twelve", calls: 1 }, { provider: "yahoo", calls: 1 }]);
});

test("fallback rejects mismatched symbols, exchanges, currencies, invalid prices and future timestamps", async t => {
  const db = await fixture(t);
  for (const invalid of [
    { symbol: "1155.SI" }, { exchangeName: "NMS" }, { currency: "USD" },
    { regularMarketPrice: 0 }, { regularMarketPrice: 0.000000001 },
    { regularMarketTime: 0 }, { regularMarketTime: Math.floor(Date.now() / 1000) + 3600 },
  ]) {
    const service = createQuoteService(db, {}, async () => yahoo(invalid));
    assert.equal((await service.get("MY:1155")).price, null);
  }
  assert.equal((await db.query("SELECT * FROM tracker_quotes")).rows.length, 0);
});

test("an older fallback never replaces the latest valid cached price; complete failures keep it stale", async t => {
  const db = await fixture(t), stamp = new Date(Date.now() - 60000).toISOString();
  await db.query("INSERT INTO tracker_quotes VALUES($1,$2,$3,$4,$5,$6)",
    ["MY:1155", "11.00000000", "MYR", stamp, "2020-01-01T00:00:00Z", "Verified cached quote"]);
  const older = createQuoteService(db, {}, async () => yahoo({ regularMarketTime: Math.floor(Date.now() / 1000) - 86400 }));
  assert.equal((await older.get("MY:1155")).price, "11.00000000");
  const failed = createQuoteService(db, {}, async () => { throw new Error("offline"); });
  const quote = await failed.get("MY:1155");
  assert.equal(quote.price, "11.00000000"); assert.equal(quote.source, "Verified cached quote");
  assert.equal(quote.quoted_at, stamp); assert.equal(quote.status, "stale");
});

test("USD/MYR can recover from a Twelve Data budget failure using the correct currency pair", async t => {
  const db = await fixture(t), providers = [], urls = [];
  const service = createQuoteService(db, { TWELVE_DATA_API_KEY: "test" }, async url => {
    urls.push(url); return yahoo({ symbol: "MYR=X", exchangeName: "CCY", regularMarketPrice: 4.12 });
  }, { reserve: async provider => { providers.push(provider); if (provider === "twelve") throw new Error("limit"); } });
  const quote = await service.get("FX:USDMYR");
  assert.equal(quote.price, "4.12000000"); assert.equal(quote.currency, "MYR");
  assert.deepEqual(providers, ["twelve", "yahoo"]); assert.equal(urls.length, 1);
  assert.equal(decodeURIComponent(urls[0].pathname), "/v8/finance/chart/MYR=X");
});

test("unavailable data stays unknown, retries cool down, and disabled market data makes no requests", async t => {
  const db = await fixture(t); let calls = 0;
  const service = createQuoteService(db, { TWELVE_DATA_API_KEY: "test" }, async () => { calls++; throw new Error("offline"); });
  assert.equal((await service.get("MY:1155")).price, null);
  assert.equal((await service.get("MY:1155")).status, "unavailable"); assert.equal(calls, 2);
  const disabled = createQuoteService(db, { DISABLE_MARKET_DATA: "true" }, async () => { calls++; });
  assert.equal((await disabled.get("MY:0097")).price, null); assert.equal(calls, 2);
  const optOut = createQuoteService(db, { YAHOO_FALLBACK: "false" }, async () => { calls++; });
  assert.equal((await optOut.get("MY:0097")).price, null); assert.equal(calls, 2);
  await assert.rejects(service.get("MY:../1155"), /Invalid quote instrument/);
});

test("authenticated tracker calculates Bursa value and unrealized P/L from fallback, preserving newer manual prices", async t => {
  const db = await fixture(t), secret = randomBytes(32).toString("hex");
  await db.query("INSERT INTO users(email,password_hash) VALUES($1,$2)", ["quote-test@example.test", "unused-test-hash"]);
  await db.query("INSERT INTO tracker_owners(user_id,owner_key,name) VALUES(1,'mine','Mine')");
  const row = normalize({ owner_id: 1, kind: "BUY", occurred_on: "2026-01-01", market: "MY", symbol: "1155", currency: "MYR", quantity: "200", price: "10", fee: "2" });
  const fields = Object.keys(row);
  await db.query(`INSERT INTO tracker_transactions(user_id,${fields.join(",")}) VALUES($1,${fields.map((_,i)=>`$${i+2}`).join(",")})`, [1,...fields.map(key=>row[key])]);
  const quotes = createQuoteService(db, {}, async () => yahoo());
  const server = createApp(db, { JWT_SECRET: secret }, quotes).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, token = jwt.sign({userId:1},secret);
  const get = async () => {
    const response = await fetch(`${base}/tracker`, {headers:{Authorization:`Bearer ${token}`}});
    assert.equal(response.status,200); return response.json();
  };
  const first = (await get()).positions[0];
  assert.equal(first.current_value,"2020.00000000"); assert.equal(first.unrealized_pl,"18.00000000");
  await db.query("INSERT INTO tracker_manual_quotes VALUES($1,$2,$3,$4)", [1,"MY:1155","10.5",new Date().toISOString()]);
  const manual = (await get()).positions[0];
  assert.equal(manual.current_value,"2100.00000000"); assert.equal(manual.unrealized_pl,"98.00000000");
  assert.equal(manual.quote.status,"manual");
});
