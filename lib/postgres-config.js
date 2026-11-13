const fs = require("node:fs");
const path = require("node:path");

function postgresConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("DATABASE_URL must use PostgreSQL.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const insecure =
    env.DB_SSL === "false" ||
    env.DB_SSL_VERIFY === "false" ||
    ["disable", "no-verify"].includes(url.searchParams.get("sslmode")) ||
    ["false", "0"].includes(url.searchParams.get("ssl"));
  if (insecure && (env.NODE_ENV === "production" || !local))
    throw new Error(
      "Remote databases require certificate and hostname verification.",
    );
  if (
    ["sslcert", "sslkey", "uselibpqcompat"].some((key) =>
      url.searchParams.has(key),
    )
  )
    throw new Error(
      "Configure database TLS explicitly; client certificate URL options are not supported.",
    );
  const caFile =
    env.DB_SSL_CA_FILE ||
    url.searchParams.get("sslrootcert") ||
    (/\.(?:pooler\.supabase\.com|supabase\.co)$/.test(url.hostname)
      ? path.join(__dirname, "../certs/supabase-root-2021.crt")
      : null);
  const ca =
    env.DB_SSL_CA?.replace(/\\n/g, "\n") ||
    (caFile ? fs.readFileSync(caFile, "utf8") : undefined);
  // pg lets URL SSL parameters replace the supplied TLS object. Normalize here
  // so an inherited sslmode=require cannot discard our CA or hostname checks.
  for (const key of ["ssl", "sslmode", "sslrootcert"])
    url.searchParams.delete(key);
  return {
    connectionString: url.href,
    ssl: insecure ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 5,
    application_name: "investment-tracker",
  };
}
module.exports = { postgresConfig };
