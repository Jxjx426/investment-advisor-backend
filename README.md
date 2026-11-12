# My Investment Tracker - Phase 1

Existing Express/PostgreSQL app rebuilt around an owner-specific transaction ledger. Work is on `rebuild/phase-1-tracker`; nothing has been deployed and the cloud database has not been migrated by this rebuild session.

## Run a disposable preview

```powershell
cd C:\Investment-advisor\Backend
npm run demo
```

In a second terminal:

```powershell
cd C:\Investment-advisor\Frontend
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173`. Demo login: `demo@local.test` / `local-preview-only`.
Demo records and prices are illustrative, clearly labelled, and stored only in memory. Restarting the demo discards them. It never connects to `DATABASE_URL`.

## Use your private database

Keep your existing `.env` and existing login. New settings are documented in `.env.example`. Startup runs additive `CREATE TABLE IF NOT EXISTS` statements; existing `users` and `holdings` rows are retained. Tracker data lives in separate `tracker_*` tables. Legacy aggregate holdings are not converted into invented trades or assigned to an owner automatically.

Run `npm start` only against the database you intend to use. For an isolated persistent local database, set `DB_CLIENT=sqlite` and `DB_FILE=tracker.local.db` before starting. For PostgreSQL, use `DATABASE_URL`. TLS certificate verification is enabled by default; use the database provider's trusted CA configuration. `HOST` defaults to loopback; managed hosting may require `HOST=0.0.0.0`.

Public registration is disabled. If the chosen database has no account, run `npm run create-user -- your@email.com`. The script asks for a password in the terminal and refuses to replace an existing account. Do not use the public demo password for private records. The normal login remains valid for seven days. All tracker endpoints verify the signed token and the account, and scope data to that user.

## Accounting contract

- Two virtual owners, `mine` and `father`, are created for the signed-in account. Combined views sum their results; they never share a cost basis.
- Supported entries: BUY, SELL, DEPOSIT, WITHDRAWAL and basic DIVIDEND. Dividends were brought forward from Phase 2 to represent the four distributions confirmed in the supplied records. `amount` is gross dividend if tax is known; `fee` records withholding/costs. A cash-received amount with unknown withholding can be entered with a note rather than inventing tax history.
- Amounts, prices, quantities and fees use eight-place fixed-point arithmetic. PostgreSQL stores exact NUMERIC values, SQLite stores decimal text, and API calculations return decimal strings. UI totals convert these for display only.
- Purchases add quantity times price plus exact fee to cost. A partial sale allocates weighted cost in proportion to shares sold. Sale fees reduce proceeds. Final sales remove all remaining cost, leaving closed-position realized profit in history.
- Replay order is calendar date, explicit same-day sequence, then record ID. Corrections and deletes replay the entire history and reject overselling. Deletes are soft deletes. Every mutation writes before/after audit records in the same transaction.
- Mutations acquire a per-user PostgreSQL advisory transaction lock; SQLite mutations are serialized. Version checks prevent stale edits. Bulk imports validate the entire batch and commit atomically. Duplicate fingerprints require explicit confirmation.
- Currency ledgers remain separate. Deposits minus withdrawals are contributions, never trading profit. Missing historical FX stays missing. At the user's request, current USD/MYR converts the native cash ledgers into an estimated MYR cash total; these estimates are visibly labelled. No historical exchanges are generated. Exact brokerage cash reconciliation requires actual exchange records in Phase 2.
- Negative currency cash is permitted while historical funding is incomplete. It is visible and explained; this permits loading trades before deposits.

## Market data

US prices reuse Finnhub; USD/MYR and Bursa prices use Twelve Data. The cache persists the last good quote, deduplicates concurrent requests, limits refresh attempts to once per instrument per five minutes, and times out network calls. Prices over twenty minutes old or failed refreshes are labelled stale, including market closures. Missing prices remain null and make affected totals unavailable; they never become zero.

Verified with the existing keys during this rebuild: US and USD/MYR requests succeed; Bursa `1155` returns a provider response requiring a Pro/Venture plan. The UI therefore supports per-user manual prices with source and timestamp. A newer valid automatic quote supersedes a manual quote. No provider subscription was changed.

Provider references: [Finnhub quote API](https://finnhub.io/docs/api/quote), [Twelve Data quotes](https://twelvedata.com/docs/market-data/quote), [Twelve Data exchange rates](https://twelvedata.com/docs/currencies/exchange-rate).

Existing chart/news code remains in the repository. Legacy routes are disabled by default and can be mounted with `ENABLE_LEGACY_ROUTES=true`; the new frontend does not call them. Full research reconnection, provider usage controls, deployment and backups remain Phase 3 work.

## Records and bulk entry

Trades -> Bulk entry accepts pasted CSV/TSV, local CSV/TSV/text, or a reviewed JSON draft. Review is read-only; saving is a separate action. Up to 500 records per batch. Export CSV downloads the selected owner's complete active transaction history; audit history stays in the database. CSV export is a manual records export, not a full database backup.

Columns: `owner,date,type,market,symbol,currency,quantity,price,fee,amount,fx_rate,sequence,notes`. Owners use `mine`/`father`, dates use YYYY-MM-DD, fees and prices are positive, market is US/MY, and `fx_rate` means MYR per USD only when actually known. Use Bursa code `1155` for Maybank; the code remains a string, preserving leading zeroes for other stocks.

The private draft at `C:\Investment-advisor\private-records\reviewed-records.json` is outside both Git repositories. It contains 39 PDF records, including the confirmed GOOG fee correction, four cash distributions, and separate funding totals. No deposit dates or historical FX have been invented. No real records have been imported into a database. Funding dates and the PDF's inconsistent bottom total remain to be reconciled.

## Validation

`npm test` runs isolated in-memory SQLite API tests and accounting tests, without the cloud database. Tests cover fee-aware weighted averages, partial and full sales, fractional shares, owner isolation, dividends, cash, missing historical FX, chronological replay, input validation, authentication, atomic import rollback, duplicates, version conflicts, audit, manual prices and quote failures. HTTP tests need loopback networking in restricted environments.

The frontend has `npm test` and `npm run build`. Desktop and 390px mobile layouts, login, bulk preview and saved corrections were also checked in the browser. PostgreSQL migration and cloud deployment have not been executed against the live database.

## Remaining phases

Phase 2: actual currency conversions, transfers between owners, stock splits, opening balances, dedicated tax records and brokerage reconciliation. Phase 3: chart/news/sentiment integration, deployment, automated backups and final hardening.
