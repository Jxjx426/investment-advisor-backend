process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { createDatabase } = require("../db");
const { createApp } = require("../index");
const { createQuoteService } = require("../services/quotes");
const { randomBytes } = require("node:crypto");

test("authenticated ledger lifecycle, atomic imports, isolation, version conflicts and audit", async (t) => {
  const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: ":memory:" });
  await db.init();
  const secret = randomBytes(32).toString("hex");
  const hash = await bcrypt.hash("test-password-only", 4);
  await db.query("INSERT INTO users (email,password_hash) VALUES ($1,$2)", [
    "one@example.test",
    hash,
  ]);
  await db.query("INSERT INTO users (email,password_hash) VALUES ($1,$2)", [
    "two@example.test",
    hash,
  ]);
  const env = {
    JWT_SECRET: secret,
    ENABLE_LEGACY_ROUTES: "false",
    DISABLE_MARKET_DATA: "true",
  };
  const app = createApp(db, env);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ userId: 1 }, secret),
    other = jwt.sign({ userId: 2 }, secret);
  async function call(path, method = "GET", body, auth = token) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await call("/tracker", "GET", null, null)).status, 401);
  assert.equal((await call("/auth/register", "POST", {})).status, 403);
  assert.equal(
    (
      await call("/auth/login", "POST", {
        email: "one@example.test",
        password: "wrong",
      })
    ).status,
    401,
  );
  assert.ok(
    (
      await call("/auth/login", "POST", {
        email: "one@example.test",
        password: "test-password-only",
      })
    ).data.token,
  );
  const initial = (await call("/tracker")).data;
  assert.equal(initial.owners.length, 2);
  assert.equal(initial.transactions.length, 0);
  const mine = initial.owners.find((o) => o.owner_key === "mine").id,
    father = initial.owners.find((o) => o.owner_key === "father").id;
  const trade = {
    owner_id: mine,
    kind: "BUY",
    occurred_on: "2026-01-01",
    market: "US",
    symbol: "AAPL",
    currency: "USD",
    quantity: "2",
    price: "100",
    fee: "1",
  };
  assert.equal(
    (await call("/tracker/transactions", "POST", { ...trade, owner_id: 999 }))
      .status,
    404,
  );
  assert.equal(
    (
      await call("/tracker/transactions/preview", "POST", {
        transactions: [trade],
      })
    ).status,
    200,
  );
  assert.equal((await call("/tracker")).data.transactions.length, 0);
  const buy = await call("/tracker/transactions", "POST", trade);
  assert.equal(buy.status, 201);
  const sale = {
    ...trade,
    kind: "SELL",
    occurred_on: "2026-01-02",
    quantity: "1",
    price: "120",
  };
  assert.equal(
    (
      await call("/tracker/transactions/bulk", "POST", {
        transactions: [sale, { ...sale, owner_id: father }],
      })
    ).status,
    400,
  );
  assert.equal((await call("/tracker")).data.transactions.length, 1);
  assert.equal(
    (await call("/tracker/transactions", "POST", trade)).status,
    409,
  );
  assert.deepEqual(
    (
      await call("/tracker/transactions/preview", "POST", {
        transactions: [trade],
      })
    ).data.duplicate_rows,
    [1],
  );
  const sold = await call("/tracker/transactions", "POST", sale);
  assert.equal(sold.status, 201);
  const snapshot = (await call("/tracker")).data;
  assert.equal(snapshot.positions[0].realized, "18.50000000");
  assert.equal(snapshot.positions[0].current_value, null);
  assert.equal(snapshot.positions[0].unrealized_pl, null);
  assert.equal(snapshot.positions[0].quote.status, "unavailable");
  assert.equal(
    (
      await call("/tracker/quotes/manual", "POST", {
        market: "US",
        symbol: "AAPL",
        currency: "USD",
        price: "130",
        quoted_at: new Date().toISOString(),
      })
    ).status,
    200,
  );
  const manual = (await call("/tracker")).data.positions[0];
  assert.equal(manual.quote.status, "manual");
  assert.equal(manual.current_value, "130.00000000");
  assert.equal(
    (
      await call("/tracker/quotes/manual", "POST", {
        market: "US",
        symbol: "AAPL",
        currency: "USD",
        price: "130",
        quoted_at: "2099-01-01T00:00:00Z",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/tracker/transactions/${buy.data.id}`, "DELETE", {
        version: 1,
      })
    ).status,
    400,
  );
  const edit = await call(`/tracker/transactions/${buy.data.id}`, "PUT", {
    ...trade,
    price: "90",
    version: 1,
  });
  assert.equal(edit.status, 200);
  assert.equal(
    (
      await call(`/tracker/transactions/${buy.data.id}`, "PUT", {
        ...trade,
        version: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(`/tracker/transactions/${buy.data.id}/audit`)).data.length,
    2,
  );
  assert.equal(
    (
      await call(
        `/tracker/transactions/${sold.data.id}`,
        "DELETE",
        { version: 1 },
        other,
      )
    ).status,
    404,
  );
  assert.deepEqual(
    (
      await call(
        `/tracker/transactions/${buy.data.id}/audit`,
        "GET",
        null,
        other,
      )
    ).data,
    [],
  );
  assert.equal(
    (await call("/tracker", "GET", null, other)).data.transactions.length,
    0,
  );
  assert.equal(
    (
      await call(`/tracker/transactions/${sold.data.id}`, "DELETE", {
        version: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/tracker/transactions/${buy.data.id}`, "DELETE", {
        version: 2,
      })
    ).status,
    200,
  );
  assert.equal((await call("/tracker")).data.positions.length, 0);
});

test("quote caching persists last good price, deduplicates calls and handles provider failure", async () => {
  const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: ":memory:" });
  await db.init();
  try {
    let calls = 0;
    const service = createQuoteService(
      db,
      { FINNHUB_API_KEY: "test" },
      async () => {
        calls++;
        return {
          ok: true,
          json: async () => ({ c: 120, t: Math.floor(Date.now() / 1000) }),
        };
      },
    );
    const [a, b] = await Promise.all([
      service.get("US:AAPL"),
      service.get("US:AAPL"),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.price, b.price);
    assert.equal((await service.get("US:AAPL")).status, "available");
    assert.equal(calls, 1);
    await db.query(
      "UPDATE tracker_quotes SET fetched_at=$1 WHERE instrument=$2",
      ["2020-01-01T00:00:00Z", "US:AAPL"],
    );
    const failing = createQuoteService(
      db,
      { FINNHUB_API_KEY: "test" },
      async () => {
        throw new Error("offline");
      },
    );
    const stale = await failing.get("US:AAPL");
    assert.equal(stale.price, "120.00000000");
    assert.equal(stale.status, "stale");
    const missing = await failing.get("US:UNKNOWN");
    assert.equal(missing.price, null);
    assert.equal(missing.status, "unavailable");
    const wrongMarket = createQuoteService(
      db,
      { TWELVE_DATA_API_KEY: "test" },
      async () => ({
        ok: true,
        json: async () => ({
          close: "10",
          currency: "USD",
          mic_code: "XNAS",
          timestamp: Math.floor(Date.now() / 1000),
        }),
      }),
    );
    assert.equal((await wrongMarket.get("MY:1155")).price, null);
  } finally {
    await db.close();
  }
});
