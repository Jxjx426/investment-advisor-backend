// Fixed-point decimal arithmetic: eight decimal places, no binary floating-point ledger math.
const SCALE = 100000000n;
function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function units(value, label = "Value") {
  const source = String(value ?? "");
  if (!/^-?\d{1,40}(\.\d{1,8})?$/.test(source))
    fail(`${label} must be a decimal with at most 8 decimal places.`);
  const [whole, fraction = ""] = source.replace("-", "").split(".");
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
  return source.startsWith("-") ? -result : result;
}
function text(value) {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / SCALE}.${String(absolute % SCALE).padStart(8, "0")}`;
}
function divide(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  return sign * ((sign * numerator + denominator / 2n) / denominator);
}
function multiply(a, b) {
  return divide(a * b, SCALE);
}
function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("A transaction object is required.");
  const owner_id = Number(input.owner_id);
  if (!Number.isSafeInteger(owner_id) || owner_id <= 0)
    fail("Choose an owner.");
  const kind = String(input.kind || "").toUpperCase();
  if (!["BUY", "SELL", "DEPOSIT", "WITHDRAWAL", "DIVIDEND"].includes(kind))
    fail("Choose buy, sell, deposit, withdrawal or dividend.");
  const occurred_on = String(input.occurred_on || "");
  const date = new Date(`${occurred_on}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(occurred_on) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== occurred_on
  )
    fail("Enter a valid transaction date.");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (occurred_on > today) fail("Future transactions cannot be recorded.");
  const sequence = Number(input.sequence ?? 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 1000000)
    fail("Same-day order must be a whole number from 0 to 1000000.");
  const trade = kind === "BUY" || kind === "SELL";
  const security = trade || kind === "DIVIDEND";
  const market = security ? String(input.market || "").toUpperCase() : null;
  if (security && !["US", "MY"].includes(market))
    fail("Choose US or Malaysia.");
  const currency = String(input.currency || "").toUpperCase();
  if (
    !["USD", "MYR"].includes(currency) ||
    (security && currency !== (market === "US" ? "USD" : "MYR"))
  )
    fail("US securities use USD; Malaysian securities use MYR.");
  const symbol = security
    ? String(input.symbol || "")
        .trim()
        .toUpperCase()
    : null;
  if (security && !/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(symbol))
    fail("Enter a stock ticker (e.g. AAPL or Bursa code 1155).");
  const quantity = trade ? units(input.quantity, "Quantity") : 0n;
  const price = trade ? units(input.price, "Price") : 0n;
  const amount = trade ? 0n : units(input.amount, "Amount");
  const fee = units(input.fee ?? "0", "Fee");
  if (
    [quantity, price, amount, fee].some(
      (value) => value > 99999999999999999999n,
    )
  )
    fail("Each entered value must be less than one trillion.");
  if (
    fee < 0n ||
    (trade && (quantity <= 0n || price <= 0n)) ||
    (!trade && amount <= 0n)
  )
    fail(
      "Quantity, price and cash amounts must be positive; fees cannot be negative.",
    );
  if (kind === "SELL" && fee > multiply(quantity, price))
    fail("The sell fee cannot exceed sale proceeds.");
  const fx =
    currency === "MYR"
      ? SCALE
      : input.fx_rate === "" || input.fx_rate == null
        ? null
        : units(input.fx_rate, "FX rate");
  if (fx !== null && (fx <= 0n || fx >= 1000000n * SCALE))
    fail("FX rate must be positive (MYR per 1 USD).");
  const notes = String(input.notes || "").trim();
  if (notes.length > 1000) fail("Notes must be 1000 characters or fewer.");
  return {
    owner_id,
    kind,
    occurred_on,
    sequence,
    market,
    symbol,
    currency,
    quantity: text(quantity),
    price: text(price),
    fee: text(fee),
    amount: text(amount),
    fx_rate: fx === null ? null : text(fx),
    notes,
  };
}
function replay(rows) {
  const positions = new Map(),
    accounts = new Map(),
    transactions = [];
  const sorted = [...rows]
    .filter((r) => !r.voided)
    .sort(
      (a, b) =>
        String(a.occurred_on).localeCompare(String(b.occurred_on)) ||
        a.sequence - b.sequence ||
        a.id - b.id,
    );
  for (const row of sorted) {
    const accountKey = `${row.owner_id}:${row.currency}`;
    if (!accounts.has(accountKey))
      accounts.set(accountKey, {
        owner_id: row.owner_id,
        currency: row.currency,
        balance: 0n,
        contributions: 0n,
        contributionsMyr: 0n,
        realized: 0n,
        fees: 0n,
        dividends: 0n,
      });
    const account = accounts.get(accountKey);
    const q = units(row.quantity),
      price = units(row.price),
      fee = units(row.fee),
      amount = units(row.amount),
      gross = multiply(q, price);
    account.fees += fee;
    let realized = null,
      cashChange;
    if (row.kind === "DEPOSIT" || row.kind === "WITHDRAWAL") {
      const contribution = amount * (row.kind === "DEPOSIT" ? 1n : -1n);
      account.contributions += contribution;
      account.contributionsMyr =
        account.contributionsMyr === null || !row.fx_rate
          ? null
          : account.contributionsMyr +
            multiply(contribution, units(row.fx_rate));
      cashChange = contribution - fee;
    } else if (row.kind === "DIVIDEND") {
      cashChange = amount - fee;
      account.dividends += cashChange;
    } else {
      const key = `${row.owner_id}:${row.market}:${row.symbol}`;
      if (!positions.has(key))
        positions.set(key, {
          owner_id: row.owner_id,
          market: row.market,
          symbol: row.symbol,
          currency: row.currency,
          quantity: 0n,
          cost: 0n,
          realized: 0n,
        });
      const position = positions.get(key);
      if (row.kind === "BUY") {
        position.quantity += q;
        position.cost += gross + fee;
        cashChange = -gross - fee;
      } else {
        if (q > position.quantity)
          fail(
            `${row.occurred_on}: ${row.symbol} sale exceeds this owner's available shares. Add earlier buys or correct the same-day order.`,
          );
        const allocated =
          q === position.quantity
            ? position.cost
            : divide(position.cost * q, position.quantity);
        realized = gross - fee - allocated;
        position.quantity -= q;
        position.cost -= allocated;
        position.realized += realized;
        account.realized += realized;
        cashChange = gross - fee;
      }
    }
    account.balance += cashChange;
    transactions.push({
      ...row,
      cash_change: text(cashChange),
      realized_pl: realized === null ? null : text(realized),
      running_cash: text(account.balance),
    });
  }
  return {
    accounts: [...accounts.values()].map((a) => ({
      owner_id: a.owner_id,
      currency: a.currency,
      balance: text(a.balance),
      contributions: text(a.contributions),
      contributions_myr:
        a.contributionsMyr === null ? null : text(a.contributionsMyr),
      realized: text(a.realized),
      fees: text(a.fees),
      dividends: text(a.dividends),
    })),
    positions: [...positions.values()].map((p) => ({
      ...p,
      quantity: text(p.quantity),
      cost: text(p.cost),
      average_cost:
        p.quantity === 0n ? text(0n) : text(divide(p.cost * SCALE, p.quantity)),
      realized: text(p.realized),
    })),
    transactions,
  };
}
module.exports = {
  normalize,
  replay,
  units,
  text,
  multiply,
  divide,
  fail,
  SCALE,
};
