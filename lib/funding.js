const { units, text, multiply } = require("./accounting");
// A contribution snapshot supplies capital without inventing deposit dates.
// Dated contributions through the snapshot date are deducted to avoid double counting.
function applyFundingSnapshots(ledger, snapshots) {
  for (const snapshot of snapshots) {
    let recorded = 0n,
      unknown = false;
    for (const row of ledger.transactions.filter(
      (row) =>
        row.owner_id === snapshot.owner_id &&
        row.occurred_on <= snapshot.as_of &&
        ["DEPOSIT", "WITHDRAWAL"].includes(row.kind),
    )) {
      if (!row.fx_rate) {
        unknown = true;
        break;
      }
      recorded +=
        multiply(units(row.amount), units(row.fx_rate)) *
        (row.kind === "DEPOSIT" ? 1n : -1n);
    }
    snapshot.applied = !unknown;
    snapshot.estimated = unknown;
    if (unknown) {
      for (const account of ledger.accounts)
        if (account.owner_id === snapshot.owner_id)
          account.cash_estimated = true;
      continue;
    }
    const adjustment = units(snapshot.amount_myr) - recorded;
    const hasOpening = ledger.opening_owners?.includes(snapshot.owner_id);
    snapshot.adjustment_myr = text(adjustment);
    snapshot.cash_applied = !hasOpening;
    snapshot.estimated = adjustment !== 0n && !hasOpening;
    let account = ledger.accounts.find(
      (row) => row.owner_id === snapshot.owner_id && row.currency === "MYR",
    );
    if (!account) {
      account = {
        owner_id: snapshot.owner_id,
        currency: "MYR",
        balance: "0",
        contributions: "0",
        contributions_myr: "0",
        realized: "0",
        fees: "0",
        dividends: "0",
        taxes: "0",
        transfers: "0",
        transfers_myr: "0",
        opening: "0",
        has_opening_cash: false,
        cash_estimated: !!hasOpening,
      };
      ledger.accounts.push(account);
      for (const key of [
        "balance",
        "contributions",
        "contributions_myr",
        "realized",
        "fees",
        "dividends",
        "taxes",
        "transfers",
        "transfers_myr",
        "opening",
      ])
        account[key] = text(0n);
    }
    for (const field of [
      "contributions",
      "contributions_myr",
      ...(!hasOpening ? ["balance"] : []),
    ])
      account[field] = text(units(account[field]) + adjustment);
    if (snapshot.estimated) account.cash_estimated = true;
    // The cash balance on a historical day is unknown without the deposit dates.
    if (snapshot.estimated)
      for (const row of ledger.transactions) {
        if (row.owner_id === snapshot.owner_id) row.running_cash = null;
        for (const leg of row.cash_legs || [])
          if (leg.owner_id === snapshot.owner_id) leg.running_cash = null;
      }
  }
  return ledger;
}
module.exports = { applyFundingSnapshots };
