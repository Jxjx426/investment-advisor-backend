// Explicitly isolated, disposable preview. Never connects to DATABASE_URL.
process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { randomBytes } = require("node:crypto");
const bcrypt = require("bcrypt");
const { createDatabase } = require("../db");
const { createApp } = require("../index");
const { normalize } = require("../lib/accounting");
async function main() {
  const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: ":memory:" });
  await db.init();
  await db.query("INSERT INTO users(email,password_hash) VALUES($1,$2)", [
    "demo@local.test",
    await bcrypt.hash("local-preview-only", 10),
  ]);
  for (const [key, name] of [
    ["mine", "Mine"],
    ["father", "Father's"],
  ])
    await db.query(
      "INSERT INTO tracker_owners(user_id,owner_key,name) VALUES($1,$2,$3)",
      [1, key, name],
    );
  const records = [
    {
      owner_id: 1,
      kind: "DEPOSIT",
      occurred_on: "2026-01-01",
      currency: "MYR",
      amount: "6000",
      fee: "0",
    },
    {
      owner_id: 2,
      kind: "DEPOSIT",
      occurred_on: "2026-01-01",
      currency: "MYR",
      amount: "20000",
      fee: "0",
    },
    {
      owner_id: 1,
      kind: "BUY",
      occurred_on: "2026-01-03",
      market: "US",
      symbol: "AAPL",
      currency: "USD",
      quantity: "2",
      price: "200",
      fee: "2",
    },
    {
      owner_id: 1,
      kind: "BUY",
      occurred_on: "2026-01-04",
      market: "MY",
      symbol: "1155",
      currency: "MYR",
      quantity: "200",
      price: "10.5",
      fee: "6",
    },
    {
      owner_id: 2,
      kind: "BUY",
      occurred_on: "2026-01-04",
      market: "US",
      symbol: "AAPL",
      currency: "USD",
      quantity: "5",
      price: "220",
      fee: "3",
    },
    {
      owner_id: 1,
      kind: "SELL",
      occurred_on: "2026-02-01",
      market: "US",
      symbol: "AAPL",
      currency: "USD",
      quantity: "0.5",
      price: "240",
      fee: "1",
    },
    {
      owner_id: 1,
      kind: "DIVIDEND",
      occurred_on: "2026-02-02",
      market: "MY",
      symbol: "1155",
      currency: "MYR",
      amount: "62",
      fee: "0",
    },
  ];
  for (const record of records) {
    const row = normalize(record);
    const fields = Object.keys(row);
    await db.query(
      `INSERT INTO tracker_transactions(user_id,${fields.join(",")}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(",")},$${fields.length + 1})`,
      [1, ...fields.map((f) => row[f])],
    );
  }
  const demoAsOf = new Date().toISOString();
  const quoteService = {
    get: async (instrument) => ({
      instrument,
      price:
        instrument === "US:AAPL"
          ? "250.00000000"
          : instrument === "MY:1155"
            ? "11.00000000"
            : "4.30000000",
      currency: instrument === "US:AAPL" ? "USD" : "MYR",
      status: "manual",
      source: "Demo sample",
      quoted_at: demoAsOf,
    }),
  };
  const app = createApp(
    db,
    {
      JWT_SECRET: randomBytes(32).toString("hex"),
      ENABLE_LEGACY_ROUTES: "false",
      DEMO_MODE: "true",
    },
    quoteService,
  );
  const server = app.listen(3000, "127.0.0.1", () =>
    console.log(
      "DEMO ONLY: http://127.0.0.1:3000 · demo@local.test / local-preview-only",
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(() => db.close().then(() => process.exit(0))),
    );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
