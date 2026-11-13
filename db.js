const { Pool, types } = require("pg");
types.setTypeParser(1082, (value) => value);

function createDatabase(env = process.env) {
  const local = env.DB_CLIENT === "sqlite";
  let sqlite, pool;
  if (local) {
    const Database = require("better-sqlite3");
    sqlite = new Database(env.DB_FILE || "tracker.local.db");
    sqlite.pragma("foreign_keys = ON");
  } else {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl:
        env.DB_SSL === "false"
          ? false
          : { rejectUnauthorized: env.DB_SSL_VERIFY !== "false" },
    });
  }
  const queryLocal = async (sql, params = []) => {
    const values = [];
    const rewritten = sql.replace(/\$(\d+)/g, (_, n) => {
      values.push(params[Number(n) - 1]);
      return "?";
    });
    const statement = sqlite.prepare(rewritten);
    if (statement.reader) {
      const rows = statement.all(...values);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: statement.run(...values).changes };
  };
  const db = {
    query: local ? queryLocal : (sql, params) => pool.query(sql, params),
  };
  let queue = Promise.resolve();
  db.transaction = async (userId, action) => {
    const run = async () => {
      const client = local ? db : await pool.connect();
      try {
        await client.query("BEGIN");
        if (!local)
          await client.query("SELECT pg_advisory_xact_lock($1)", [userId]);
        const value = await action(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        if (!local) client.release();
      }
    };
    if (!local) return run();
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
  db.init = async () => {
    const id = local
      ? "INTEGER PRIMARY KEY AUTOINCREMENT"
      : "SERIAL PRIMARY KEY";
    const decimal = local ? "TEXT" : "NUMERIC(28,8)";
    const timestamp = local
      ? "TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      : "TIMESTAMPTZ DEFAULT NOW()";
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (id ${id}, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at ${timestamp})`,
      `CREATE TABLE IF NOT EXISTS holdings (id ${id}, symbol TEXT NOT NULL, quantity REAL NOT NULL, avg_buy_price REAL NOT NULL, user_id INTEGER REFERENCES users(id))`,
      `CREATE TABLE IF NOT EXISTS tracker_owners (id ${id}, user_id INTEGER NOT NULL REFERENCES users(id),
        owner_key TEXT NOT NULL CHECK(owner_key IN ('mine','father')), name TEXT NOT NULL,
        UNIQUE(user_id, owner_key), UNIQUE(id, user_id))`,
      `CREATE TABLE IF NOT EXISTS tracker_transactions (id ${id}, user_id INTEGER NOT NULL REFERENCES users(id),
        owner_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('BUY','SELL','DEPOSIT','WITHDRAWAL','DIVIDEND')),
        occurred_on DATE NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, market TEXT CHECK(market IN ('US','MY')), symbol TEXT,
        currency TEXT NOT NULL CHECK(currency IN ('USD','MYR')), quantity ${decimal} NOT NULL,
        price ${decimal} NOT NULL, fee ${decimal} NOT NULL, amount ${decimal} NOT NULL, fx_rate ${decimal},
        notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, voided INTEGER NOT NULL DEFAULT 0,
        created_at ${timestamp}, FOREIGN KEY(owner_id, user_id) REFERENCES tracker_owners(id, user_id))`,
      "CREATE INDEX IF NOT EXISTS tracker_transaction_history ON tracker_transactions(user_id, occurred_on, sequence, id)",
      `CREATE TABLE IF NOT EXISTS tracker_audit (id ${id}, user_id INTEGER NOT NULL REFERENCES users(id),
        transaction_id INTEGER NOT NULL REFERENCES tracker_transactions(id), action TEXT NOT NULL,
        before_json TEXT, after_json TEXT, created_at ${timestamp})`,
      `CREATE TABLE IF NOT EXISTS tracker_quotes (instrument TEXT PRIMARY KEY, price ${decimal} NOT NULL,
        currency TEXT NOT NULL, quoted_at TEXT NOT NULL, fetched_at TEXT NOT NULL, source TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS tracker_manual_quotes (user_id INTEGER NOT NULL REFERENCES users(id),
        instrument TEXT NOT NULL, price ${decimal} NOT NULL, quoted_at TEXT NOT NULL, PRIMARY KEY(user_id,instrument))`,
      `CREATE TABLE IF NOT EXISTS tracker_funding_snapshots (user_id INTEGER NOT NULL REFERENCES users(id),
        owner_id INTEGER NOT NULL, as_of DATE NOT NULL, amount_myr ${decimal} NOT NULL,
        PRIMARY KEY(user_id,owner_id), FOREIGN KEY(owner_id,user_id) REFERENCES tracker_owners(id,user_id))`,
    ];
    for (const sql of statements) await db.query(sql);
  };
  db.close = async () => (local ? sqlite.close() : pool.end());
  return db;
}
const db = createDatabase();
module.exports = db;
module.exports.createDatabase = createDatabase;
