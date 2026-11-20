const { FLW_PUBLIC_KEY, FLW_SUBACCOUNT_ID, FLW_SECRET_KEY } = require("../Utilis/Flutterwave");
const User = require("../Models/UserModel");
const Minutes = require("../Models/MinutesModel");
const crypto = require("crypto");

const {
  createNotification,
} = require("../Utilis/notificationHelper");
const { calculateFlutterwaveFee } = require("../Utilis/flutterwaveFee");
const MinuteTransaction = require("../Models/MinuteTransactionModel");

const MONTHLY_MINUTES_AMOUNT = 500;

// Server-side diagnostic for the production-only checkout failure class
// ("key customer.id must not contain '.'" from Flutterwave's telemetry).
// We cannot read FLW account telemetry from this app, but we CAN verify the
// credential *mode* the deployed backend is running with: test vs live.
// A live public key paired with a test secret key (or vice versa) makes
// Flutterwave Inline fall back to the sandbox mock transaction flow, which is
// exactly when `MockFLWRef` values appear in the redirect payload.
const FLW_MODE = (() => {
  const pub = String(FLW_PUBLIC_KEY || "");
  const sec = String(FLW_SECRET_KEY || "");
  const pubTest = /_TEST/i.test(pub);
  const secTest = /_TEST/i.test(sec);
  return {
    publicKeyMode: pubTest ? "test" : pub ? "live" : "missing",
    secretKeyMode: secTest ? "test" : sec ? "live" : "missing",
    consistent: (pubTest && secTest) || (!pubTest && !secTest),
  };
})();

if (!FLW_MODE.consistent) {
  // Loud, actionable and secret-free: never log key values, only their mode.
  console.error(
    `❌ Flutterwave key mode mismatch: publicKey=${FLW_MODE.publicKeyMode}, secretKey=${FLW_MODE.secretKeyMode}. ` +
      `Checkout will produce mock references (MockFLWRef) until both keys come from the same Flutterwave environment.`
  );
}

/**
 * ---------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------
 */

/**
 * Generate a unique internal reference.
 *
 * Format follows the proven reference-project pattern
 * (CAMP: `YC-<id>-<ts>`, GLS: `GLS-OGB-<name>-<ts>-<rand>`):
 *   server-generated, prefix-tagged, collision-resistant
 *   `SocketMonnie-<userId>-<timestamp>` per the confirmed fix 2.
 * Never client-supplied and never contains characters Flutterwave
 * rejects (no dots, no spaces, no special punctuation).
 */
function generateReference(userId) {
  return `MIN_${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${userId
    .toString()
    .slice(-6)}`;
}

/**
 * Return every month between two dates.
 *
 * Example:
 *
 * May 2026 -> August 2026
 *
 * returns:
 *
 * [
 *   { month: 5, year: 2026 },
 *   { month: 6, year: 2026 },
 *   { month: 7, year: 2026 },
 *   { month: 8, year: 2026 }
 * ]
 */
