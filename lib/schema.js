const { KINDS } = require("./accounting");
const extras = {
  counterparty_owner_id: "INTEGER",
  target_currency: "TEXT CHECK(target_currency IN ('USD','MYR'))",
  target_amount: null,
  tax: null,
  split_from: null,
  split_to: null,
  fx_estimated: "INTEGER NOT NULL DEFAULT 0 CHECK(fx_estimated IN (0,1))",
};
function extraColumns(decimal) {
  return Object.entries(extras).map(
    ([name, type]) =>
      `${name} ${type || `${decimal} NOT NULL DEFAULT '0.00000000'`}`,
  );
}
function transactionTable(name, id, decimal, timestamp) {
  return `CREATE TABLE IF NOT EXISTS ${name}(id ${id},user_id INTEGER NOT NULL REFERENCES users(id),owner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CONSTRAINT tracker_transactions_kind_check CHECK(kind IN (${KINDS.map((kind) => `'${kind}'`).join(",")})),occurred_on DATE NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,
  market TEXT CHECK(market IN ('US','MY')),symbol TEXT,currency TEXT NOT NULL CHECK(currency IN ('USD','MYR')),quantity ${decimal} NOT NULL,price ${decimal} NOT NULL,fee ${decimal} NOT NULL,amount ${decimal} NOT NULL,fx_rate ${decimal},notes TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,voided INTEGER NOT NULL DEFAULT 0,created_at ${timestamp},${extraColumns(decimal).join(",")},
  FOREIGN KEY(owner_id,user_id) REFERENCES tracker_owners(id,user_id),CONSTRAINT tracker_transactions_counterparty_fk FOREIGN KEY(counterparty_owner_id,user_id) REFERENCES tracker_owners(id,user_id))`;
}
async function migrate(db, sqlite, pool, types) {
  if (sqlite) {
    const definition = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='tracker_transactions'",
      )
      .get().sql;
    const columns = sqlite
      .prepare("PRAGMA table_info(tracker_transactions)")
      .all()
      .map((row) => row.name);
    if (
      !columns.includes("target_currency") ||
      !definition.includes("'OPENING_CASH'")
    ) {
      if (sqlite.name !== ":memory:") {
        const backupPath = `${sqlite.name}.phase1-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
        await sqlite.backup(backupPath);
      }
      sqlite.pragma("foreign_keys = OFF");
      try {
        sqlite.exec("BEGIN IMMEDIATE");
        sqlite.exec(
          transactionTable(
            "tracker_transactions_phase2",
            types.id,
            types.decimal,
            types.timestamp,
          ),
        );
        sqlite.exec(
          `INSERT INTO tracker_transactions_phase2(${columns.join(",")}) SELECT ${columns.join(",")} FROM tracker_transactions`,
        );
        sqlite.exec("DROP TABLE tracker_transactions");
        sqlite.exec(
          "ALTER TABLE tracker_transactions_phase2 RENAME TO tracker_transactions",
        );
        sqlite.exec(
          "CREATE INDEX tracker_transaction_history ON tracker_transactions(user_id,occurred_on,sequence,id)",
        );
        if (sqlite.pragma("foreign_key_check").length)
          throw new Error("Migration foreign-key validation failed.");
        sqlite.exec("COMMIT");
      } catch (error) {
        if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        sqlite.pragma("foreign_keys = ON");
      }
    }
    await db.query(
      "INSERT INTO tracker_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING",
      [2],
    );
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [1342177282]);
      if (
        !(
          await client.query(
            "SELECT version FROM tracker_migrations WHERE version=2",
          )
        ).rowCount
      ) {
        for (const column of extraColumns(types.decimal))
          await client.query(
            `ALTER TABLE tracker_transactions ADD COLUMN IF NOT EXISTS ${column}`,
          );
        await client.query(
          "ALTER TABLE tracker_transactions DROP CONSTRAINT IF EXISTS tracker_transactions_kind_check",
        );
        await client.query(
          `ALTER TABLE tracker_transactions ADD CONSTRAINT tracker_transactions_kind_check CHECK(kind IN (${KINDS.map((kind) => `'${kind}'`).join(",")}))`,
        );
        const existing = await client.query(
          "SELECT 1 FROM pg_constraint WHERE conname='tracker_transactions_counterparty_fk' AND conrelid='tracker_transactions'::regclass",
        );
        if (!existing.rowCount)
          await client.query(
            "ALTER TABLE tracker_transactions ADD CONSTRAINT tracker_transactions_counterparty_fk FOREIGN KEY(counterparty_owner_id,user_id) REFERENCES tracker_owners(id,user_id)",
          );
        await client.query(
          "INSERT INTO tracker_migrations(version) VALUES($1)",
          [2],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
module.exports = { transactionTable, migrate };
