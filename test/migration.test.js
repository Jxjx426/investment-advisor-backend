process.env.DB_CLIENT = "sqlite";
process.env.DB_FILE = ":memory:";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const Database = require("better-sqlite3");
const { createDatabase } = require("../db");
test("Phase 1 file migration preserves IDs, audit references and records, with a usable backup", async () => {
  const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "tracker-migration-"),
    ),
    file = path.join(directory, "old.db");
  const old = new Database(file);
  old.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,password_hash TEXT);
    CREATE TABLE tracker_owners(id INTEGER PRIMARY KEY,user_id INTEGER,owner_key TEXT,name TEXT,UNIQUE(user_id,owner_key),UNIQUE(id,user_id));
    CREATE TABLE tracker_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),owner_id INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('BUY','SELL','DEPOSIT','WITHDRAWAL','DIVIDEND')),occurred_on DATE NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,market TEXT,symbol TEXT,currency TEXT NOT NULL,quantity TEXT NOT NULL,price TEXT NOT NULL,fee TEXT NOT NULL,amount TEXT NOT NULL,fx_rate TEXT,notes TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,voided INTEGER NOT NULL DEFAULT 0,created_at TEXT,FOREIGN KEY(owner_id,user_id) REFERENCES tracker_owners(id,user_id));
    CREATE TABLE tracker_audit(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),transaction_id INTEGER REFERENCES tracker_transactions(id),action TEXT,before_json TEXT,after_json TEXT,created_at TEXT);
    INSERT INTO users VALUES(1,'private@example.test','not-a-real-hash');INSERT INTO tracker_owners VALUES(1,1,'mine','Mine');
    INSERT INTO tracker_transactions(id,user_id,owner_id,kind,occurred_on,market,symbol,currency,quantity,price,fee,amount) VALUES(7,1,1,'BUY','2026-01-01','US','AAPL','USD','2','10','1','0');
    INSERT INTO tracker_audit VALUES(4,1,7,'CREATE',NULL,'{}','2026-01-01T00:00:00Z');`);
  old.close();
  const db = createDatabase({ DB_CLIENT: "sqlite", DB_FILE: file });
  try {
    await db.init();
    const record = (
      await db.query("SELECT * FROM tracker_transactions WHERE id=$1", [7])
    ).rows[0];
    assert.equal(record.symbol, "AAPL");
    assert.equal(record.tax, "0.00000000");
    assert.equal(
      (await db.query("SELECT transaction_id FROM tracker_audit")).rows[0]
        .transaction_id,
      7,
    );
    assert.equal((await db.query("PRAGMA foreign_key_check")).rows.length, 0);
    const backups = fs
      .readdirSync(directory)
      .filter((name) => name.includes("phase1-backup"));
    assert.equal(backups.length, 1);
    const backup = new Database(path.join(directory, backups[0]), {
      readonly: true,
    });
    assert.equal(
      backup.prepare("SELECT COUNT(*) AS count FROM tracker_transactions").get()
        .count,
      1,
    );
    backup.close();
    await db.init();
    assert.equal(
      fs.readdirSync(directory).filter((name) => name.includes("phase1-backup"))
        .length,
      1,
    );
    await db.query(
      "INSERT INTO tracker_transactions(user_id,owner_id,kind,occurred_on,currency,quantity,price,fee,amount,target_currency,target_amount) VALUES(1,1,'FX','2026-01-02','MYR','0','0','0','43','USD','10')",
    );
    assert.equal(
      (await db.query("SELECT COUNT(*) AS count FROM tracker_transactions"))
        .rows[0].count,
      2,
    );
  } finally {
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
