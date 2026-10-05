/**
 * Early Bird pricing.
 *
 * A competition stores its standard `fee` plus an optional `early_bird_fee`
 * that applies up to and including `early_bird_deadline`. The deadline is a
 * calendar date read in Pakistan time, so "on or before 10 October" holds until
 * midnight in Karachi rather than midnight UTC.
 *
 * Rows leaving the API go through `withPricing`, which makes `fee` the amount
 * payable today. Every screen and payment that reads `fee` therefore charges
 * the Early Bird price while it is live without knowing about it. The stored
 * price is kept as `standard_fee` for the admin edit form.
 */

const PRICING_TIME_ZONE = 'Asia/Karachi';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRICING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** Today's calendar date in Pakistan, as YYYY-MM-DD. */
const todayForPricing = () => dateFormatter.format(new Date());

/**
 * pg returns a DATE column as a Date at local midnight of the server, so the
 * calendar date is read back with local getters (not toISOString, which would
 * shift it a day on a server east of UTC).
 */
const toDateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
};

/** Price a competition row. Rows that never selected `fee` pass through untouched. */
const withPricing = (row) => {
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'fee')) return row;

  const standardFee = Number(row.fee || 0);
  const earlyBirdFee = row.early_bird_fee == null ? null : Number(row.early_bird_fee);
  const earlyBirdDeadline = toDateOnly(row.early_bird_deadline);
  const earlyBirdActive =
    earlyBirdFee !== null && earlyBirdDeadline !== null && earlyBirdDeadline >= todayForPricing();

  return {
    ...row,
    fee: earlyBirdActive ? earlyBirdFee : standardFee,
    standard_fee: standardFee,
    early_bird_fee: earlyBirdFee,
    early_bird_deadline: earlyBirdDeadline,
    early_bird_active: earlyBirdActive
  };
};

/** SQL twin of `withPricing`'s fee, for queries that build JSON in the database. */
const currentFeeSql = (alias) => `(CASE
  WHEN ${alias}.early_bird_fee IS NOT NULL
   AND ${alias}.early_bird_deadline >= (NOW() AT TIME ZONE '${PRICING_TIME_ZONE}')::date
  THEN ${alias}.early_bird_fee
  ELSE ${alias}.fee
END)`;

/**
 * The price to lock onto a registration made right now. `competition` must
 * already be through `withPricing`.
 */
const entryPricing = (competition) => {
  const unitFee = Number(competition.fee || 0);
  if (unitFee <= 0) return { unitFee: 0, feeTier: 'free' };
  return { unitFee, feeTier: competition.early_bird_active ? 'early_bird' : 'standard' };
};

/**
 * What a registration costs: the price locked when it was made, or — for
 * entries made before prices were locked — the competition's price today.
 */
const participantFeeSql = (participantAlias, competitionAlias) =>
  `COALESCE(${participantAlias}.unit_fee, ${currentFeeSql(competitionAlias)})`;

/**
 * Whether new registrations are accepted today, judged on Pakistan's calendar
 * like the Early Bird deadline: the closing date itself is still open.
 */
const registrationWindow = (competition) => {
  const today = todayForPricing();
  const deadline = toDateOnly(competition.registration_deadline);
  const startDate = toDateOnly(competition.start_date);
  const ended = startDate !== null && startDate < today;

  let reason = null;
  if (ended) reason = 'This competition has already taken place';
  else if (competition.status !== 'active') reason = 'Registration for this competition is not open';
  else if (deadline !== null && deadline < today) reason = 'The registration deadline for this competition has passed';

  return { open: reason === null, ended, reason };
};

module.exports = {
  withPricing,
  currentFeeSql,
  participantFeeSql,
  entryPricing,
  registrationWindow,
  toDateOnly,
  todayForPricing
};
