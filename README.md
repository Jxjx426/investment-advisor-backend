# My Investment Tracker - Phase 2

Existing Express/PostgreSQL app rebuilt around an owner-specific transaction ledger. Phase 2 work is on `rebuild/phase-2-records`, based on the committed Phase 1 rebuild. Nothing has been deployed and the cloud database has not been migrated by this rebuild session.

## Phase 2

- **Exchange:** enter source currency/amount and the amount actually received. Fees debit the source currency. Both cash legs belong to one owner and neither creates a contribution or trading profit. “Use current rate” is available as an explicit estimate and remains flagged in the record.
- **Transfer:** move cash between Mine and Dad. The receiving owner's history includes the incoming leg. External contributions remain unchanged; net transfers appear separately. Corrections and deletes affect both legs atomically.
- **Dividends/tax:** record gross dividend, withholding tax and other fees separately. Dedicated TAX records support later tax payments. Existing dividends are retained without inventing missing withholding.
- **Splits:** use old:new share ratios, including reverse splits. Total cost remains unchanged. Unsupported fractions smaller than eight decimal places are rejected; cash in lieu is not generated automatically.
- **Opening balances:** OPENING_CASH accepts zero or positive native cash; OPENING_POSITION accepts shares and exact total cost. Opening shares do not spend cash, and opening cash is not a deposit. These entries must precede the relevant history. Explicit opening balances prevent the prior capital snapshot from being added to cash twice; historical realized P/L before the opening date remains unknown.
- **Reconcile:** Cash -> Reconcile compares the combined ledger with manually entered Moomoo balances and share quantities at a chosen date. Blank broker values stay unknown. Only an explicit “All broker holdings listed” selection treats omitted stocks as zero. Broker-only stocks can be added. Cash comparison rounds differences to cents; shares retain eight decimals. Estimated cash never becomes an exact matched status. Saved comparisons retain prior versions and recalculate after transaction corrections.
- **Import/export:** the original columns remain valid. Optional new columns are `to_owner,target_currency,target_amount,tax,split_from,split_to,fx_estimated`. Receiving owners use `mine`/`father`; `fx_estimated` is 0/1. One row represents an entire exchange or transfer.

The supplied 39 records remain intact. Historical exchange/deposit dates and actual Moomoo snapshots are still not supplied; no synthetic exchanges, tax payments, splits or broker balances have been inserted into the real records.

### Schema upgrade

The local SQLite preview creates a consistent `.phase1-backup-<timestamp>.db` beside its private database before rebuilding the transaction table. IDs, dates, audit foreign keys and prior values are preserved; repeated startup is idempotent. The upgrade is verified with a Phase 1 file fixture and was applied only to the local preview. PostgreSQL startup includes a transactional, versioned upgrade with an advisory lock; it has not been executed against the cloud database.

## Run a disposable preview

To open your real records with both servers from one terminal, run `npm run preview` in `C:\Investment-advisor\Backend`, then open `http://127.0.0.1:5173`. Login: `preview@local.test` / `local-preview-only`. Ctrl+C stops both local servers. The standalone commands below remain available.

For your imported records instead of demo data, run `npm run preview-records` in the backend. It reads the private reviewed JSON and creates `C:\Investment-advisor\private-records\tracker-preview.db`, outside Git. Login: `preview@local.test` / `local-preview-only`. Existing imported entries are retained on restart. The server binds only to loopback and never connects to your cloud database. Stock/FX quotes use the existing API keys.

The supplied capital totals are stored as contribution snapshots dated to the record-review date, without creating fictional deposits. Actual dated contributions through that snapshot date are deducted from its adjustment to prevent double counting. Later deposits increase capital normally. Historical running cash stays unavailable where deposit dates are unknown. Missing actual FX prevents an unsupported adjustment. This remains an estimate until reconciliation.

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

Keep your existing `.env` and existing login. New settings are documented in `.env.example`. Startup creates missing tables and applies the versioned Phase 2 transaction-schema upgrade described above. Existing `users` and `holdings` rows are retained. Tracker data lives in separate `tracker_*` tables. Legacy aggregate holdings are not converted into invented trades or assigned to an owner automatically.

Run `npm start` only against the database you intend to use. For an isolated persistent local database, set `DB_CLIENT=sqlite` and `DB_FILE=tracker.local.db` before starting. For PostgreSQL, use `DATABASE_URL`. TLS certificate verification is enabled by default; use the database provider's trusted CA configuration. `HOST` defaults to loopback; managed hosting may require `HOST=0.0.0.0`.

Public registration is disabled. If the chosen database has no account, run `npm run create-user -- your@email.com`. The script asks for a password in the terminal and refuses to replace an existing account. Do not use the public demo password for private records. The normal login remains valid for seven days. All tracker endpoints verify the signed token and the account, and scope data to that user.

If you forgot the original account password, run `npm run reset-password` in your own interactive terminal. It uses the database configured by `.env`, selects the only account (or requires an email argument if there is more than one), asks twice for a hidden new password and updates the bcrypt hash. No password goes in chat, shell arguments or logs. The rebuild has not executed this command against the cloud database.

## Accounting contract

