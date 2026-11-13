require("dotenv").config({ quiet: true });
const path = require("node:path");
const db = require("../db");
const { writeBackup } = require("../lib/backup");
async function main() {
  // Do not initialize/migrate the source merely to take a backup.
  const directory =
    process.env.BACKUP_DIR ||
    (process.env.NODE_ENV !== "production"
      ? path.resolve(__dirname, "../../private-records/backups")
      : null);
  const result = await writeBackup(
    db,
    directory,
    Number(process.env.BACKUP_RETENTION || 30),
    {
      encryptionKey: process.env.BACKUP_ENCRYPTION_KEY,
      requireEncryption: process.env.BACKUP_REQUIRE_ENCRYPTION === "true",
    },
  );
  console.log(`Verified backup: ${result.file}`);
}
main()
  .catch(() => {
    console.error(
      "Backup failed. Check database connectivity, schema version and BACKUP_DIR. No database changes were made.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.close());