function getMonthsBetween(startDate, endDate) {
  const months = [];

  let cursor = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    1
  );

  const end = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    1
  );

  while (cursor <= end) {
    months.push({
      month: cursor.getMonth() + 1,
      year: cursor.getFullYear(),
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months;
}

/**
 * ---------------------------------------------------------
 * Find member's SocketMinutes starting month
 * ---------------------------------------------------------
 *
 * We use the earliest Minutes record belonging to the user.
 *
 * This means:
 *
 * First payment/attempt = May
 * Today = August
 *
 * The system generates:
 *
 * May
 * June
 * July
 * August
 */
async function getMinutesStartDate(userId) {
  const latestMinutes = await Minutes.findOne({
    userId,
    category: "monthly_contribution",
  })
    .sort({
      updatedAt: -1,
      createdAt: -1,
    })
    .lean();

  if (latestMinutes) {
    return new Date(
      latestMinutes.year,
      latestMinutes.month - 1,
      1
    );
  }

  // No Minutes record yet.
  // Start from the user's registration month.
  const user = await User.findById(userId)
    .select("createdAt")
    .lean();

  if (!user) {
    throw new Error("User not found");
  }

  const createdAt = new Date(user.createdAt);

  return new Date(
    createdAt.getFullYear(),
    createdAt.getMonth(),
    1
  );
}
/**
 * ---------------------------------------------------------
 * Generate missing monthly obligations
 * ---------------------------------------------------------
 *
 * This is important.
 *
 * Suppose:
 *
 * May exists
 * June exists
 * July DOES NOT exist
 * August exists
 *
 * We automatically create July.
 *
 * Existing records are never duplicated because of the
 * unique userId/month/year index.
 */
async function generateMonthlyObligations(userId) {
  const now = new Date();

  const startDate =
    await getMinutesStartDate(userId);

  const currentMonthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  );

  const months = getMonthsBetween(
    startDate,
    currentMonthStart
  );

  const operations = [];

  for (const item of months) {
    operations.push({
      updateOne: {
        filter: {
          userId,
          month: item.month,
          year: item.year,
          category: "monthly_contribution",
        },

        update: {
          $setOnInsert: {
            userId,

            amount:
              MONTHLY_MINUTES_AMOUNT,

            month: item.month,

            year: item.year,

            type: "deposit",

            category:
              "monthly_contribution",

            status: "pending",

            reference:
              generateReference(userId),
          },
        },

        upsert: true,
      },
    });
  }

  if (operations.length > 0) {
    await Minutes.bulkWrite(
      operations,
      { ordered: false }
    );
  }

  /**
   * -----------------------------------------------------
   * Anything before the current month that is not
   * completed becomes overdue.
   * -----------------------------------------------------
   */

  const currentMonth =
    now.getMonth() + 1;

  const currentYear =
    now.getFullYear();

  await Minutes.updateMany(
    {
      userId,

      category:
        "monthly_contribution",

      status: {
        $in: [
          "pending",
          "failed",
        ],
      },

      $or: [
        {
          year: {
            $lt: currentYear,
          },
        },

        {
          year: currentYear,

          month: {
            $lt: currentMonth,
          },
        },
      ],
    },

    {
      $set: {
        status: "overdue",
      },
    }
  );

  return months;
}
/**
 * ---------------------------------------------------------
 * Get unpaid SocketMinutes obligations
 * ---------------------------------------------------------
 */
async function getOutstandingMinutes(userId) {
  return Minutes.find({
    userId,
    category: "monthly_contribution",

    status: {
      $in: [
        "pending",
        "failed",
        "overdue",
      ],
    },
  })
    .sort({
      year: 1,
      month: 1,
    });
}

/**
 * ---------------------------------------------------------
 * Calculate total contribution
 * ---------------------------------------------------------
 */
function calculateOutstandingAmount(
  obligations
) {
  return obligations.reduce(
    (total, obligation) =>
      total +
      Number(
        obligation.amount ||
          MONTHLY_MINUTES_AMOUNT
      ),
    0
  );
}

// Flutterwave processing fee helper moved to Utilis/flutterwaveFee.js
// (single source of truth — PaymentService shares the same formula).

// Backward-compat alias (same formula, old name).
/**
 * =========================================================
 * INITIALIZE MONTHLY SOCKETMINUTES PAYMENT
 * =========================================================
 *
 * POST /api/payments/minutes/initialize
 */
exports.initializeMinutes = async (
  req,
  res
) => {
  try {
    const userId = req.user._id;

    const user =
      await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    /**
     * -----------------------------------------------------
     * 1. Generate every missing month from the user's
     *    starting month until the current month.
     * -----------------------------------------------------
     */
    await generateMonthlyObligations(
      userId
    );

    /**
     * -----------------------------------------------------
     * 2. Find ALL unpaid months.
     * -----------------------------------------------------
     */
    const outstanding =
      await getOutstandingMinutes(
        userId
      );

    if (!outstanding.length) {
      return res.status(400).json({
        success: false,
        message:
          "Your SocketMinutes contribution is already fully paid.",
      });
    }

    /**
     * -----------------------------------------------------
     * 3. Calculate total arrears.
     * -----------------------------------------------------
     */
    const contributionAmount =
      calculateOutstandingAmount(
        outstanding
      );

    /**
     * Example:
     *
     * June     ₦500
     * July     ₦500
     * August   ₦500
     *
     * contributionAmount = ₦1,500
     */
    const {
      fee,
      totalPayable,
    } =
      calculateFlutterwaveFee(
        contributionAmount
      );

    /**
     * -----------------------------------------------------
     * 4. Create ONE payment reference for the entire
     *    outstanding balance.
     *
     * Save a pending record so the webhook and
     * reconciliation cron can find it by reference.
     * -----------------------------------------------------
     */
    const reference =
      generateReference(userId);

    // SocketMinutes payments belong to the dedicated MinuteTransaction model.
    // Never create a Savings row for them — doing so contaminates savings
    // balances, summaries and history.
    await MinuteTransaction.create({
      userId,
      amount: totalPayable,
      type: "minute_contribution",
      method: "flutterwave",
      currency: "NGN",
      status: "pending",
      reference,
      metadata: {
        months: outstanding.map((item) => ({
          month: item.month,
          year: item.year,
          amount: item.amount,
        })),
        monthsCount: outstanding.length,
        contributionAmount,
        fee,
        totalPayable,
      },
    });

    /**
     * -----------------------------------------------------
     * 5. Return Flutterwave Window Checkout payload.
     * -----------------------------------------------------
     */
    return res.json({
      success: true,

      data: {
        publicKey:
          FLW_PUBLIC_KEY,

        public_key:
          FLW_PUBLIC_KEY,

        reference,

        tx_ref: reference,

        txRef: reference,

        /**
         * Amount WITHOUT processing fee.
         */
        contributionAmount,

        /**
         * Processing fee.
         */
        fee,

        /**
         * Actual amount charged to member.
         */
        totalPayable,

        amount: totalPayable,

        currency: "NGN",

        customer: {
          email: user.email,
          name: user.fullName,
          // Working-project fallback (GLS/UBC): never send an EMPTY phone —
          // Flutterwave's telemetry/event endpoints 400 on empty customer
          // fields, surfacing as `key customer.id must not contain '.'`.
          phone_number: user.phone || "08000000000",
        },

        // Explicitly pin the checkout host + client-side credential mode so
        // the browser SDK can never drift to a different environment.
        checkout_url: "https://checkout.flutterwave.com/v3/hosted/pay",

        customizations: {
          title: "SocketMonnie",
          description:
            outstanding.length === 1
              ? "Monthly SocketMinutes Contribution"
              : `SocketMinutes arrears payment for ${outstanding.length} months`,
          logo: process.env.APP_LOGO || "",
        },

        meta: {
          userId:
            userId.toString(),

          type: "minutes",

          category:
            "monthly_contribution",

          contributionAmount,

          fee,

          totalPayable,

          monthsCount:
            outstanding.length,
        },

        metadata: {
          userId:
            userId.toString(),

          type: "minutes",

          category:
            "monthly_contribution",

          contributionAmount,

          fee,

          totalPayable,

          monthsCount:
            outstanding.length,

          months:
            outstanding.map(
              (item) => ({
                month: item.month,
                year: item.year,
                amount: item.amount,
              })
            ),
        },

        /**
         * Useful for frontend display.
         */
        outstandingMonths:
          outstanding.map(
            (item) => ({
              month: item.month,
              year: item.year,
              amount: item.amount,
              status: item.status,
            })
          ),

        // Split-payment subaccount — present ONLY in this one-time checkout payload.
        subaccount_id: FLW_SUBACCOUNT_ID || undefined,
      },
    });
  } catch (err) {
    console.error(
      "Initialize Minutes error:",
      err
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to initialize SocketMinutes payment.",
    });
  }
};

