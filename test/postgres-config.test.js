const { test } = require("node:test");
const assert = require("node:assert/strict");
const { X509Certificate } = require("node:crypto");
const { postgresConfig } = require("../lib/postgres-config");
test("Supabase TLS keeps its CA and hostname verification even when the URL includes sslmode", () => {
  const config = postgresConfig({
    DATABASE_URL:
      "postgresql://user:pass@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require&application_name=test",
    NODE_ENV: "production",
  });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(
    new URL(config.connectionString).searchParams.has("sslmode"),
    false,
  );
  const cert = new X509Certificate(config.ssl.ca);
  assert.equal(cert.ca, true);
  assert.equal(
    cert.fingerprint256,
    "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
  );
  assert.equal(
    postgresConfig({ DATABASE_URL: "postgres://user:pass@db.example.test/db" })
      .ssl.ca,
    undefined,
  );
});
test("remote databases cannot disable TLS verification; local isolated tests may disable SSL", () => {
  for (const flag of [{ DB_SSL: "false" }, { DB_SSL_VERIFY: "false" }])
    assert.throws(
      () =>
        postgresConfig({
          DATABASE_URL: "postgres://user:pass@db.example.test/db",
          ...flag,
        }),
      /require certificate/,
    );
  assert.throws(
    () =>
      postgresConfig({
        DATABASE_URL: "postgres://user:pass@localhost/db",
        DB_SSL: "false",
        NODE_ENV: "production",
      }),
    /require certificate/,
  );
  assert.equal(
    postgresConfig({
      DATABASE_URL: "postgres://user:pass@127.0.0.1/db",
      DB_SSL: "false",
    }).ssl,
    false,
  );
  assert.throws(
    () =>
      postgresConfig({
        DATABASE_URL: "postgres://user:pass@db.example.test/db?sslmode=disable",
      }),
    /require certificate/,
  );
});
