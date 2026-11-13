process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const { createDatabase } = require("../db");
const { postgresConfig } = require("../lib/postgres-config");
const { snapshot, restoreBackup } = require("../lib/backup");
const { APP_TABLES } = require("../lib/schema");
const enabled = !!process.env.TEST_DATABASE_URL;
async function fixture(t, suffix) {
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
  delete env.DB_CLIENT;
  const admin = new Pool(postgresConfig(env));
  const schema = `tracker_verify_${randomBytes(6).toString("hex")}_${suffix}`;
  if (!/^tracker_verify_[a-f0-9]{12}_[a-z]+$/.test(schema))
    throw new Error("Unsafe verification schema.");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(env.DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = createDatabase({ ...env, DATABASE_URL: url.href });
  t.after(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  return { db, schema };
}
async function oldSchema(db, invalid = false) {
  await db.query(`CREATE TABLE users(id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE tracker_owners(id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),owner_key TEXT,name TEXT,UNIQUE(user_id,owner_key),UNIQUE(id,user_id));
    CREATE TABLE tracker_transactions(id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),owner_id INTEGER NOT NULL,kind TEXT NOT NULL ${invalid ? "" : "CHECK(kind IN ('BUY','SELL','DIVIDEND','DEPOSIT','WITHDRAWAL'))"},occurred_on DATE NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,market TEXT,symbol TEXT,currency TEXT NOT NULL,quantity NUMERIC(28,8) NOT NULL,price NUMERIC(28,8) NOT NULL,fee NUMERIC(28,8) NOT NULL,amount NUMERIC(28,8) NOT NULL,fx_rate NUMERIC(28,8),notes TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,voided INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ DEFAULT NOW(),FOREIGN KEY(owner_id,user_id) REFERENCES tracker_owners(id,user_id));
    INSERT INTO users(id,email,password_hash) VALUES(4,'migration@example.test','fixture-hash');
    INSERT INTO tracker_owners(id,user_id,owner_key,name) VALUES(5,4,'mine','Mine');`);
  await db.query(
    "INSERT INTO tracker_transactions(id,user_id,owner_id,kind,occurred_on,market,symbol,currency,quantity,price,fee,amount) VALUES(7,4,5,$1,'2026-01-01','US','TSLA','USD','0.25','300','1','0')",
    [invalid ? "INVALID" : "BUY"],
  );
}
test(
  "PostgreSQL migrates old records atomically, enables privacy controls and restores exact IDs/decimals",
  { skip: !enabled },
  async (t) => {
    const { db, schema } = await fixture(t, "source"),
      target = (await fixture(t, "restore")).db;
    await oldSchema(db);
    const before = await snapshot(db);
    await db.init();
    await db.init();
    const row = (
      await db.query("SELECT * FROM tracker_transactions WHERE id=7")
    ).rows[0];
    assert.equal(row.quantity, "0.25000000");
    assert.equal(row.price, "300.00000000");
    assert.equal(row.tax, "0.00000000");
    assert.equal(row.occurred_on, "2026-01-01");
    const tables = (
      await db.query(
        "SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname=$1 AND relkind='r'",
        [schema],
      )
    ).rows;
    for (const table of APP_TABLES)
      assert.equal(
        tables.find((row) => row.relname === table)?.relrowsecurity,
        true,
        table,
      );
    assert.deepEqual(
      (
        await db.query(
          "SELECT version FROM tracker_migrations ORDER BY version",
        )
      ).rows.map((row) => row.version),
      [2, 3],
    );
    await target.init();
    await restoreBackup(target, before);
    await target.init();
    assert.equal(
      (await target.query("SELECT id,quantity FROM tracker_transactions"))
        .rows[0].id,
      7,
    );
    assert.equal(
      (
        await target.query(
          "INSERT INTO users(email,password_hash) VALUES('after@example.test','fixture-hash') RETURNING id",
        )
      ).rows[0].id,
      5,
    );
    await db.query(
      "INSERT INTO tracker_transactions(user_id,owner_id,kind,occurred_on,currency,quantity,price,fee,amount,target_currency,target_amount) VALUES(4,5,'FX','2026-02-01','MYR','0','0','0','43','USD','10')",
    );
    assert.equal(
      Number(
        (await db.query("SELECT COUNT(*) AS count FROM tracker_transactions"))
          .rows[0].count,
      ),
      2,
    );
  },
);
test(
  "PostgreSQL failed migration rolls back all new tables and leaves original records intact",
  { skip: !enabled },
  async (t) => {
    const { db } = await fixture(t, "rollback");
    await oldSchema(db, true);
    await assert.rejects(db.init(), /check constraint/);
    assert.equal(
      (await db.query("SELECT kind FROM tracker_transactions WHERE id=7"))
        .rows[0].kind,
      "INVALID",
    );
    assert.equal(
      (
        await db.query(
          "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='tracker_audit'",
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (await db.columns("tracker_transactions")).includes("tax"),
      false,
    );
  },
);
test(
  "PostgreSQL per-user advisory locks serialize concurrent updates",
  { skip: !enabled },
  async (t) => {
    const { db } = await fixture(t, "locking");
    await db.init();
    await db.query(
      "INSERT INTO tracker_api_usage(provider,window_key,calls) VALUES('test','counter',0)",
    );
    await Promise.all(
      Array.from({ length: 4 }, () =>
        db.transaction(912345, async (client) => {
          const value = (
            await client.query(
              "SELECT calls FROM tracker_api_usage WHERE provider='test' AND window_key='counter'",
            )
          ).rows[0].calls;
          await client.query("SELECT pg_sleep(0.03)");
          await client.query(
            "UPDATE tracker_api_usage SET calls=$1 WHERE provider='test' AND window_key='counter'",
            [value + 1],
          );
        }),
      ),
    );
    assert.equal(
      (
        await db.query(
          "SELECT calls FROM tracker_api_usage WHERE provider='test'",
        )
      ).rows[0].calls,
      4,
    );
  },
);
