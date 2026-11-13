const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gzipSync, gunzipSync } = require("node:zlib");
const TABLES = ["users", "holdings", "tracker_owners", "tracker_transactions", "tracker_audit", "tracker_quotes", "tracker_manual_quotes", "tracker_funding_snapshots", "tracker_reconciliations", "tracker_migrations", "tracker_api_usage", "tracker_research_cache"];
const PRIVATE_TABLES = ["holdings", "tracker_owners", "tracker_transactions", "tracker_audit", "tracker_manual_quotes", "tracker_funding_snapshots", "tracker_reconciliations"];
const digest = payload => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
async function snapshot(db, userId) {
  return db.snapshot(async client => {
    const tables = {};
    const existing = new Set((await client.query(db.kind === "sqlite" ? "SELECT name FROM sqlite_master WHERE type='table'" : "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema()")).rows.map(row => row.name));
    for (const table of userId == null ? TABLES : PRIVATE_TABLES) tables[table] = existing.has(table) ? (await client.query(`SELECT * FROM ${table}${userId == null ? "" : " WHERE user_id=$1"}`, userId == null ? [] : [userId])).rows : [];
    const payload = { format: "investment-tracker", version: 3, kind: userId == null ? "database" : "user-export", created_at: new Date().toISOString(), tables };
    return { payload, sha256: digest(payload) };
  });
}
async function writeBackup(db, directory, retention = 30) {
  if (!directory) throw new Error("Set BACKUP_DIR to a private persistent directory.");
  if (!Number.isSafeInteger(retention) || retention < 1 || retention > 365) throw new Error("BACKUP_RETENTION must be 1–365.");
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const archive = await snapshot(db);
  const file = path.join(root, `tracker-backup-${archive.payload.created_at.replace(/[:.]/g, "-")}.json.gz`);
  await fs.writeFile(file, gzipSync(JSON.stringify(archive)), { flag: "wx", mode: 0o600 });
  // Verify the persisted archive before pruning older files.
  const read = readBackup(await fs.readFile(file));
  if (read.sha256 !== archive.sha256) throw new Error("Backup verification failed.");
  const files = (await fs.readdir(root)).filter(name => /^tracker-backup-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json\.gz$/.test(name)).sort().reverse();
  for (const name of files.slice(retention)) await fs.unlink(path.join(root, name));
  return { file, created_at: archive.payload.created_at, tables: Object.fromEntries(Object.entries(archive.payload.tables).map(([name, rows]) => [name, rows.length])) };
}
function readBackup(buffer) {
  const data = Buffer.isBuffer(buffer) && buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer, { maxOutputLength: 100 * 1024 * 1024 }).toString("utf8") : String(buffer);
  const archive = JSON.parse(data);
  if (archive.payload?.format !== "investment-tracker" || archive.payload?.version !== 3 || archive.sha256 !== digest(archive.payload)) throw new Error("Invalid or damaged tracker backup.");
  return archive;
}
async function restoreBackup(db, archive) {
  const checked = readBackup(JSON.stringify(archive));
  if (checked.payload.kind !== "database" || Object.keys(checked.payload.tables).sort().join() !== [...TABLES].sort().join()) throw new Error("A full database backup is required. CSV and user exports cannot replace a database.");
  const columns = Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await db.columns(table)])));
  for (const [table, rows] of Object.entries(checked.payload.tables)) {
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || !Object.keys(row).length || Object.keys(row).some(key => !columns[table].includes(key)))) throw new Error(`Incompatible backup table: ${table}.`);
  }
  return db.transaction(-733002, async client => {
    for (const table of TABLES.filter(table => table !== "tracker_migrations")) if (Number((await client.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count)) throw new Error("Restore requires an empty database. Existing data has not been replaced.");
    await client.query("DELETE FROM tracker_migrations");
    for (const table of TABLES) {
      for (const row of checked.payload.tables[table]) {
        const fields = Object.keys(row);
        await client.query(`INSERT INTO ${table}(${fields.join(",")}) VALUES(${fields.map((_, index) => `$${index + 1}`).join(",")})`, fields.map(key => row[key]));
      }
      if (db.kind === "postgres" && columns[table].includes("id")) await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}),1), EXISTS(SELECT 1 FROM ${table}))`);
    }
    return Object.fromEntries(TABLES.map(table => [table, checked.payload.tables[table].length]));
  });
}
function startBackupScheduler(db, env = process.env, log = console) {
  if (env.AUTO_BACKUP !== "true") return { stop() {} };
  if (!env.BACKUP_DIR) throw new Error("AUTO_BACKUP needs BACKUP_DIR on persistent storage.");
  const hours = Number(env.BACKUP_INTERVAL_HOURS || 24);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error("BACKUP_INTERVAL_HOURS must be 1–168.");
  let running = null;
  const run = () => {
    if (running) return running;
    running = writeBackup(db, env.BACKUP_DIR, Number(env.BACKUP_RETENTION || 30)).then(() => log.info("Database backup verified.")).catch(() => log.error("Database backup failed. Check private storage and permissions.")).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(run, hours * 3600000); timer.unref();
  void run();
  return { async stop() { clearInterval(timer); await running; } };
}
module.exports = { TABLES, snapshot, writeBackup, readBackup, restoreBackup, startBackupScheduler };
