require("dotenv").config({ quiet: true });
const path = require("node:path");
const db = require("../db");
const { snapshot, writeBackup } = require("../lib/backup");
async function main() {
  const root =
    process.env.BACKUP_DIR ||
    path.resolve(__dirname, "../../private-records/backups");
  const options = {
    encryptionKey: process.env.BACKUP_ENCRYPTION_KEY,
    requireEncryption: process.env.BACKUP_REQUIRE_ENCRYPTION === "true",
  };
  const before = await snapshot(db);
  const backup = await writeBackup(db, root, 30, options);
  await db.init();
  const after = await snapshot(db);
  for (const table of ["users", "holdings"])
    if (
      JSON.stringify(before.payload.tables[table]) !==
      JSON.stringify(after.payload.tables[table])
    )
      throw new Error(
        `Legacy ${table} verification failed. Retain the pre-migration backup for investigation.`,
      );
  console.log(
    JSON.stringify({
      migrated: true,
      backup: backup.file,
      users_preserved: after.payload.tables.users.length,
      legacy_holdings_preserved: after.payload.tables.holdings.length,
    }),
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
