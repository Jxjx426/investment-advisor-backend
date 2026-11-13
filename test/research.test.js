process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../db");
const { createResearchService, instrument, sentiment, safeUrl } = require("../services/research");
const { createUsageBudget } = require("../services/usage");
const env = { TWELVE_DATA_API_KEY: "test-only", FINNHUB_API_KEY: "test-only", GEMINI_API_KEY: "test-only" };
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function fixture(t) { const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: ":memory:" }); await db.init(); t.after(() => db.close()); return db; }
const prices = { meta: { symbol: "TSLA", currency: "USD" }, values: [{ datetime: "2026-11-12", close: "300" }, { datetime: "2026-11-10", close: "280" }, { datetime: "2026-11-11", close: "0" }, { datetime: "2026-11-12", close: "300" }, { datetime: "2027-01-01", close: "999" }] };
const stock = instrument("US", "TSLA");

test("research validates market identifiers, preserves Bursa zeros and restricts links", () => {
  assert.equal(instrument("MY", "0012").symbol, "0012");
  for (const [market, symbol] of [["US", "../AAPL"], ["MY", "TSLA"], ["FX", "USD"], ["US", "<svg>"]]) assert.throws(() => instrument(market, symbol));
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://user:pass@example.test"), null);
  assert.equal(sentiment([{ title: "Cutting-edge product growth" }, { title: "New product" }, { title: "Shares fall after loss" }]).positive, 1);
  assert.equal(sentiment([{ title: "Cutting-edge product" }]).neutral, 1);
});
test("history shares persistent cache across periods and concurrent calls, preserves gaps and stale prices", async t => {
  const db = await fixture(t); let now = Date.parse("2026-11-13T00:00:00Z"), calls = 0, failed = false;
  const options = { clock: () => now, fetcher: async url => { calls++; assert.equal(url.searchParams.get("country"), "United States"); if (failed) throw new Error("secret-provider-token"); return json(prices); } };
  const service = createResearchService(db, env, options);
  const [first, second] = await Promise.all([service.history(stock, "1m"), service.history(stock, "1y")]);
  assert.equal(calls, 1); assert.equal(first.history.length, 2); assert.deepEqual(first.history.map(point => point.date), ["2026-11-10", "2026-11-12"]); assert.equal(second.history.at(-1).price, 300);
  const restarted = createResearchService(db, env, options);
  assert.equal((await restarted.history(stock)).cached, true); assert.equal(calls, 1);
  now += 7 * 3600000; failed = true;
  const stale = await restarted.history(stock); assert.equal(stale.stale, true); assert.equal(stale.fetched_at, first.fetched_at); assert.equal(stale.history.at(-1).price, 300); assert.doesNotMatch(JSON.stringify(stale), /secret-provider/);
  await restarted.history(stock); assert.equal(calls, 2, "failed providers have a cooldown");
});
test("Bursa chart requests specify XKLS and reject another currency instead of plotting it", async t => {
  const db = await fixture(t);
  const service = createResearchService(db, env, { fetcher: async url => { assert.equal(url.searchParams.get("mic_code"), "XKLS"); return json({ meta: { symbol: "1155", mic_code: "XKLS", currency: "USD" }, values: prices.values }); } });
  await assert.rejects(service.history(instrument("MY", "1155")), /different market or currency/);
});
test("provider budgets are atomic, persistent, shared across instances and reset at window boundaries", async t => {
  const db = await fixture(t); let now = Date.parse("2026-11-13T00:00:00Z");
  const config = { GEMINI_MINUTE_LIMIT: "2", GEMINI_DAILY_LIMIT: "3" };
  const a = createUsageBudget(db, config, () => now), b = createUsageBudget(db, config, () => now);
  const results = await Promise.allSettled([a.reserve("gemini"), b.reserve("gemini"), a.reserve("gemini"), b.reserve("gemini")]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 2);
  now += 61000; await a.reserve("gemini"); await assert.rejects(b.reserve("gemini"), /limit/);
  now += 86400000; await b.reserve("gemini");
});
test("news links are cleaned and AI runs only on request, cites the same headlines and caches output", async t => {
  const db = await fixture(t); let newsCalls = 0, aiCalls = 0;
  const clock = () => Date.parse("2026-11-13T00:00:00Z");
  const headline = { headline: "Tesla shares gain after product update", source: "Publisher", url: "https://example.test/one", datetime: (clock() - 3600000) / 1000 };
  const service = createResearchService(db, env, { clock, fetcher: async () => { newsCalls++; return json([headline, headline, { ...headline, url: "javascript:x" }, { ...headline, url: "https://example.test/future", datetime: clock() / 1000 + 99999 }]); }, ai: { models: { generateContent: async input => { aiCalls++; const data = JSON.parse(input.contents); assert.equal(data.stock, "US:TSLA"); assert.equal(data.headlines.length, 1); assert.equal(input.config.maxOutputTokens, 1200); assert.doesNotMatch(input.contents, /balance|password|contributions/); return { text: JSON.stringify({ points: [{ text: "特斯拉股价上涨，标题提到产品更新。", sources: [1] }] }) }; } } } });
  const news = await service.news(stock); assert.equal(news.articles.length, 1); assert.equal(news.sentiment.positive, 1); assert.equal(aiCalls, 0);
  const [a, b] = await Promise.all([service.summary(stock), service.summary(stock)]);
  assert.equal(aiCalls, 1); assert.equal(newsCalls, 1); assert.equal(a.points[0].sources[0], 1); assert.equal(b.articles[0].url, headline.url);
  await service.summary(stock); assert.equal(aiCalls, 1);
});
test("invalid AI citations are rejected and development NewsAPI is blocked in production", async t => {
  const db = await fixture(t);
  const service = createResearchService(db, { ...env, NODE_ENV: "production", NEWS_API_KEY: "test-only" }, { fetcher: async () => json([{ headline: "Tesla new product", source: "Publisher", url: "https://example.test/one", datetime: Date.now() / 1000 - 3600 }]), ai: { models: { generateContent: async () => ({ text: '{"points":[{"text":"Unverifiable","sources":[99]}]}' }) } } });
  await assert.rejects(service.summary(stock), /not enough relevant/);
  await assert.rejects(service.news(instrument("MY", "1155")), /development key/);
});
