const express = require("express");
const { applyFundingSnapshots } = require("../lib/funding");
const { normalizeSnapshot, compare } = require("../lib/reconciliation");
const {
  normalize,
  replay,
  fail,
  units,
  text,
  multiply,
  FIELDS,
  today,
} = require("../lib/accounting");
function createTrackerRouter(db, quotes, options = {}) {
  const router = express.Router();
  const history = async (client, userId) =>
    (
      await client.query(
        "SELECT * FROM tracker_transactions WHERE user_id=$1 AND voided=0 ORDER BY occurred_on,sequence,id",
        [userId],
      )
    ).rows;
  async function owners(client, userId) {
    for (const [key, name] of [
      ["mine", "Mine"],
      ["father", "Father's"],
    ]) {
      await client.query(
        "INSERT INTO tracker_owners (user_id,owner_key,name) VALUES ($1,$2,$3) ON CONFLICT(user_id,owner_key) DO NOTHING",
        [userId, key, name],
      );
    }
    return (
      await client.query(
        "SELECT id,owner_key,name FROM tracker_owners WHERE user_id=$1 ORDER BY id",
        [userId],
      )
    ).rows;
  }
  async function audit(client, userId, id, action, before, after) {
    await client.query(
      "INSERT INTO tracker_audit (user_id,transaction_id,action,before_json,after_json) VALUES ($1,$2,$3,$4,$5)",
      [
        userId,
        id,
        action,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
      ],
    );
  }
  router.get("/", async (req, res) => {
    const profiles = await db.transaction(req.userId, (client) =>
      owners(client, req.userId),
    );
    const all = await history(db, req.userId);
    const ledger = replay(all);
    const fundingSnapshots = (
      await db.query(
        "SELECT owner_id,as_of,amount_myr FROM tracker_funding_snapshots WHERE user_id=$1",
        [req.userId],
      )
    ).rows;
    applyFundingSnapshots(ledger, fundingSnapshots);
    const keys = [
      ...new Set(
        ledger.positions
          .filter((p) => units(p.quantity) > 0n)
          .map((p) => `${p.market}:${p.symbol}`),
      ),
    ];
    const needsFx =
      ledger.accounts.some((a) => a.currency === "USD") ||
      ledger.positions.some((p) => p.currency === "USD");
    if (needsFx) keys.push("FX:USDMYR");
    const prices = Object.fromEntries(
      await Promise.all(keys.map(async (key) => [key, await quotes.get(key)])),
    );
    const manualQuotes = (
      await db.query("SELECT * FROM tracker_manual_quotes WHERE user_id=$1", [
        req.userId,
      ])
    ).rows;
    const positions = ledger.positions.map((p) => {
      let quote = prices[`${p.market}:${p.symbol}`] || {
        price: null,
        status: "unavailable",
      };
      const manual = manualQuotes.find(
        (q) => q.instrument === `${p.market}:${p.symbol}`,
      );
      if (
        manual &&
        (quote.price === null ||
          Date.parse(manual.quoted_at) > Date.parse(quote.quoted_at))
      )
        quote = {
          ...manual,
          currency: p.currency,
          status: "manual",
          source: "Manual entry",
        };
      const value =
        units(p.quantity) === 0n
          ? 0n
          : quote.price === null
            ? null
            : multiply(units(p.quantity), units(quote.price));
      return {
        ...p,
        quote,
        current_value: value === null ? null : text(value),
        unrealized_pl: value === null ? null : text(value - units(p.cost)),
      };
    });
    const legacy = (
      await db.query(
        "SELECT COUNT(*) AS count FROM holdings WHERE user_id=$1",
        [req.userId],
      )
    ).rows[0];
    res.json({
      is_demo: !!options.demo,
      is_local: !!options.local,
      funding_snapshots: fundingSnapshots,
      opening_owners: ledger.opening_owners,
      phase: 2,
      owners: profiles,
      accounts: ledger.accounts,
      positions,
      transactions: ledger.transactions,
      fx: prices["FX:USDMYR"] || null,
      legacy_holdings_count: Number(legacy.count),
      as_of: new Date().toISOString(),
    });
  });
  router.post("/quotes/manual", async (req, res) => {
    const input = normalize({
      ...req.body,
      owner_id: 1,
      kind: "BUY",
      occurred_on: "2020-01-01",
      quantity: "1",
      fee: "0",
    });
    const date = new Date(req.body.quoted_at);
    if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 60000)
      fail("Enter a valid price timestamp, no later than now.");
    const instrument = `${input.market}:${input.symbol}`;
    const all = await history(db, req.userId);
    if (
      !all.some((r) => r.market === input.market && r.symbol === input.symbol)
    )
      fail("Stock not found in your history.", 404);
    await db.query(
      `INSERT INTO tracker_manual_quotes(user_id,instrument,price,quoted_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id,instrument) DO UPDATE SET price=excluded.price,quoted_at=excluded.quoted_at`,
      [req.userId, instrument, input.price, date.toISOString()],
    );
    res.json({
      instrument,
      price: input.price,
      quoted_at: date.toISOString(),
      source: "Manual entry",
    });
  });
  router.post("/transactions/preview", async (req, res) => {
    const result = await batch(req, true);
    res.json(result);
  });
  router.post("/transactions/bulk", async (req, res) => {
    res.status(201).json(await batch(req, false));
  });
  router.post("/transactions", async (req, res) => {
    req.body = {
      transactions: [req.body],
      allow_duplicates: req.body?.allow_duplicates === true,
    };
    const result = await batch(req, false);
    res.status(201).json(result.transactions[0]);
  });
  async function batch(req, preview) {
    const input = req.body?.transactions;
    if (!Array.isArray(input) || input.length < 1 || input.length > 500)
      fail("Submit between 1 and 500 transactions.");
    const normalized = input.map((row, i) => {
      try {
        return normalize(row);
      } catch (e) {
        fail(`Row ${i + 1}: ${e.message}`);
      }
    });
    return db.transaction(req.userId, async (client) => {
      const profiles = await owners(client, req.userId);
      const allowed = new Set(profiles.map((p) => p.id));
      normalized.forEach((r, i) => {
        if (!allowed.has(r.owner_id))
          fail(`Row ${i + 1}: Owner not found.`, 404);
        if (
          r.counterparty_owner_id !== null &&
          !allowed.has(r.counterparty_owner_id)
        )
          fail(`Row ${i + 1}: Receiving owner not found.`, 404);
      });
      const old = await history(client, req.userId);
      const seen = new Set(old.map(fingerprint));
      const duplicateRows = [];
      normalized.forEach((r, i) => {
        const key = fingerprint(r);
        if (seen.has(key)) duplicateRows.push(i + 1);
        seen.add(key);
      });
      if (
        duplicateRows.length &&
        req.body.allow_duplicates !== true &&
        !preview
      )
        fail(
          `Possible duplicate rows: ${duplicateRows.join(", ")}. Review the preview and explicitly allow duplicates if these are separate fills.`,
          409,
        );
      const maxId = old.reduce((max, r) => Math.max(max, r.id), 0);
      replay([
        ...old,
        ...normalized.map((r, i) => ({ ...r, id: maxId + i + 1 })),
      ]);
      if (preview)
        return {
          transactions: normalized,
          duplicate_rows: duplicateRows,
          count: normalized.length,
        };
      const inserted = [];
      for (const row of normalized) {
        const result = await client.query(
          `INSERT INTO tracker_transactions (user_id,${FIELDS.join(",")}) VALUES (${Array.from({ length: FIELDS.length + 1 }, (_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
          [req.userId, ...FIELDS.map((f) => row[f])],
        );
        const record = result.rows[0];
        await audit(client, req.userId, record.id, "CREATE", null, record);
        inserted.push(record);
      }
      return { transactions: inserted, count: inserted.length };
    });
  }
  function fingerprint(row) {
    const entry = normalize(row);
    return JSON.stringify(
      FIELDS.filter((f) => f !== "notes").map((f) => entry[f]),
    );
  }
  for (const method of ["put", "delete"])
    router[method]("/transactions/:id", async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) fail("Invalid transaction ID.");
      const result = await db.transaction(req.userId, async (client) => {
        const old = (
          await client.query(
            "SELECT * FROM tracker_transactions WHERE id=$1 AND user_id=$2 AND voided=0",
            [id, req.userId],
          )
        ).rows[0];
        if (!old) fail("Transaction not found.", 404);
        if (Number(req.body?.version) !== old.version)
          fail("This transaction changed. Refresh before correcting it.", 409);
        const next =
          method === "put"
            ? { ...old, ...normalize(req.body), version: old.version + 1 }
            : { ...old, voided: 1, version: old.version + 1 };
        if (method === "put") {
          const profiles = await owners(client, req.userId);
          if (!profiles.some((p) => p.id === next.owner_id))
            fail("Owner not found.", 404);
          if (
            next.counterparty_owner_id !== null &&
            !profiles.some(
              (profile) => profile.id === next.counterparty_owner_id,
            )
          )
            fail("Receiving owner not found.", 404);
        }
        const all = await history(client, req.userId);
        replay(all.map((r) => (r.id === id ? next : r)));
        await client.query(
          `UPDATE tracker_transactions SET ${FIELDS.map((f, i) => `${f}=$${i + 1}`).join(",")},version=$${FIELDS.length + 1},voided=$${FIELDS.length + 2} WHERE id=$${FIELDS.length + 3} AND user_id=$${FIELDS.length + 4}`,
          [
            ...FIELDS.map((f) => next[f]),
            next.version,
            next.voided,
            id,
            req.userId,
          ],
        );
        await audit(
          client,
          req.userId,
          id,
          method === "put" ? "EDIT" : "DELETE",
          old,
          next,
        );
        return next;
      });
      res.json(result);
    });
  router.get("/transactions/:id/audit", async (req, res) => {
    const result = await db.query(
      "SELECT action,before_json,after_json,created_at FROM tracker_audit WHERE transaction_id=$1 AND user_id=$2 ORDER BY id",
      [Number(req.params.id), req.userId],
    );
    res.json(result.rows);
  });
  async function reconciliation(client, userId, snapshot) {
    const rows = await history(client, userId);
    const funding = (
      await client.query(
        "SELECT owner_id,as_of,amount_myr FROM tracker_funding_snapshots WHERE user_id=$1",
        [userId],
      )
    ).rows;
    return compare(rows, funding, snapshot);
  }
  router.get("/reconciliation", async (req, res) => {
    const saved = (
      await db.query(
        "SELECT version,snapshot_json,created_at FROM tracker_reconciliations WHERE user_id=$1 ORDER BY version DESC LIMIT 1",
        [req.userId],
      )
    ).rows[0];
    const snapshot = saved
      ? JSON.parse(saved.snapshot_json)
      : {
          as_of: today(),
          cash: { MYR: null, USD: null },
          positions: [],
          complete: false,
        };
    res.json({
      version: saved?.version || 0,
      snapshot,
      comparison: await reconciliation(db, req.userId, snapshot),
    });
  });
  router.put("/reconciliation", async (req, res) => {
    const snapshot = normalizeSnapshot(req.body);
    const result = await db.transaction(req.userId, async (client) => {
      const old = (
        await client.query(
          "SELECT version FROM tracker_reconciliations WHERE user_id=$1 ORDER BY version DESC LIMIT 1",
          [req.userId],
        )
      ).rows[0];
      const version = old?.version || 0;
      if (Number(req.body.version) !== version)
        fail("This reconciliation changed. Reload before saving.", 409);
      await client.query(
        "INSERT INTO tracker_reconciliations(user_id,version,snapshot_json) VALUES($1,$2,$3)",
        [req.userId, version + 1, JSON.stringify(snapshot)],
      );
      return {
        version: version + 1,
        snapshot,
        comparison: await reconciliation(client, req.userId, snapshot),
      };
    });
    res.json(result);
  });
  return router;
}
module.exports = { createTrackerRouter };
