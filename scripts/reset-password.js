require("dotenv").config({ quiet: true });
const { Writable } = require("node:stream");
const { createInterface } = require("node:readline/promises");
const bcrypt = require("bcrypt");
const db = require("../db");
async function main() {
  if (!process.stdin.isTTY)
    throw new Error(
      "Run this command in your own interactive terminal. Passwords are never read from chat or command arguments.",
    );
  const email = process.argv[2]?.trim().toLowerCase();
  const users = (
    await db.query(
      email
        ? "SELECT id,email FROM users WHERE email=$1"
        : "SELECT id,email FROM users",
      email ? [email] : [],
    )
  ).rows;
  if (users.length !== 1)
    throw new Error(
      "Specify your account: npm run reset-password -- your@email.com",
    );
  const output = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  let password, confirmation;
  try {
    process.stdout.write("New password (hidden): ");
    password = await reader.question("");
    process.stdout.write("\nRepeat password (hidden): ");
    confirmation = await reader.question("");
    process.stdout.write("\n");
  } finally {
    reader.close();
  }
  if (password !== confirmation)
    throw new Error("Passwords do not match. No changes made.");
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72)
    throw new Error(
      "Use at least 12 characters and at most 72 UTF-8 bytes. No changes made.",
    );
  await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
    await bcrypt.hash(password, 12),
    users[0].id,
  ]);
  console.log(
    "Password updated for " +
      users[0].email +
      ". Sign in with your new password.",
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
