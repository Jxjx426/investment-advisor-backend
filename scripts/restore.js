require("dotenv").config({ quiet: true });
const fs = require("node:fs/promises");
const db = require("../db");
const { readBackup, restoreBackup } = require("../lib/backup");
async function main() {
  if (!process.argv[2]) throw new Error("Usage: npm run restore -- path-to-full-backup.json.gz (target must be empty).");
  const archive = readBackup(await fs.readFile(process.argv[2]));
  await db.init();
  const counts = await restoreBackup(db, archive);
  console.log(`Restored ${counts.tracker_transactions} transactions. All table counts verified.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
