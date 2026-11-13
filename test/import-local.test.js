process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../db");
const { snapshot } = require("../lib/backup");
const { importLocal } = require("../lib/import-local");
const { normalize, FIELDS } = require("../lib/accounting");
async function db(t) {
  const value = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: ":memory:" });
  await value.init();
  t.after(() => value.close());
  return value;
}
async function source(t) {
  const value = await db(t);
  await value.query(
    "INSERT INTO users(id,email,password_hash) VALUES(1,'preview@local.test','public-preview-hash')",
  );
  await value.query(
    "INSERT INTO tracker_owners(id,user_id,owner_key,name) VALUES(1,1,'mine','Mine'),(2,1,'father','Dad')",
  );
  const entry = normalize({
    owner_id: 1,
    kind: "BUY",
    occurred_on: "2026-01-01",
    market: "US",
    symbol: "TSLA",
    currency: "USD",
    quantity: "0.25",
    price: "300",
    fee: "1",
  });
  await value.query(
    `INSERT INTO tracker_transactions(id,user_id,${FIELDS.join(",")}) VALUES(3,1,${FIELDS.map((_, i) => `$${i + 1}`).join(",")})`,
    FIELDS.map((key) => entry[key]),
  );
  await value.query(
    "INSERT INTO tracker_audit(user_id,transaction_id,action,after_json) VALUES(1,3,'CREATE',$1)",
    [JSON.stringify({ id: 3, user_id: 1, ...entry })],
  );
  await value.query(
    "INSERT INTO tracker_funding_snapshots(user_id,owner_id,as_of,amount_myr) VALUES(1,1,'2026-11-12','6434.00000000')",
  );
  return snapshot(value);
}
test("local-to-cloud import is previewed, owner IDs and audit are remapped, credentials and other users are preserved", async (t) => {
  const archive = await source(t),
    target = await db(t);
  await target.query(
    "INSERT INTO users(id,email,password_hash) VALUES(7,'owner@example.test','private-cloud-hash'),(8,'other@example.test','other-hash')",
  );
  await target.query(
    "INSERT INTO holdings(symbol,quantity,avg_buy_price,user_id) VALUES('TSLA',2,100,7),('AAPL',1,80,8)",
  );
  const plan = await importLocal(target, archive, "owner@example.test");
  assert.equal(plan.applied, false);
  assert.equal(
    (await target.query("SELECT COUNT(*) AS count FROM tracker_owners")).rows[0]
      .count,
    0,
  );
  const applied = await importLocal(
    target,
    archive,
    "owner@example.test",
    true,
  );
  assert.equal(applied.applied, true);
  const row = (await target.query("SELECT * FROM tracker_transactions"))
    .rows[0];
  assert.equal(row.user_id, 7);
  assert.equal(row.quantity, "0.25000000");
  assert.equal(row.price, "300.00000000");
  const audit = JSON.parse(
    (await target.query("SELECT after_json FROM tracker_audit")).rows[0]
      .after_json,
  );
  assert.equal(audit.user_id, 7);
  assert.equal(audit.id, row.id);
  assert.equal(audit.owner_id, row.owner_id);
  assert.equal(
    (await target.query("SELECT password_hash FROM users WHERE id=7")).rows[0]
      .password_hash,
    "private-cloud-hash",
  );
  assert.equal(
    (await target.query("SELECT COUNT(*) AS count FROM users")).rows[0].count,
    2,
  );
  assert.equal(
    (await target.query("SELECT COUNT(*) AS count FROM holdings")).rows[0]
      .count,
    2,
  );
  assert.equal(
    (await importLocal(target, archive, "owner@example.test", true))
      .already_imported,
    true,
  );
  await target.query("UPDATE tracker_transactions SET price='999.00000000'");
  await assert.rejects(
    importLocal(target, archive, "owner@example.test", true),
    /different records/,
  );
});
test("local import rolls back records, owners and audit if any source quote is invalid", async (t) => {
  const archive = await source(t),
    target = await db(t);
  await target.query(
    "INSERT INTO users(email,password_hash) VALUES('owner@example.test','private-cloud-hash')",
  );
  archive.payload.tables.tracker_quotes.push({
    instrument: "US:TSLA",
    price: "0",
    quoted_at: "2026-01-01T00:00:00Z",
  });
  await assert.rejects(
    importLocal(target, archive, "owner@example.test", true),
    /Invalid source quote/,
  );
  for (const table of [
    "tracker_transactions",
    "tracker_owners",
    "tracker_audit",
    "tracker_funding_snapshots",
  ])
    assert.equal(
      (await target.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0]
        .count,
      0,
    );
});
