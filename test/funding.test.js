const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalize, replay } = require("../lib/accounting");
const { applyFundingSnapshots } = require("../lib/funding");
const entry = (row, id = 1) => ({
  ...normalize({
    owner_id: 1,
    kind: "DEPOSIT",
    occurred_on: "2026-01-01",
    currency: "MYR",
    amount: "200",
    fee: "0",
    ...row,
  }),
  id,
});
test("capital snapshots supply known totals without fabricating dated transactions", () => {
  const ledger = replay([
    entry({
      kind: "BUY",
      market: "US",
      symbol: "AAPL",
      currency: "USD",
      quantity: "1",
      price: "100",
    }),
  ]);
  applyFundingSnapshots(ledger, [
    { owner_id: 1, as_of: "2026-11-12", amount_myr: "6434" },
  ]);
  assert.equal(ledger.transactions.length, 1);
  assert.equal(
    ledger.accounts.find((a) => a.currency === "MYR").balance,
    "6434.00000000",
  );
  assert.equal(
    ledger.accounts.find((a) => a.currency === "USD").balance,
    "-100.00000000",
  );
  assert.equal(ledger.transactions[0].running_cash, null);
});
test("dated deposits are not counted twice and later contributions still increase capital", () => {
  const ledger = replay([
    entry({}),
    entry({ occurred_on: "2026-11-11", amount: "50" }, 2),
  ]);
  applyFundingSnapshots(ledger, [
    { owner_id: 1, as_of: "2026-11-01", amount_myr: "1000" },
  ]);
  assert.equal(ledger.accounts[0].balance, "1050.00000000");
  assert.equal(ledger.accounts[0].contributions_myr, "1050.00000000");
});
test("unknown historical FX never permits an invented funding adjustment", () => {
  const ledger = replay([entry({ currency: "USD" })]);
  const snapshots = [{ owner_id: 1, as_of: "2026-11-12", amount_myr: "6434" }];
  applyFundingSnapshots(ledger, snapshots);
  assert.equal(snapshots[0].applied, false);
  assert.equal(ledger.accounts.length, 1);
});