/**
 * GET /api/payments/minutes/due
 *
 * Calculates all unpaid SocketMinutes contributions
 * from the member's starting month up to the current month.
 */


exports.getMinutesDue = async (req, res) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required.",
      });
    }

    const user = await User.findById(userId)
      .select("createdAt")
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    /**
     * -----------------------------------------------------
     * Generate every missing monthly obligation.
     *
     * The generator starts from the user's latest
     * Minutes record based on updatedAt and continues
     * through the current month.
     *
     * Missing months are physically created in MongoDB.
     * Previous unpaid months are marked overdue.
     * -----------------------------------------------------
     */
    await generateMonthlyObligations(userId);

    /**
     * -----------------------------------------------------
     * Get all outstanding Minutes records.
     * -----------------------------------------------------
     */
    const outstanding =
      await getOutstandingMinutes(userId);

    /**
     * -----------------------------------------------------
     * Format due months.
     * -----------------------------------------------------
     */
    const dueMonths = outstanding.map(
      (item) => ({
        month: item.month,
        year: item.year,
        amount:
          Number(
            item.amount ||
              MONTHLY_MINUTES_AMOUNT
          ),
        status: item.status,
      })
    );

    /**
     * -----------------------------------------------------
     * Calculate total due.
     * -----------------------------------------------------
     */
    const totalDue =
      calculateOutstandingAmount(
        outstanding
      );

    /**
     * -----------------------------------------------------
     * Response
     * -----------------------------------------------------
     */
    return res.status(200).json({
      success: true,

      data: {
        monthsDue:
          dueMonths.length,

        totalDue,

        monthlyAmount:
          MONTHLY_MINUTES_AMOUNT,

        dueMonths,
      },
    });
  } catch (error) {
    console.error(
      "Get Minutes Due Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        "Unable to calculate Minutes due.",
    });
  }
};
