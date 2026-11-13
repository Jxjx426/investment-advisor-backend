process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  jwt = require("jsonwebtoken"),
  { randomBytes } = require("node:crypto");
const { createDatabase } = require("../db"),
  { createApp } = require("../index");
test("Phase 2 API keeps multi-leg corrections atomic and broker comparisons private and current", async (t) => {
  const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: ":memory:" });
  await db.init();
  for (const email of ["one@test.local", "two@test.local"])
    await db.query("INSERT INTO users(email,password_hash) VALUES($1,$2)", [
      email,
      "unused",
    ]);
  const secret = randomBytes(32).toString("hex"),
    app = createApp(db, {
      JWT_SECRET: secret,
      DISABLE_MARKET_DATA: "true",
      ENABLE_LEGACY_ROUTES: "false",
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`,
    token = jwt.sign({ userId: 1 }, secret),
    other = jwt.sign({ userId: 2 }, secret);
  async function call(path, method = "GET", body, auth = token) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const profiles = (await call("/tracker")).data.owners,
    mine = profiles.find((p) => p.owner_key === "mine").id,
    dad = profiles.find((p) => p.owner_key === "father").id,
    foreign = (await call("/tracker", "GET", null, other)).data.owners[0].id;
  const entry = (values) => ({
    owner_id: mine,
    kind: "DEPOSIT",
    occurred_on: "2026-01-01",
    currency: "MYR",
    amount: "1000",
    fee: "0",
    ...values,
  });
  assert.equal(
    (await call("/tracker/transactions", "POST", entry({}))).status,
    201,
  );
  const fx = await call(
    "/tracker/transactions",
    "POST",
    entry({
      kind: "FX",
      amount: "430",
      target_currency: "USD",
      target_amount: "100",
    }),
  );
  assert.equal(fx.status, 201);
  assert.equal(
    (
      await call(
        "/tracker/transactions",
        "POST",
        entry({
          kind: "TRANSFER",
          currency: "USD",
          counterparty_owner_id: foreign,
          amount: "10",
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        "/tracker/transactions",
        "POST",
        entry({
          kind: "TRANSFER",
          currency: "USD",
          counterparty_owner_id: dad,
          amount: "10",
          fee: "1",
        }),
      )
    ).status,
    201,
  );
  const buy = entry({
      kind: "BUY",
      market: "US",
      symbol: "AAPL",
      currency: "USD",
      quantity: "2",
      price: "20",
    }),
    split = entry({
      kind: "SPLIT",
      market: "US",
      symbol: "AAPL",
      currency: "USD",
      split_from: "1",
      split_to: "2",
    });
  const batch = await call("/tracker/transactions/bulk", "POST", {
    transactions: [
      entry({
        kind: "DIVIDEND",
        market: "US",
        symbol: "AAPL",
        currency: "USD",
        amount: "10",
        tax: "3",
      }),
      buy,
      split,
      entry({
        kind: "SELL",
        market: "US",
        symbol: "AAPL",
        currency: "USD",
        quantity: "1",
        price: "15",
        fee: "1",
      }),
    ],
  });
  assert.equal(batch.status, 201);
  const state = (await call("/tracker")).data;
  assert.equal(state.positions[0].quantity, "3.00000000");
  assert.equal(state.positions[0].realized, "4.00000000");
  assert.equal(
    state.accounts.find((a) => a.owner_id === dad && a.currency === "USD")
      .balance,
    "10.00000000",
  );
  const broker = {
    version: 0,
    as_of: "2026-01-01",
    cash: { MYR: "570", USD: "80" },
    positions: [{ market: "US", symbol: "AAPL", quantity: "3" }],
    complete: true,
  };
  const match = await call("/tracker/reconciliation", "PUT", broker);
  assert.equal(match.status, 200);
  assert.equal(match.data.comparison.cash_mismatches, 0);
  assert.equal(match.data.comparison.share_mismatches, 0);
  assert.equal(match.data.comparison.estimated, false);
  assert.equal(
    (await call("/tracker/reconciliation", "PUT", broker)).status,
    409,
  );
  assert.equal(
    (await call("/tracker/reconciliation", "GET", null, other)).data.version,
    0,
  );
  const edited = await call(`/tracker/transactions/${fx.data.id}`, "PUT", {
    ...fx.data,
    target_amount: "200",
    version: 1,
  });
  assert.equal(edited.status, 200);
  assert.equal(
    (await call("/tracker/reconciliation")).data.comparison.cash.find(
      (row) => row.currency === "USD",
    ).difference,
    "100.00000000",
  );
  assert.equal(
    (await call(`/tracker/transactions/${fx.data.id}/audit`)).data.length,
    2,
  );
  const before = (await call("/tracker")).data.transactions.length;
  assert.equal(
    (
      await call("/tracker/transactions/bulk", "POST", {
        transactions: [
          entry({
            kind: "FX",
            amount: "10",
            target_currency: "USD",
            target_amount: "2",
          }),
          entry({
            kind: "SELL",
            market: "US",
            symbol: "AAPL",
            currency: "USD",
            quantity: "999",
            price: "20",
          }),
        ],
      })
    ).status,
    400,
  );
  assert.equal((await call("/tracker")).data.transactions.length, before);
});
