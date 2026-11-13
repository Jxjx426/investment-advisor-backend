# Render + Vercel deployment

Keep the existing two repositories and Supabase database. Deployment order is backend, verify it, then frontend. Do not create a public demo user in production.

## Database and records

The Supabase connection uses the bundled public CA and validates the certificate chain and hostname. TLS verification cannot be disabled for a remote database. URL SSL options are normalized so `sslmode=require` cannot discard the CA.

`npm run migrate` creates and verifies an application backup before applying an atomic PostgreSQL schema migration. All application tables use row-level security and browser roles have no table grants. The server's database owner role accesses records through the authenticated Express API. Original accounts, password hashes and legacy holdings are retained.

`npm run import-local -- your-existing-email` previews the one-time import from the private local SQLite database. Append `--apply` to save it. Owner IDs, transaction IDs and audit references are remapped in one transaction. Existing different cloud records cause an error; identical records are not duplicated. The preview account and its password are never imported. The source database is opened read-only.

On 2026-11-13, certificate verification, the live schema migration and import of the 39 reviewed local records were verified. Existing accounts and legacy holdings were preserved. Brokerage cash reconciliation still requires actual Moomoo figures; missing deposit dates and historical FX remain explicitly estimated.

## Render settings

Use the existing backend service and Supabase `DATABASE_URL`:

- Branch: `main`
- Build: `npm ci`
- Start: `npm start`
- Health check: `/ping`
- Node: 24 (`.node-version`)
- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `TRUST_PROXY=1`
- `JWT_SECRET`: the new random secret in the ignored local `.env`; at least 32 bytes
- `ENABLE_LEGACY_ROUTES=false`, `DEMO_MODE=false`, `LOCAL_RECORDS=false`
- `ALLOWED_ORIGINS=https://investment-advisor-frontend-one.vercel.app`
- Retain existing provider keys. Do not include them in Git, logs or frontend variables.
- `NEWS_API_PRODUCTION_ALLOWED=false` unless the NewsAPI plan permits production.
- `AUTO_BACKUP=false` when using the GitHub backup job. Render's ephemeral filesystem is not durable backup storage.

The renewed JWT secret requires signing in again. It does not change account passwords. If needed, run `npm run reset-password -- your-existing-email` in your own interactive terminal; password input is hidden.

Merge only after settings are ready. Verify `/ping` reports phase 3, unauthenticated `/tracker` returns 401, and the intended account reads its imported records.

## Encrypted daily backups

`.github/workflows/backup.yml` runs daily at 00:15 UTC (08:15 Malaysia time; GitHub schedules may be delayed) and supports manual dispatch. GitHub Actions repository secrets `DATABASE_URL` and `BACKUP_ENCRYPTION_KEY` are configured separately from Render.

The job takes a consistent application snapshot, compresses it, encrypts it with AES-256-GCM, authenticates the ciphertext, and verifies it before upload. Only `.enc` files are uploaded; missing encryption credentials fail the job. Artifacts are retained for 30 days. No plaintext financial records, password hashes or database credentials are committed to either repository.

Recovery key: `C:\Investment-advisor\private-records\backups\cloud-backup.key`, outside Git. Keep a separate private recovery copy. The key is also in the ignored backend `.env`. Losing every copy of the key makes encrypted artifacts unrecoverable.

Download an encrypted artifact, extract its `.enc` file, set `BACKUP_ENCRYPTION_KEY`, and point `DATABASE_URL` or `DB_FILE` at an **empty target** before running:

```text
npm run restore -- path-to-backup.json.gz.enc
```

Restore refuses to replace existing application data. Application backups include accounts, legacy holdings, transactions including voided rows, audit, owners, funding snapshots, reconciliation, manual quotes and caches. They do not back up Supabase-managed Auth/Storage objects, database roles or the entire cluster; this app does not use those objects for its ledger.

After merging the workflow to `main`, manually dispatch it once and verify its encrypted artifact by downloading and restoring it before declaring automatic backups operational. Monitor GitHub Actions failures; a schedule file alone is not proof of a successful backup.

## Frontend

Use the existing Vercel Vite project on `main`. `vercel.json` builds `dist` and sends `/api` to the existing Render API. Remove any obsolete `VITE_API_BASE_URL` override or set it to `/api`. Keep all provider and database keys on the backend. Verify login, both owners, Research and the manual records download after deployment.

## Verification

`npm test` covers accounting, API authorization, isolation, audit, atomic imports, TLS configuration, encrypted recovery, caching and rate limits. CI also runs a PostgreSQL 17 service via `TEST_DATABASE_URL`; tests create uniquely named temporary schemas and remove only those schemas. Migration preservation, rollback, backup restore, sequence recovery and advisory locking were also tested against isolated schemas on the actual Supabase provider.

The frontend has 15 tests and a production build check. A production-mode API smoke test against the migrated database verified 39 records for the intended account, rejection of unauthenticated access and isolation from another account.
