require("dotenv").config({ quiet: true });
const bcrypt = require("bcrypt");
const db = require("../db");
const { createInterface } = require("node:readline/promises");
async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Usage: npm run create-user -- your@email.com");
  await db.init();
  if (
    Number(
      (await db.query("SELECT COUNT(*) AS count FROM users")).rows[0].count,
    ) > 0
  )
    throw new Error(
      "An account already exists. Use the existing login; this tool does not replace accounts.",
    );
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const password = await readline.question(
    "New local/private account password (visible in terminal): ",
  );
  readline.close();
  if (password.length < 12 || password.length > 72)
    throw new Error("Use a password between 12 and 72 characters.");
  await db.query("INSERT INTO users (email,password_hash) VALUES ($1,$2)", [
    email,
    await bcrypt.hash(password, 12),
  ]);
  console.log("Account created. Public registration remains disabled.");
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
