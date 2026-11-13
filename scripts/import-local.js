require("dotenv").config({ quiet: true });
const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("../db");
const { createDatabase } = require("../db");
const { snapshot, writeBackup } = require("../lib/backup");
const { importLocal } = require("../lib/import-local");
async function main() {
  const args = process.argv.slice(2),
    email = args.find((arg) => !arg.startsWith("--"));
  if (!email)
    throw new Error(
      "Usage: npm run import-local -- your-existing-email [--apply]. Default is a dry run.",
    );
  const source = createDatabase({
    DB_CLIENT: "sqlite",
    DB_READ_ONLY: "true",
    DB_FILE: path.resolve(
      __dirname,
      "../../private-records/tracker-preview.db",
    ),
  });
  let archive;
  try {
    archive = await snapshot(source);
  } finally {
    await source.close();
  }
  const apply = args.includes("--apply");
  if (apply)
    await writeBackup(
      db,
      process.env.BACKUP_DIR ||
        path.resolve(__dirname, "../../private-records/backups"),
      30,
      { encryptionKey: process.env.BACKUP_ENCRYPTION_KEY },
    );
  console.log(JSON.stringify(await importLocal(db, archive, email, apply)));
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