- Two virtual owners, `mine` and `father`, are created for the signed-in account. Combined views sum their results; they never share a cost basis.
- Supported entries: BUY, SELL, DEPOSIT, WITHDRAWAL, DIVIDEND, FX, TRANSFER, SPLIT, OPENING_CASH, OPENING_POSITION and TAX. `tax` is the explicitly known dividend withholding; `fee` records other costs. Legacy dividend fees are retained unchanged. A cash-received dividend with unknown withholding can keep its source note rather than inventing gross or tax history.
- Amounts, prices, quantities and fees use eight-place fixed-point arithmetic. PostgreSQL stores exact NUMERIC values, SQLite stores decimal text, and API calculations return decimal strings. UI totals convert these for display only.
- Purchases add quantity times price plus exact fee to cost. A partial sale allocates weighted cost in proportion to shares sold. Sale fees reduce proceeds. Final sales remove all remaining cost, leaving closed-position realized profit in history.
- Replay order is calendar date, explicit same-day sequence, then record ID. Corrections and deletes replay the entire history and reject overselling. Deletes are soft deletes. Every mutation writes before/after audit records in the same transaction.
- Mutations acquire a per-user PostgreSQL advisory transaction lock; SQLite mutations are serialized. Version checks prevent stale edits. Bulk imports validate the entire batch and commit atomically. Duplicate fingerprints require explicit confirmation.
- Currency ledgers remain separate. Deposits minus withdrawals are external contributions, never trading profit. Missing historical FX stays missing. At the user's request, current USD/MYR converts native ledgers for display. Explicitly estimated exchange entries, incomplete funding snapshots and missing opening cash are flagged. Exact exchanges are not labelled estimates merely because display currency uses current FX. No historical exchanges are generated.
- Negative currency cash is permitted while historical funding is incomplete. It is visible and explained; this permits loading trades before deposits.

## Market data

US prices reuse Finnhub; USD/MYR and Bursa prices use Twelve Data. The cache persists the last good quote, deduplicates concurrent requests, limits refresh attempts to once per instrument per five minutes, and times out network calls. Prices over twenty minutes old or failed refreshes are labelled stale, including market closures. Missing prices remain null and make affected totals unavailable; they never become zero.

Verified with the existing keys during this rebuild: US and USD/MYR requests succeed; Bursa `1155` returns a provider response requiring a Pro/Venture plan. The UI therefore supports per-user manual prices with source and timestamp. A newer valid automatic quote supersedes a manual quote. No provider subscription was changed.

Provider references: [Finnhub quote API](https://finnhub.io/docs/api/quote), [Twelve Data quotes](https://twelvedata.com/docs/market-data/quote), [Twelve Data exchange rates](https://twelvedata.com/docs/currencies/exchange-rate).

Existing chart/news code remains in the repository. Legacy routes are disabled by default and can be mounted with `ENABLE_LEGACY_ROUTES=true`; the new frontend does not call them. Full research reconnection, provider usage controls, deployment and backups remain Phase 3 work.

## Records and bulk entry

Trades -> Bulk entry accepts pasted CSV/TSV, local CSV/TSV/text, or a reviewed JSON draft. Review is read-only; saving is a separate action. Up to 500 records per batch. Export CSV downloads the selected owner's complete active transaction history; audit history stays in the database. CSV export is a manual records export, not a full database backup.

Columns: `owner,date,type,market,symbol,currency,quantity,price,fee,amount,fx_rate,sequence,notes`. Owners use `mine`/`father`, dates use YYYY-MM-DD, fees and prices are positive, market is US/MY, and `fx_rate` means MYR per USD only when actually known. Use Bursa code `1155` for Maybank; the code remains a string, preserving leading zeroes for other stocks.

The private input at `C:\Investment-advisor\private-records\reviewed-records.json` is outside both Git repositories. It contains 39 PDF records, including the confirmed GOOG fee correction, four cash distributions, and separate funding totals. These records are imported into the private local preview only. The cloud database is unchanged. No deposit dates or historical FX have been invented. Funding dates and the PDF's inconsistent bottom total remain to be reconciled.

The local input may also contain timestamped `quote_snapshots`. The preview imports newer snapshots into its local quote cache, retaining the source and quote timestamp; it never overwrites a newer provider quote with an older snapshot. Maybank's snapshot was verified on [its investor-relations site](https://maybank.listedcompany.com/). This is a dated quote, not a new automatic Bursa pricing provider.

## Validation

`npm test` runs isolated in-memory SQLite API tests and accounting tests, without the cloud database. Tests cover fee-aware weighted averages, partial and full sales, fractional shares, owner isolation, dividends, cash, missing historical FX, chronological replay, input validation, authentication, atomic import rollback, duplicates, version conflicts, audit, manual prices and quote failures. HTTP tests need loopback networking in restricted environments.

The frontend has `npm test` and `npm run build`. Desktop and 390px mobile layouts, login, bulk preview and saved corrections were also checked in the browser. PostgreSQL migration and cloud deployment have not been executed against the live database.

## Remaining phases

Phase 2 features are implemented locally. Actual brokerage reconciliation remains pending the user's Moomoo figures and any missing history. Phase 3: chart/news/sentiment integration, deployment, automated backups and final hardening.
