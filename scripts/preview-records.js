// User's records, local only. The private database and input stay outside Git.
process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const path = require("node:path");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const bcrypt = require("bcrypt");
const { createDatabase } = require("../db");
const { createApp } = require("../index");
const { normalize } = require("../lib/accounting");
async function main() {
  const recordsPath = path.resolve(
    __dirname,
    "../../private-records/reviewed-records.json",
  );
  const dbPath = path.resolve(
    __dirname,
    "../../private-records/tracker-preview.db",
  );
  const draft = JSON.parse(fs.readFileSync(recordsPath, "utf8"));
  const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: dbPath });
  await db.init();
  let user = (
    await db.query("SELECT id FROM users WHERE email=$1", [
      "preview@local.test",
    ])
  ).rows[0];
  if (!user) {
    user = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id",
        ["preview@local.test", await bcrypt.hash("local-preview-only", 10)],
      )
    ).rows[0];
  }
  await db.transaction(user.id, async (client) => {
    for (const [key, name] of [
      ["mine", "Mine"],
      ["father", "Father's"],
    ])
      await client.query(
        "INSERT INTO tracker_owners(user_id,owner_key,name) VALUES($1,$2,$3) ON CONFLICT(user_id,owner_key) DO NOTHING",
        [user.id, key, name],
      );
    const profiles = (
      await client.query("SELECT * FROM tracker_owners WHERE user_id=$1", [
        user.id,
      ])
    ).rows;
    const existing = (
      await client.query(
        "SELECT COUNT(*) AS count FROM tracker_transactions WHERE user_id=$1",
        [user.id],
      )
    ).rows[0];
    if (Number(existing.count) === 0) {
      for (const input of draft.transactions) {
        const owner = profiles.find((row) => row.owner_key === input.owner);
        const row = normalize({
          ...input,
          owner_id: owner.id,
          kind: input.type,
          occurred_on: input.date,
        });
        const fields = Object.keys(row);
        const record = (
          await client.query(
            `INSERT INTO tracker_transactions(user_id,${fields.join(",")}) VALUES(${Array.from({ length: fields.length + 1 }, (_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
            [user.id, ...fields.map((field) => row[field])],
          )
        ).rows[0];
        await client.query(
          "INSERT INTO tracker_audit(user_id,transaction_id,action,after_json) VALUES($1,$2,$3,$4)",
          [user.id, record.id, "CREATE", JSON.stringify(record)],
        );
      }
      for (const profile of profiles)
        await client.query(
          "INSERT INTO tracker_funding_snapshots(user_id,owner_id,as_of,amount_myr) VALUES($1,$2,$3,$4)",
          [
            user.id,
            profile.id,
            "2026-11-12",
            draft.confirmed_funding_totals_myr[profile.owner_key],
          ],
        );
    }
  });
  for (const quote of draft.quote_snapshots || []) {
    const [market, symbol] = quote.instrument.split(":");
    const checked = normalize({
      owner_id: 1,
      kind: "BUY",
      occurred_on: "2020-01-01",
      market,
      symbol,
      currency: quote.currency,
      quantity: "1",
      price: quote.price,
      fee: "0",
    });
    const quotedAt = new Date(quote.quoted_at);
    if (
      !Number.isFinite(quotedAt.getTime()) ||
      quotedAt.getTime() > Date.now() + 60000
    )
      throw new Error("Invalid quote snapshot timestamp.");
    await db.query(
      `INSERT INTO tracker_quotes(instrument,price,currency,quoted_at,fetched_at,source) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(instrument) DO UPDATE SET price=excluded.price,currency=excluded.currency,quoted_at=excluded.quoted_at,fetched_at=excluded.fetched_at,source=excluded.source WHERE excluded.quoted_at > tracker_quotes.quoted_at`,
      [
        quote.instrument,
        checked.price,
        quote.currency,
        quotedAt.toISOString(),
        new Date().toISOString(),
        quote.source,
      ],
    );
  }
  const app = createApp(db, {
    ...process.env,
    JWT_SECRET: randomBytes(32).toString("hex"),
    ENABLE_LEGACY_ROUTES: "false",
    DEMO_MODE: "false",
    LOCAL_RECORDS: "true",
  });
  const server = app.listen(3000, "127.0.0.1", () =>
    console.log(
      "Your records · local preview · http://127.0.0.1:3000\nLogin: preview@local.test / local-preview-only\nPrivate database: " +
        dbPath,
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
