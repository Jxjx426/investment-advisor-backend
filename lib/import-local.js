const { createHash } = require("node:crypto");
const { FIELDS, normalize, replay, units } = require("./accounting");
const { applyFundingSnapshots } = require("./funding");

function canonical(rows, owners) {
  const ownerKey = (id) => owners.find((owner) => owner.id === id)?.owner_key;
  return rows
    .toSorted(
      (a, b) =>
        String(a.occurred_on).localeCompare(String(b.occurred_on)) ||
        a.sequence - b.sequence ||
        a.id - b.id,
    )
    .map((row) => {
      const normalized = normalize(row);
      return {
        ...normalized,
        owner_id: ownerKey(row.owner_id),
        counterparty_owner_id:
          row.counterparty_owner_id == null
            ? null
            : ownerKey(row.counterparty_owner_id),
        version: row.version,
        voided: row.voided,
      };
    });
}
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validateSource(archive) {
  if (archive.payload?.kind !== "database")
    throw new Error("A full private local snapshot is required.");
  const tables = archive.payload.tables;
  const users = tables.users.filter(
    (user) => user.email === "preview@local.test",
  );
  if (users.length !== 1)
    throw new Error("Expected exactly one local preview account.");
  const id = users[0].id;
  const owners = tables.tracker_owners.filter((row) => row.user_id === id);
  if (
    owners.length !== 2 ||
    !["mine", "father"].every((key) =>
      owners.some((owner) => owner.owner_key === key),
    )
  )
    throw new Error("Local owner profiles are incomplete.");
  const rows = tables.tracker_transactions.filter((row) => row.user_id === id);
  for (const row of rows) {
    if (
      !owners.some((owner) => owner.id === row.owner_id) ||
      (row.counterparty_owner_id != null &&
        !owners.some((owner) => owner.id === row.counterparty_owner_id))
    )
      throw new Error("Local record references another account.");
    normalize(row);
  }
  const ledger = replay(rows.filter((row) => !row.voided));
  applyFundingSnapshots(
    ledger,
    tables.tracker_funding_snapshots.filter((row) => row.user_id === id),
  );
  return { tables, id, owners, rows };
}
async function importLocal(db, archive, email, apply = false) {
  const source = validateSource(archive);
  const users = (
    await db.query("SELECT id FROM users WHERE lower(email)=lower($1)", [email])
  ).rows;
  if (users.length !== 1)
    throw new Error(
      "The target email must identify exactly one existing cloud account.",
    );
  const userId = users[0].id;
  return db.transaction(userId, async (client) => {
    let owners = (
      await client.query(
        "SELECT * FROM tracker_owners WHERE user_id=$1 ORDER BY id",
        [userId],
      )
    ).rows;
    const existing = (
      await client.query(
        "SELECT * FROM tracker_transactions WHERE user_id=$1 ORDER BY id",
        [userId],
      )
    ).rows;
    const legacy = Number(
      (
        await client.query(
          "SELECT COUNT(*) AS count FROM holdings WHERE user_id=$1",
          [userId],
        )
      ).rows[0].count,
    );
    const plan = {
      target_user_id: userId,
      transactions: source.rows.length,
      legacy_holdings_preserved: legacy,
      already_imported: false,
      applied: false,
    };
    if (existing.length) {
      if (
        digest(canonical(existing, owners)) !==
        digest(canonical(source.rows, source.owners))
      )
        throw new Error(
          "The cloud ledger already contains different records. Nothing was overwritten.",
        );
      return { ...plan, already_imported: true };
    }
    for (const table of [
      "tracker_audit",
      "tracker_funding_snapshots",
      "tracker_manual_quotes",
      "tracker_reconciliations",
    ])
      if (
        Number(
          (
            await client.query(
              `SELECT COUNT(*) AS count FROM ${table} WHERE user_id=$1`,
              [userId],
            )
          ).rows[0].count,
        )
      )
        throw new Error(
          "Cloud account has existing tracker settings. Reconcile them before importing.",
        );
    if (!apply) return plan;
    for (const owner of source.owners)
      await client.query(
        "INSERT INTO tracker_owners(user_id,owner_key,name) VALUES($1,$2,$3) ON CONFLICT(user_id,owner_key) DO NOTHING",
        [userId, owner.owner_key, owner.name],
      );
    owners = (
      await client.query("SELECT * FROM tracker_owners WHERE user_id=$1", [
        userId,
      ])
    ).rows;
    const ownerIds = new Map(
      source.owners.map((owner) => [
        owner.id,
        owners.find((target) => target.owner_key === owner.owner_key).id,
      ]),
    );
    const ids = new Map();
    for (const original of source.rows.toSorted((a, b) => a.id - b.id)) {
      const row = normalize({
        ...original,
        owner_id: ownerIds.get(original.owner_id),
        counterparty_owner_id:
          original.counterparty_owner_id == null
            ? null
            : ownerIds.get(original.counterparty_owner_id),
      });
      const fields = ["user_id", ...FIELDS, "version", "voided", "created_at"];
      const values = [
        userId,
        ...FIELDS.map((field) => row[field]),
        original.version,
        original.voided,
        original.created_at,
      ];
      const saved = (
        await client.query(
          `INSERT INTO tracker_transactions(${fields.join(",")}) VALUES(${fields.map((_, index) => `$${index + 1}`).join(",")}) RETURNING id`,
          values,
        )
      ).rows[0];
      ids.set(original.id, saved.id);
    }
    function remapAudit(value) {
      if (!value) return null;
      const row = JSON.parse(value);
      if (row.id != null) row.id = ids.get(row.id);
      if (row.user_id != null) row.user_id = userId;
      if (row.owner_id != null) row.owner_id = ownerIds.get(row.owner_id);
      if (row.counterparty_owner_id != null)
        row.counterparty_owner_id = ownerIds.get(row.counterparty_owner_id);
      return JSON.stringify(row);
    }
    for (const row of source.tables.tracker_audit.filter(
      (row) => row.user_id === source.id,
    ))
      await client.query(
        "INSERT INTO tracker_audit(user_id,transaction_id,action,before_json,after_json,created_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          userId,
          ids.get(row.transaction_id),
          row.action,
          remapAudit(row.before_json),
          remapAudit(row.after_json),
          row.created_at,
        ],
      );
    for (const row of source.tables.tracker_funding_snapshots.filter(
      (row) => row.user_id === source.id,
    ))
      await client.query(
        "INSERT INTO tracker_funding_snapshots(user_id,owner_id,as_of,amount_myr) VALUES($1,$2,$3,$4)",
        [userId, ownerIds.get(row.owner_id), row.as_of, row.amount_myr],
      );
    for (const row of source.tables.tracker_manual_quotes.filter(
      (row) => row.user_id === source.id,
    ))
      await client.query(
        "INSERT INTO tracker_manual_quotes(user_id,instrument,price,quoted_at) VALUES($1,$2,$3,$4)",
        [userId, row.instrument, row.price, row.quoted_at],
      );
    for (const row of source.tables.tracker_reconciliations.filter(
      (row) => row.user_id === source.id,
    ))
      await client.query(
        "INSERT INTO tracker_reconciliations(user_id,version,snapshot_json,created_at) VALUES($1,$2,$3,$4)",
        [userId, row.version, row.snapshot_json, row.created_at],
      );
    for (const quote of source.tables.tracker_quotes) {
      if (
        !/^(?:US:[A-Z][A-Z0-9.-]{0,14}|MY:\d{4,5}[A-Z]{0,2}|FX:USDMYR)$/.test(
          quote.instrument,
        ) ||
        units(quote.price) <= 0n ||
        !Number.isFinite(Date.parse(quote.quoted_at)) ||
        Date.parse(quote.quoted_at) > Date.now() + 60000
      )
        throw new Error("Invalid source quote snapshot.");
      await client.query(
        "INSERT INTO tracker_quotes(instrument,price,currency,quoted_at,fetched_at,source) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(instrument) DO UPDATE SET price=excluded.price,currency=excluded.currency,quoted_at=excluded.quoted_at,fetched_at=excluded.fetched_at,source=excluded.source WHERE excluded.quoted_at>tracker_quotes.quoted_at",
        [
          quote.instrument,
          quote.price,
          quote.currency,
          quote.quoted_at,
          quote.fetched_at,
          quote.source,
        ],
      );
    }
    const saved = (
      await client.query(
        "SELECT * FROM tracker_transactions WHERE user_id=$1",
        [userId],
      )
    ).rows;
    if (
      digest(canonical(saved, owners)) !==
      digest(canonical(source.rows, source.owners))
    )
      throw new Error(
        "Imported record verification failed. Import was rolled back.",
      );
    return { ...plan, applied: true };
  });
}
module.exports = { importLocal, canonical };
