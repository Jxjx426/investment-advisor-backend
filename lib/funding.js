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
    if (unknown) continue;
    const adjustment = units(snapshot.amount_myr) - recorded;
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
      };
      ledger.accounts.push(account);
    }
    for (const field of ["balance", "contributions", "contributions_myr"])
      account[field] = text(units(account[field]) + adjustment);
    // The cash balance on a historical day is unknown without the deposit dates.
    for (const row of ledger.transactions)
      if (row.owner_id === snapshot.owner_id) row.running_cash = null;
  }
  return ledger;
}
module.exports = { applyFundingSnapshots };
