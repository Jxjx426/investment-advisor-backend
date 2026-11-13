const SCALE = 100000000n;
const KINDS = [
  "BUY",
  "SELL",
  "DEPOSIT",
  "WITHDRAWAL",
  "DIVIDEND",
  "FX",
  "TRANSFER",
  "SPLIT",
  "OPENING_CASH",
  "OPENING_POSITION",
  "TAX",
];
const FIELDS = [
  "owner_id",
  "kind",
  "occurred_on",
  "sequence",
  "market",
  "symbol",
  "currency",
  "quantity",
  "price",
  "fee",
  "amount",
  "fx_rate",
  "notes",
  "counterparty_owner_id",
  "target_currency",
  "target_amount",
  "tax",
  "split_from",
  "split_to",
  "fx_estimated",
];
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
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function calendarDate(value) {
  const source = String(value || ""),
    date = new Date(`${source}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(source) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== source
  )
    fail("Enter a valid transaction date.");
  if (source > today()) fail("Future transactions cannot be recorded.");
  return source;
}
function decimal(value, label, allowZero = false) {
  const result = units(value, label);
  if (
    result < 0n ||
    (!allowZero && result === 0n) ||
    result >= 1000000000000n * SCALE
  )
    fail(
      `${label} must be ${allowZero ? "zero or positive" : "positive"} and less than one trillion.`,
    );
  return result;
}
function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("A transaction object is required.");
  const owner_id = Number(input.owner_id);
  if (!Number.isSafeInteger(owner_id) || owner_id <= 0)
    fail("Choose an owner.");
  const kind = String(input.kind || "").toUpperCase();
  if (!KINDS.includes(kind)) fail("Choose a supported transaction type.");
  const occurred_on = calendarDate(input.occurred_on),
    sequence = Number(input.sequence ?? 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 1000000)
    fail("Same-day order must be a whole number from 0 to 1000000.");
  const trade = ["BUY", "SELL"].includes(kind),
    security =
      trade || ["DIVIDEND", "SPLIT", "OPENING_POSITION"].includes(kind);
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
  const quantity =
    trade || kind === "OPENING_POSITION"
      ? decimal(input.quantity, "Quantity")
      : 0n;
  let price = trade ? decimal(input.price, "Price") : 0n;
  const amount =
    !trade && kind !== "SPLIT"
      ? decimal(input.amount, "Amount", kind === "OPENING_CASH")
      : 0n;
  const fee = decimal(input.fee ?? "0", "Fee", true),
    tax =
      kind === "DIVIDEND"
        ? decimal(input.tax ?? "0", "Withholding tax", true)
        : 0n;
  if (
    ["SPLIT", "OPENING_CASH", "OPENING_POSITION", "TAX"].includes(kind) &&
    fee !== 0n
  )
    fail("This entry has no separate fee.");
  if (kind === "SELL" && fee > multiply(quantity, price))
    fail("The sell fee cannot exceed sale proceeds.");
  if (kind === "DIVIDEND" && fee + tax > amount)
    fail("Dividend tax and fees cannot exceed the gross dividend.");
  if (kind === "OPENING_POSITION") price = divide(amount * SCALE, quantity);
  let fx =
    currency === "MYR"
      ? SCALE
      : input.fx_rate === "" || input.fx_rate == null
        ? null
        : units(input.fx_rate, "FX rate");
  const target_currency =
    kind === "FX" ? String(input.target_currency || "").toUpperCase() : null;
  const target_amount =
    kind === "FX" ? decimal(input.target_amount, "Amount received") : 0n;
  if (kind === "FX") {
    if (
      !["MYR", "USD"].includes(target_currency) ||
      target_currency === currency
    )
      fail("Exchange MYR to USD or USD to MYR.");
    fx =
      currency === "MYR"
        ? divide(amount * SCALE, target_amount)
        : divide(target_amount * SCALE, amount);
  }
  if (fx !== null && (fx <= 0n || fx >= 1000000n * SCALE))
    fail("FX rate must be positive (MYR per 1 USD).");
  const counterparty_owner_id =
    kind === "TRANSFER" ? Number(input.counterparty_owner_id) : null;
  if (
    kind === "TRANSFER" &&
    (!Number.isSafeInteger(counterparty_owner_id) ||
      counterparty_owner_id <= 0 ||
      counterparty_owner_id === owner_id)
  )
    fail("Choose a different receiving owner.");
  const split_from =
      kind === "SPLIT" ? decimal(input.split_from, "Old shares") : 0n,
    split_to = kind === "SPLIT" ? decimal(input.split_to, "New shares") : 0n;
  if (kind === "SPLIT" && split_from === split_to)
    fail("The split ratio must change the shares.");
  const notes = String(input.notes || "").trim();
  if (notes.length > 1000) fail("Notes must be 1000 characters or fewer.");
  if (
    kind === "FX" &&
    ![undefined, null, false, true, 0, 1].includes(input.fx_estimated)
  )
    fail("Choose actual or estimated FX.");
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
    counterparty_owner_id,
    target_currency,
    target_amount: text(target_amount),
    tax: text(tax),
    split_from: text(split_from),
    split_to: text(split_to),
    fx_estimated:
      kind === "FX" && (input.fx_estimated === true || input.fx_estimated === 1)
        ? 1
        : 0,
  };
}
function replay(rows) {
  const positions = new Map(),
    accounts = new Map(),
    transactions = [],
    cashStarted = new Set(),
    openingOwners = new Set();
  function account(owner, currency) {
    const key = `${owner}:${currency}`;
    if (!accounts.has(key))
      accounts.set(key, {
        owner_id: owner,
        currency,
        balance: 0n,
        contributions: 0n,
        contributionsMyr: 0n,
        realized: 0n,
        fees: 0n,
        dividends: 0n,
        taxes: 0n,
        transfers: 0n,
        transfersMyr: 0n,
        opening: 0n,
        has_opening_cash: false,
        fx_estimated: false,
      });
    return accounts.get(key);
  }
  const sorted = [...rows]
    .filter((row) => !row.voided)
    .sort(
      (a, b) =>
        String(a.occurred_on).localeCompare(String(b.occurred_on)) ||
        a.sequence - b.sequence ||
        a.id - b.id,
    );
  for (const row of sorted) {
    const current = account(row.owner_id, row.currency),
      q = units(row.quantity),
      price = units(row.price),
      fee = units(row.fee),
      amount = units(row.amount),
      tax = units(row.tax ?? "0"),
      gross = multiply(q, price),
      legs = [];
    const leg = (owner, currency, change) => {
      const entry = account(owner, currency);
      entry.balance += change;
      cashStarted.add(`${owner}:${currency}`);
      legs.push({
        owner_id: owner,
        currency,
        cash_change: text(change),
        running_cash: text(entry.balance),
      });
    };
    let realized = null;
    current.fees += fee;
    if (["DEPOSIT", "WITHDRAWAL"].includes(row.kind)) {
      const contribution = amount * (row.kind === "DEPOSIT" ? 1n : -1n);
      current.contributions += contribution;
      current.contributionsMyr =
        current.contributionsMyr === null || !row.fx_rate
          ? null
          : current.contributionsMyr +
            multiply(contribution, units(row.fx_rate));
      leg(row.owner_id, row.currency, contribution - fee);
    } else if (row.kind === "DIVIDEND") {
      const net = amount - fee - tax;
      current.dividends += net;
      current.taxes += tax;
      leg(row.owner_id, row.currency, net);
    } else if (row.kind === "TAX") {
      current.taxes += amount;
      leg(row.owner_id, row.currency, -amount);
    } else if (row.kind === "FX") {
      const target = account(row.owner_id, row.target_currency);
      leg(row.owner_id, row.currency, -amount - fee);
      leg(row.owner_id, row.target_currency, units(row.target_amount));
      if (row.fx_estimated) {
        current.fx_estimated = true;
        target.fx_estimated = true;
      }
    } else if (row.kind === "TRANSFER") {
      const target = account(row.counterparty_owner_id, row.currency);
      current.transfers -= amount;
      target.transfers += amount;
      if (row.fx_rate) {
        const converted = multiply(amount, units(row.fx_rate));
        if (current.transfersMyr !== null) current.transfersMyr -= converted;
        if (target.transfersMyr !== null) target.transfersMyr += converted;
      } else {
        current.transfersMyr = null;
        target.transfersMyr = null;
      }
      leg(row.owner_id, row.currency, -amount - fee);
      leg(row.counterparty_owner_id, row.currency, amount);
    } else if (row.kind === "OPENING_CASH") {
      if (
        cashStarted.has(`${row.owner_id}:${row.currency}`) ||
        current.has_opening_cash
      )
        fail(
          `${row.occurred_on}: opening cash must precede this owner's ${row.currency} cash activity.`,
        );
      current.opening += amount;
      current.has_opening_cash = true;
      openingOwners.add(row.owner_id);
      leg(row.owner_id, row.currency, amount);
    } else {
      const key = `${row.owner_id}:${row.market}:${row.symbol}`;
      if (row.kind === "OPENING_POSITION" && positions.has(key))
        fail(
          "Opening shares must precede all trades for that owner and stock.",
        );
      if (!positions.has(key))
        positions.set(key, {
          owner_id: row.owner_id,
          market: row.market,
          symbol: row.symbol,
          currency: row.currency,
          quantity: 0n,
          cost: 0n,
          realized: 0n,
          opening_position: false,
        });
      const position = positions.get(key);
      if (row.kind === "BUY") {
        position.quantity += q;
        position.cost += gross + fee;
        leg(row.owner_id, row.currency, -gross - fee);
      } else if (row.kind === "OPENING_POSITION") {
        position.quantity = q;
        position.cost = amount;
        position.opening_position = true;
        openingOwners.add(row.owner_id);
        current.opening += amount;
      } else if (row.kind === "SPLIT") {
        if (position.quantity === 0n)
          fail("A stock split requires existing shares for this owner.");
        const numerator = position.quantity * units(row.split_to),
          denominator = units(row.split_from);
        if (numerator % denominator !== 0n)
          fail(
            "This split creates shares beyond 8 decimals. Record the broker adjustment and any cash in lieu before continuing.",
          );
        position.quantity = numerator / denominator;
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
        current.realized += realized;
        leg(row.owner_id, row.currency, gross - fee);
      }
    }
    transactions.push({
      ...row,
      cash_legs: legs,
      cash_change: text(legs[0] ? units(legs[0].cash_change) : 0n),
      realized_pl: realized === null ? null : text(realized),
      running_cash: legs[0]?.running_cash ?? null,
    });
  }
  return {
    accounts: [...accounts.values()].map((entry) => ({
      owner_id: entry.owner_id,
      currency: entry.currency,
      ...Object.fromEntries(
        [
          "balance",
          "contributions",
          "realized",
          "fees",
          "dividends",
          "taxes",
          "transfers",
          "opening",
        ].map((field) => [field, text(entry[field])]),
      ),
      contributions_myr:
        entry.contributionsMyr === null ? null : text(entry.contributionsMyr),
      transfers_myr:
        entry.transfersMyr === null ? null : text(entry.transfersMyr),
      has_opening_cash: entry.has_opening_cash,
      cash_estimated:
        entry.fx_estimated ||
        (openingOwners.has(entry.owner_id) && !entry.has_opening_cash),
    })),
    positions: [...positions.values()].map((position) => ({
      ...position,
      quantity: text(position.quantity),
      cost: text(position.cost),
      average_cost:
        position.quantity === 0n
          ? text(0n)
          : text(divide(position.cost * SCALE, position.quantity)),
      realized: text(position.realized),
    })),
    transactions,
    opening_owners: [...openingOwners],
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
  KINDS,
  FIELDS,
  calendarDate,
  today,
};
