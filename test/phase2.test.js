const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalize, replay } = require("../lib/accounting");
const { applyFundingSnapshots } = require("../lib/funding");
const { compare, normalizeSnapshot } = require("../lib/reconciliation");
const row = (values, id = 1) => ({
  ...normalize({
    owner_id: 1,
    kind: "DEPOSIT",
    occurred_on: "2026-01-01",
    currency: "MYR",
    amount: "1000",
    fee: "0",
    ...values,
  }),
  id,
});
test("actual FX moves both cash legs without creating contributions or investment profit", () => {
  const result = replay([
    row({}),
    row(
      {
        kind: "FX",
        amount: "430",
        fee: "1",
        target_currency: "USD",
        target_amount: "100",
      },
      2,
    ),
  ]);
  assert.equal(
    result.accounts.find((a) => a.currency === "MYR").balance,
    "569.00000000",
  );
  assert.equal(
    result.accounts.find((a) => a.currency === "USD").balance,
    "100.00000000",
  );
  assert.equal(
    result.accounts.find((a) => a.currency === "USD").contributions,
    "0.00000000",
  );
  assert.equal(result.transactions[1].cash_legs.length, 2);
  assert.equal(result.transactions[1].fx_rate, "4.30000000");
  assert.equal(
    result.accounts.every((a) => a.realized === "0.00000000"),
    true,
  );
});
test("reverse FX fees stay in source currency and estimates stay flagged", () => {
  const result = replay([
    row({
      kind: "FX",
      currency: "USD",
      amount: "10",
      target_currency: "MYR",
      target_amount: "43",
      fee: "0.5",
      fx_estimated: true,
    }),
  ]);
  assert.equal(
    result.accounts.find((a) => a.currency === "USD").balance,
    "-10.50000000",
  );
  assert.equal(
    result.accounts.find((a) => a.currency === "MYR").balance,
    "43.00000000",
  );
  assert.ok(result.accounts.every((a) => a.cash_estimated));
});
test("owner transfers keep combined external contributions unchanged; fees debit only sender", () => {
  const result = replay([
    row({}),
    row(
      { kind: "TRANSFER", counterparty_owner_id: 2, amount: "300", fee: "2" },
      2,
    ),
  ]);
  assert.equal(
    result.accounts.find((a) => a.owner_id === 1).balance,
    "698.00000000",
  );
  assert.equal(
    result.accounts.find((a) => a.owner_id === 2).balance,
    "300.00000000",
  );
  assert.equal(
    result.accounts.find((a) => a.owner_id === 1).transfers,
    "-300.00000000",
  );
  assert.equal(
    result.accounts.find((a) => a.owner_id === 2).transfers,
    "300.00000000",
  );
  assert.equal(
    result.accounts.reduce((sum, a) => sum + Number(a.contributions), 0),
    1000,
  );
});
test("forward and reverse splits preserve total cost and fee-aware realized profit", () => {
  const buy = row({
    kind: "BUY",
    currency: "USD",
    market: "US",
    symbol: "TSLA",
    quantity: "10",
    price: "100",
    fee: "2",
  });
  const split = row(
    {
      kind: "SPLIT",
      currency: "USD",
      market: "US",
      symbol: "TSLA",
      split_from: "1",
      split_to: "2",
    },
    2,
  );
  const sale = row(
    {
      kind: "SELL",
      currency: "USD",
      market: "US",
      symbol: "TSLA",
      quantity: "5",
      price: "70",
      fee: "1",
    },
    3,
  );
  const result = replay([buy, split, sale]);
  assert.equal(result.positions[0].quantity, "15.00000000");
  assert.equal(result.positions[0].cost, "751.50000000");
  assert.equal(result.positions[0].average_cost, "50.10000000");
  assert.equal(result.positions[0].realized, "98.50000000");
  const reverse = replay([
    buy,
    split,
    row({ ...split, split_from: "2", split_to: "1" }, 4),
  ]);
  assert.equal(reverse.positions[0].quantity, "10.00000000");
  assert.equal(reverse.positions[0].cost, "1002.00000000");
});
test("opening positions carry exact cost without spending cash; opening cash is not a deposit", () => {
  const result = replay([
    row({
      kind: "OPENING_POSITION",
      currency: "USD",
      market: "US",
      symbol: "AAPL",
      quantity: "3",
      amount: "301",
    }),
    row({ kind: "OPENING_CASH", currency: "USD", amount: "100" }, 2),
    row(
      {
        kind: "SELL",
        currency: "USD",
        market: "US",
        symbol: "AAPL",
        quantity: "1",
        price: "120",
      },
      3,
    ),
  ]);
  assert.equal(result.positions[0].cost, "200.66666667");
  assert.equal(result.positions[0].realized, "19.66666667");
  assert.equal(result.accounts[0].balance, "220.00000000");
  assert.equal(result.accounts[0].contributions, "0.00000000");
  assert.throws(
    () => replay([row({}), row({ kind: "OPENING_CASH" }, 2)]),
    /precede/,
  );
  applyFundingSnapshots(result, [
    { owner_id: 1, as_of: "2026-01-01", amount_myr: "5000" },
  ]);
  assert.equal(
    result.accounts.find((a) => a.currency === "MYR").balance,
    "0.00000000",
  );
});
test("withholding and later tax payments affect cash, not trade cost or contributions", () => {
  const result = replay([
    row({
      kind: "DIVIDEND",
      currency: "USD",
      market: "US",
      symbol: "NKE",
      amount: "10",
      tax: "3",
      fee: "0.2",
    }),
    row({ kind: "TAX", currency: "USD", amount: "1" }, 2),
  ]);
  assert.equal(result.accounts[0].balance, "5.80000000");
  assert.equal(result.accounts[0].dividends, "6.80000000");
  assert.equal(result.accounts[0].taxes, "4.00000000");
  assert.equal(result.accounts[0].contributions, "0.00000000");
  assert.equal(result.positions.length, 0);
});
test("invalid FX, transfers, tax, opening order and unsupported fractional split are rejected", () => {
  for (const value of [
    { kind: "FX", target_currency: "MYR", target_amount: "1" },
    { kind: "TRANSFER", counterparty_owner_id: 1 },
    { kind: "DIVIDEND", market: "MY", symbol: "1155", tax: "1001" },
    { kind: "FX", target_currency: "USD", target_amount: "0" },
  ])
    assert.throws(() => row(value));
  assert.throws(
    () =>
      replay([
        row({
          kind: "SPLIT",
          market: "MY",
          symbol: "1155",
          split_from: "1",
          split_to: "2",
        }),
      ]),
    /existing shares/,
  );
  assert.throws(
    () =>
      replay([
        row({
          kind: "BUY",
          market: "MY",
          symbol: "1155",
          quantity: "1",
          price: "3",
        }),
        row(
          {
            kind: "SPLIT",
            market: "MY",
            symbol: "1155",
            split_from: "3",
            split_to: "1",
          },
          2,
        ),
      ]),
    /8 decimals/,
  );
});
test("reconciliation compares combined shares and cent-rounded cash at the chosen date", () => {
  const rows = [
    row({}),
    row(
      {
        kind: "BUY",
        market: "MY",
        symbol: "1155",
        quantity: "10",
        price: "10",
      },
      2,
    ),
    row(
      {
        owner_id: 2,
        kind: "BUY",
        market: "MY",
        symbol: "1155",
        quantity: "5",
        price: "10",
      },
      3,
    ),
  ];
  const snap = normalizeSnapshot({
    as_of: "2026-01-01",
    cash: { MYR: "850", USD: "0" },
    positions: [{ market: "MY", symbol: "1155", quantity: "15" }],
    complete: true,
  });
  const result = compare(rows, [], snap);
  assert.equal(result.share_mismatches, 0);
  assert.equal(result.cash_mismatches, 0);
  assert.equal(result.positions[0].recorded, "15.00000000");
  const partial = compare(rows, [], {
    ...snap,
    positions: [],
    complete: false,
  });
  assert.equal(partial.positions[0].status, "missing");
  const absent = compare(rows, [], { ...snap, positions: [], complete: true });
  assert.equal(absent.positions[0].difference, "15.00000000");
});
test("reconciliation does not label snapshot-based or estimated FX cash as exact matches", () => {
  const result = compare(
    [],
    [{ owner_id: 1, as_of: "2026-01-01", amount_myr: "1000" }],
    normalizeSnapshot({
      as_of: "2026-01-01",
      cash: { MYR: "1000", USD: "0" },
      positions: [],
      complete: true,
    }),
  );
  assert.equal(result.cash[0].status, "estimated");
  assert.equal(result.estimated, true);
  assert.throws(() =>
    normalizeSnapshot({
      as_of: "2026-01-01",
      positions: [{ market: "MY", symbol: "1155", quantity: "-1" }],
    }),
  );
});
test("undated funding also hides the receiving transfer leg historical cash balance", () => {
  const ledger = replay([
    row({ kind: "TRANSFER", counterparty_owner_id: 2, amount: "100" }),
  ]);
  applyFundingSnapshots(ledger, [
    { owner_id: 2, as_of: "2026-01-01", amount_myr: "500" },
  ]);
  assert.equal(
    ledger.transactions[0].cash_legs.find((leg) => leg.owner_id === 2)
      .running_cash,
    null,
  );
  assert.equal(
    ledger.accounts.find((account) => account.owner_id === 2).balance,
    "600.00000000",
  );
});
