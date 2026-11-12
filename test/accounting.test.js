const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalize, replay } = require("../lib/accounting");
const row = (values, id = 1) => ({
  ...normalize({
    owner_id: 1,
    kind: "BUY",
    occurred_on: "2026-01-01",
    market: "US",
    symbol: "TSLA",
    currency: "USD",
    quantity: "10",
    price: "100",
    fee: "2",
    ...values,
  }),
  id,
});

test("weighted cost includes fees; partial sales retain average; closed positions retain realized P/L", () => {
  const result = replay([
    row({}),
    row({ quantity: "5", price: "130", fee: "1" }, 2),
    row({ kind: "SELL", quantity: "6", price: "140", fee: "3" }, 3),
  ]);
  assert.equal(result.positions[0].cost, "991.80000000");
  assert.equal(result.positions[0].average_cost, "110.20000000");
  assert.equal(result.positions[0].realized, "175.80000000");
  const closed = replay([
    ...result.transactions,
    row({ kind: "SELL", quantity: "9", price: "120", fee: "2" }, 4),
  ]);
  assert.equal(closed.positions[0].quantity, "0.00000000");
  assert.equal(closed.positions[0].cost, "0.00000000");
  assert.equal(closed.positions[0].realized, "262.00000000");
});
test("owners and markets have independent cost and shares", () => {
  const result = replay([
    row({}),
    row({ owner_id: 2, quantity: "2", price: "200" }, 2),
    row({ market: "MY", currency: "MYR", price: "10" }, 3),
  ]);
  assert.equal(result.positions.length, 3);
  assert.throws(
    () =>
      replay([
        ...result.transactions,
        row({ kind: "SELL", owner_id: 2, quantity: "3" }, 4),
      ]),
    /exceeds/,
  );
});
test("cash contributions are separate from realized profit and dividends", () => {
  const result = replay([
    row({ kind: "DEPOSIT", amount: "1000", currency: "MYR", fee: "0" }),
    row({ kind: "WITHDRAWAL", amount: "100", currency: "MYR", fee: "2" }, 2),
    row(
      {
        kind: "DIVIDEND",
        market: "MY",
        currency: "MYR",
        symbol: "1155",
        amount: "62",
        fee: "0",
      },
      3,
    ),
  ]);
  assert.equal(result.accounts[0].balance, "960.00000000");
  assert.equal(result.accounts[0].contributions, "900.00000000");
  assert.equal(result.accounts[0].realized, "0.00000000");
  assert.equal(result.accounts[0].dividends, "62.00000000");
  assert.equal(result.positions.length, 0);
});
test("fractional trades close exactly, with no residual cost", () => {
  const result = replay([
    row({ quantity: "0.3", price: "0.1", fee: "0" }),
    row({ kind: "SELL", quantity: "0.1", price: "0.2", fee: "0" }, 2),
    row({ kind: "SELL", quantity: "0.2", price: "0.2", fee: "0" }, 3),
  ]);
  assert.equal(result.positions[0].quantity, "0.00000000");
  assert.equal(result.positions[0].cost, "0.00000000");
  assert.equal(result.positions[0].realized, "0.03000000");
});
test("missing historical FX is explicit; current rates are never substituted into history", () => {
  const missing = replay([row({ kind: "DEPOSIT", amount: "1000", fee: "0" })]);
  assert.equal(missing.accounts[0].contributions_myr, null);
  const known = replay([
    row({ kind: "DEPOSIT", amount: "1000", fee: "0", fx_rate: "4.5" }),
  ]);
  assert.equal(known.accounts[0].contributions_myr, "4500.00000000");
});
test("historical replay uses date then explicit same-day order", () => {
  const buy = row({ sequence: 1 }, 8),
    sell = row({ kind: "SELL", sequence: 2, quantity: "2" }, 1);
  assert.equal(replay([sell, buy]).positions[0].quantity, "8.00000000");
  assert.throws(() => replay([sell, { ...buy, sequence: 3 }]), /exceeds/);
});
test("validation rejects impossible dates, invalid currency, negative fees and zero quantities", () => {
  for (const values of [
    { occurred_on: "2026-02-30" },
    { occurred_on: "2099-01-01" },
    { currency: "MYR" },
    { fee: "-1" },
    { quantity: "0" },
    { price: "NaN" },
    { fee: "0.123456789" },
    { quantity: "1e2" },
  ])
    assert.throws(() => row(values));
});
