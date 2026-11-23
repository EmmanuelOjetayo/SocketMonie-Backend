const { MIN_MONTHLY_SAVINGS } = require("../Config/constants");

const SAVINGS_LEDGER_SCOPE = {
  type: { $in: ["deposit", "withdrawal"] },
  category: { $ne: "minutes_payment" },
};

const getEffectiveSavingsDate = (record) => {
  const raw = record?.historyDisplayAt || record?.paidAt || record?.completedAt || record?.createdAt;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

const monthLabel = (year, monthIndex) =>
  new Date(year, monthIndex, 1).toLocaleString("en-US", { month: "long", year: "numeric" });

/**
 * Build rolling 6-month window ending at current month (inclusive), oldest first.
 * Preserves the existing streak/consistency business definition.
 */
const buildRollingSixMonthWindow = (now = new Date()) => {
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1, // 1-12
      monthIndex: d.getMonth(),
      key: monthKey(d),
      label: monthLabel(d.getFullYear(), d.getMonth()),
    });
  }
  return months;
};

/**
 * Compute monthly qualifying savings from completed savings ledger records.
 * Qualifying net = eligible deposits - eligible withdrawals (completed only,
 * excluding minutes_payment). Each month is assessed independently.
 */
const computeMonthlyQualification = ({
  records = [],
  minimumMonthlyRequired = MIN_MONTHLY_SAVINGS,
  now = new Date(),
  windowMonths = 6,
} = {}) => {
  const minRequired = Number(minimumMonthlyRequired) || MIN_MONTHLY_SAVINGS;
  const window =
    windowMonths === 6
      ? buildRollingSixMonthWindow(now)
      : (() => {
          const months = [];
          for (let i = windowMonths - 1; i >= 0; i -= 1) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({
              year: d.getFullYear(),
              month: d.getMonth() + 1,
              monthIndex: d.getMonth(),
              key: monthKey(d),
              label: monthLabel(d.getFullYear(), d.getMonth()),
            });
          }
          return months;
        })();

  const byMonth = new Map();
  for (const m of window) byMonth.set(m.key, { deposits: 0, withdrawals: 0 });

  for (const record of records) {
    if (!record) continue;
    if (record.status !== "completed") continue;
    if (record.category === "minutes_payment") continue;
    const type = String(record.type || "").toLowerCase();
    if (type !== "deposit" && type !== "withdrawal") continue;
    const effectiveDate = getEffectiveSavingsDate(record);
    if (!effectiveDate) continue;
    const key = monthKey(effectiveDate);
    if (!byMonth.has(key)) continue; // outside rolling window
    const bucket = byMonth.get(key);
    const amount = Number(record.amount) || 0;
    if (type === "deposit") bucket.deposits += amount;
    if (type === "withdrawal") bucket.withdrawals += amount;
  }

  let qualifyingMonths = 0;
  const months = window.map((m) => {
    const bucket = byMonth.get(m.key) || { deposits: 0, withdrawals: 0 };
    const totalDeposits = Math.round(bucket.deposits * 100) / 100;
    const totalWithdrawals = Math.round(bucket.withdrawals * 100) / 100;
    const netSavings = Math.round((bucket.deposits - bucket.withdrawals) * 100) / 100;
    const qualified = netSavings >= minRequired;
    if (qualified) qualifyingMonths += 1;
    let reason = "Net qualifying savings met the minimum requirement.";
    if (!qualified) {
      if (totalDeposits === 0 && totalWithdrawals === 0) {
        reason = "No qualifying savings activity in this month.";
      } else if (netSavings < 0) {
        reason = "Withdrawals exceeded deposits for this month.";
      } else {
        reason = `Net qualifying savings (₦${netSavings.toLocaleString()}) is below the minimum required (₦${minRequired.toLocaleString()}).`;
      }
    }
    return {
      month: m.month,
      year: m.year,
      key: m.key,
      label: m.label,
      totalDeposits,
      totalWithdrawals,
      netSavings,
      minimumRequired: minRequired,
      qualified,
      contributesToStreak: qualified,
      reason,
    };
  });

  return {
    minimumMonthlyRequired: minRequired,
    windowMonths: window.length,
    qualifyingMonths,
    isConsistent: qualifyingMonths === window.length,
    months,
  };
};

module.exports = {
  SAVINGS_LEDGER_SCOPE,
  getEffectiveSavingsDate,
  buildRollingSixMonthWindow,
  computeMonthlyQualification,
};
