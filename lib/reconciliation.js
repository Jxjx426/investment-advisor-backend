const { replay, units, text, divide, calendarDate } = require("./accounting");
const { applyFundingSnapshots } = require("./funding");
function normalizeSnapshot(input) {
  const { normalize, fail } = require("./accounting");
  const as_of = calendarDate(input?.as_of);
  const cash = {};
  for (const currency of ["MYR", "USD"]) {
    const value = input.cash?.[currency];
    cash[currency] =
      value == null || value === ""
        ? null
        : text(units(value, `${currency} cash`));
    if (
      cash[currency] !== null &&
      (units(cash[currency]) >= 1000000000000n * 100000000n ||
        units(cash[currency]) <= -1000000000000n * 100000000n)
    )
      fail("Cash is outside the supported range.");
  }
  if (!Array.isArray(input.positions) || input.positions.length > 500)
    fail("Enter up to 500 broker positions.");
  const seen = new Set();
  const positions = input.positions.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      fail("Enter a valid broker position.");
    const checked = normalize({
      owner_id: 1,
      kind: "BUY",
      occurred_on: as_of,
      market: row.market,
      symbol: row.symbol,
      currency: row.market === "MY" ? "MYR" : "USD",
      quantity: "1",
      price: "1",
      fee: "0",
    });
    const quantity = units(row.quantity, "Broker shares");
    if (quantity < 0n || quantity >= 1000000000000n * 100000000n)
      fail(
        "Broker shares must be zero or positive, and less than one trillion.",
      );
    const key = `${checked.market}:${checked.symbol}`;
    if (seen.has(key)) fail("List each broker stock once.");
    seen.add(key);
    return {
      market: checked.market,
      symbol: checked.symbol,
      quantity: text(quantity),
    };
  });
  if (
    input.complete !== true &&
    input.complete !== false &&
    input.complete != null
  )
    fail("Choose whether all broker holdings are listed.");
  return { as_of, cash, positions, complete: input.complete === true };
}
function compare(rows, funding, snapshot) {
  const as_of = snapshot.as_of;
  const ledger = replay(rows.filter((row) => row.occurred_on <= as_of));
  const snapshots = funding
    .filter((row) => row.as_of <= as_of)
    .map((row) => ({ ...row }));
  applyFundingSnapshots(ledger, snapshots);
  const estimatedOwners = new Set(
    ledger.accounts
      .filter((row) => row.cash_estimated)
      .map((row) => row.owner_id),
  );
  for (const row of funding)
    if (row.as_of > as_of) estimatedOwners.add(row.owner_id);
  for (const row of snapshots)
    if (row.estimated || !row.applied) estimatedOwners.add(row.owner_id);
  const recorded = new Map();
  for (const position of ledger.positions) {
    const key = `${position.market}:${position.symbol}`;
    recorded.set(key, (recorded.get(key) || 0n) + units(position.quantity));
  }
  const actual = new Map(
    snapshot.positions.map((row) => [
      `${row.market}:${row.symbol}`,
      units(row.quantity),
    ]),
  );
  const keys = [...new Set([...recorded.keys(), ...actual.keys()])].sort();
  const positions = keys
    .map((key) => {
      const [market, symbol] = key.split(":"),
        book = recorded.get(key) || 0n,
        broker = actual.has(key)
          ? actual.get(key)
          : snapshot.complete
            ? 0n
            : null,
        difference = broker === null ? null : book - broker;
      return {
        market,
        symbol,
        recorded: text(book),
        broker: broker === null ? null : text(broker),
        difference: difference === null ? null : text(difference),
        status:
          difference === null
            ? "missing"
            : difference === 0n
              ? "matched"
              : "different",
      };
    })
    .filter((row) => units(row.recorded) !== 0n || row.broker !== null);
  const cash = ["MYR", "USD"].map((currency) => {
    const accounts = ledger.accounts.filter((row) => row.currency === currency),
      book = accounts.reduce((sum, row) => sum + units(row.balance), 0n),
      broker =
        snapshot.cash[currency] == null ? null : units(snapshot.cash[currency]);
    const difference = broker === null ? null : book - broker;
    const estimated =
      accounts.some((row) => estimatedOwners.has(row.owner_id)) ||
      funding.some((row) => row.as_of > as_of);
    return {
      currency,
      recorded: text(book),
      broker: broker === null ? null : text(broker),
      difference: difference === null ? null : text(difference),
      estimated,
      status:
        difference === null
          ? "missing"
          : divide(difference, 1000000n) !== 0n
            ? "different"
            : estimated
              ? "estimated"
              : "matched",
    };
  });
  return {
    as_of,
    positions,
    cash,
    share_mismatches: positions.filter((row) => row.status === "different")
      .length,
    cash_mismatches: cash.filter((row) => row.status === "different").length,
    missing:
      positions.filter((row) => row.status === "missing").length +
      cash.filter((row) => row.status === "missing").length,
    estimated: cash.some((row) => row.estimated),
  };
}
module.exports = { normalizeSnapshot, compare };
