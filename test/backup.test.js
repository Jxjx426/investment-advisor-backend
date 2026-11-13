process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDatabase } = require("../db");
const { normalize } = require("../lib/accounting");
const { TABLES, snapshot, writeBackup, readBackup, restoreBackup } = require("../lib/backup");
async function database(t) { const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: ":memory:" }); await db.init(); t.after(() => db.close()); return db; }
async function records(db) {
  await db.query("INSERT INTO users(id,email,password_hash) VALUES(7,'private@example.test','test-hash')");
  await db.query("INSERT INTO users(id,email,password_hash) VALUES(8,'other@example.test','other-hash')");
  await db.query("INSERT INTO tracker_owners(id,user_id,owner_key,name) VALUES(9,7,'mine','Mine')");
  const row = normalize({ owner_id: 9, kind: "BUY", occurred_on: "2026-01-01", market: "US", symbol: "TSLA", currency: "USD", quantity: "0.25", price: "300", fee: "1" });
  const fields = Object.keys(row);
  await db.query(`INSERT INTO tracker_transactions(id,user_id,${fields.join(",")}) VALUES(21,7,${fields.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
  await db.query("INSERT INTO tracker_audit(user_id,transaction_id,action,after_json) VALUES(7,21,'CREATE',$1)", [JSON.stringify(row)]);
  await db.query("INSERT INTO tracker_funding_snapshots(user_id,owner_id,as_of,amount_myr) VALUES(7,9,'2026-11-12','6434.00000000')");
  await db.query("INSERT INTO tracker_manual_quotes(user_id,instrument,price,quoted_at) VALUES(7,'MY:1155','9.96','2026-11-12T03:31:00Z')");
  await db.query("INSERT INTO tracker_reconciliations(user_id,version,snapshot_json) VALUES(7,1,'{}')");
}
test("full backup restores every table, original IDs, exact decimals, credentials, audit and snapshots", async t => {
  const source = await database(t), target = await database(t); await records(source);
  const archive = await snapshot(source); await restoreBackup(target, archive);
  for (const table of TABLES) assert.deepEqual((await target.query(`SELECT * FROM ${table}`)).rows, (await source.query(`SELECT * FROM ${table}`)).rows, table);
  const damaged = structuredClone(archive); damaged.payload.tables.users[0].email = "tampered";
  assert.throws(() => readBackup(JSON.stringify(damaged)), /damaged/);
  await assert.rejects(restoreBackup(target, archive), /empty database/);
  assert.equal((await target.query("SELECT COUNT(*) AS count FROM tracker_transactions")).rows[0].count, 1);
});
test("personal export contains only the signed-in account's records and no password hashes", async t => {
  const db = await database(t); await records(db);
  const one = await snapshot(db, 7), other = await snapshot(db, 8);
  assert.equal(one.payload.tables.tracker_transactions.length, 1); assert.equal(other.payload.tables.tracker_transactions.length, 0);
  assert.doesNotMatch(JSON.stringify(one), /test-hash|other-hash|private@example/);
  await assert.rejects(restoreBackup(db, one), /full database backup/);
});
test("compressed disk backups are verified and pre-Phase-3 tables remain backup-compatible", async t => {
  const db = await database(t); await records(db);
  await db.query("DROP TABLE tracker_api_usage"); await db.query("DROP TABLE tracker_research_cache");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tracker-backup-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const saved = await writeBackup(db, directory);
  const archive = readBackup(await fs.readFile(saved.file));
  assert.equal(archive.payload.tables.tracker_transactions.length, 1); assert.deepEqual(archive.payload.tables.tracker_api_usage, []);
  const target = await database(t); await restoreBackup(target, archive);
  assert.equal((await target.query("SELECT id FROM users ORDER BY id")).rows[0].id, 7);
});
