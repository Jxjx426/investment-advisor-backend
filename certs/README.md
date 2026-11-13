# Supabase database root CA

`supabase-root-2021.crt` is a public certificate, not a private key.

- Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
- Subject: Supabase Root 2021 CA, Supabase Inc
- SHA-256 fingerprint: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`
- Expires: 2031-04-26 10:56:53 UTC

The database adapter applies it only to Supabase database/pooler hostnames.
Certificate-chain and hostname validation remain enabled. Other providers use
the system trust store or an explicit `DB_SSL_CA_FILE` / `DB_SSL_CA`.

See [Supabase SSL guidance](https://supabase.com/docs/guides/platform/ssl-enforcement)
and [node-postgres TLS options](https://node-postgres.com/features/ssl).
