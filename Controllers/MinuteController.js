const mongoose = require("mongoose");
const { startSafeSession } = require("../Utilis/transactionRunner");

const { verifyPayment, verifyTransactionById, FLW_PUBLIC_KEY, FLW_SUBACCOUNT_ID, FLW_SECRET_KEY } = require("../Utilis/Flutterwave");
const User = require("../Models/UserModel");
const Minutes = require("../Models/MinutesModel");
const Savings = require("../Models/SavingsModel");
const crypto = require("crypto");

const { logAudit } = require("../Utilis/auditLogger");
const {
  createNotification,
} = require("../Utilis/notificationHelper");
const { calculateFlutterwaveFee } = require("../Utilis/flutterwaveFee");
const MinuteTransaction = require("../Models/MinuteTransactionModel");
const { isSuccessfulStatus } = require("../Utilis/paymentStatus");
const { recordMinuteTransaction } = require("../Services/TransactionService");
const { updateUserScore } = require("../Utilis/scoreService");

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

    await Savings.create({
      userId,
      amount: totalPayable,
      type: "deposit",
      category: "minutes_payment",
      method: "flutterwave",
      status: "pending",
      reference,
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
 * =========================================================
 * VERIFY SOCKETMINUTES PAYMENT
 * =========================================================
 *
 * POST /api/payments/minutes/verify
 */
exports.verifyMinutes = async (
  req,
  res
) => {
  const session =
    await startSafeSession();

  try {
    const {
      reference,
      tx_ref,
      transaction_id,
      transactionId,
    } = req.body;

    const ref =
      tx_ref || reference || null;
    const txId =
      transaction_id || transactionId || (/^\d+$/.test(String(ref || "")) ? String(ref) : null);

    console.log(
      `[MINUTES CALLBACK] ① received | ref: ${ref} | TX: ${txId} | caller: ${req.user?._id?.toString() || "unauthenticated"}`
    );

    if (!ref && !txId) {
      return res.status(400).json({
        success: false,
        message:
          "Payment reference is required.",
      });
    }

    /**
     * -----------------------------------------------------
     * 0. IDEMPOTENCY GUARD (fix 3 — corrected collection/category)
     *
     * Reference: CAMP/GLS pattern —
     *   `$or: [{ reference: txRef }, { transactionId }]` checked
     *   BEFORE any credit. If the webhook and the frontend
     *   callback both arrive (or Flutterwave retries the
     *   webhook), the second caller gets "already processed"
     *   WITHOUT re-running settlement. The in-transaction
     *   re-fetch below remains the second layer of defence.
     *   We query the Minutes collection (category: monthly_contribution)
     *   because that is where completed minutes obligations live,
     *   not the Savings collection.
     * -----------------------------------------------------
     */
    const duplicateGuard = await Minutes.findOne({
      $or: [
        ...(ref ? [{ reference: ref }] : []),
        ...(txId ? [{ transactionId: String(txId) }] : []),
      ],
      category: "monthly_contribution",
      status: "completed",
    }).lean();

    if (duplicateGuard) {
      console.log(
        `[MINUTES CALLBACK] ✗ idempotent skip | ref: ${ref} | already completed (guard hit) — returning 200 without re-settling`
      );
      return res.status(200).json({
        success: true,
        message: "Transaction already processed.",
        alreadyVerified: true,
        idempotent: true,
        data: {
          reference: duplicateGuard.reference || ref,
          transactionId: duplicateGuard.transactionId || txId || null,
        },
      });
    }

    /**
     * -----------------------------------------------------
     * 1. Verify directly with Flutterwave (server-side).
     *    Prefer the numeric transaction id when available.
     * -----------------------------------------------------
     */
    const verification =
      txId && /^\d+$/.test(String(txId))
        ? await verifyTransactionById(String(txId))
        : await verifyPayment(ref);

    console.log(
      `[MINUTES CALLBACK] ② FLW verify | ref: ${ref} | TX: ${txId} | status: ${verification?.status} | dataStatus: ${verification?.data?.status || "—"} | tx_ref: ${verification?.data?.tx_ref || "—"} | amount: ${verification?.data?.amount_settled ?? verification?.data?.amount ?? "—"}`
    );

    if (
      verification?.status !==
        "success" ||
      !isSuccessfulStatus(verification?.data?.status)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Payment was not successful.",
      });
    }

    if (String(verification?.data?.currency || "NGN").toUpperCase() !== "NGN") {
      return res.status(400).json({
        success: false,
        message: "Currency mismatch.",
      });
    }

    // The tx_ref returned by Flutterwave must match the expected reference.
    const flwTxRef = String(verification?.data?.tx_ref || verification?.data?.reference || "");
    if (ref && flwTxRef && flwTxRef !== String(ref)) {
      return res.status(400).json({
        success: false,
        message: "Payment reference mismatch.",
      });
    }

    const flwData =
      verification.data;

    // [MINUTES CALLBACK] verification succeeded → proceeding to ownership check + settlement
    console.log(
      `[MINUTES VERIFY] FLW verification OK | ref: ${ref} | TX: ${transactionId} | status: ${verification.data?.status} | amount: ${flwData.charged_amount ?? flwData.amount ?? 0}`
    );

    /**
     * -----------------------------------------------------
     * 2. Get user from metadata.
     *
     * NEVER trust userId sent by frontend.
     * We use the Flutterwave meta generated by our
     * backend during initialization, falling back to the
     * authenticated caller — but the two must agree.
     * An authenticated member may only verify their own
     * SocketMinutes checkout (ownership check).
     * -----------------------------------------------------
     */
    const metaUserId =
      flwData?.meta?.userId ||
      flwData?.metadata?.userId ||
      "";

    const callerId = req.user?._id?.toString();

    if (
      metaUserId &&
      callerId &&
      String(metaUserId) !== String(callerId)
    ) {
      return res.status(403).json({
        success: false,
        message:
          "You are not authorized to verify this payment.",
      });
    }

    const userId =
      metaUserId || callerId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message:
          "Payment metadata is invalid.",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(
        userId
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid payment user.",
      });
    }

    /**
     * -----------------------------------------------------
     * 3. Get current outstanding obligations.
     * -----------------------------------------------------
     */
    await generateMonthlyObligations(
      userId
    );

    const outstanding =
      await getOutstandingMinutes(
        userId
      );

    if (!outstanding.length) {
      // The obligations were already settled before this verify pass ran (the
      // webhook is the fast settlement channel and can win the race). Return
      // the settled transaction receipt — full payload — instead of a bare
      // success flag, so a payment that DID succeed still resolves cleanly.
      const settledRecord = await MinuteTransaction.findOne({
        userId,
        $or: [
          ...(ref ? [{ reference: ref }] : []),
          ...(txId ? [{ transactionId: String(txId) }] : []),
        ],
      }).lean();
      const settledMonths =
        Number(settledRecord?.metadata?.monthsSettled) || 1;
      return res.json({
        success: true,
        alreadyVerified: true,
        message:
          "All SocketMinutes contributions are already settled.",
        data: {
          reference: ref,
          tx_ref: ref,
          transactionId: settledRecord?.transactionId || txId || null,
          contributionAmount: Number(settledRecord?.amount || 0),
          monthsSettled: settledMonths,
        },
      });
    }

    /**
     * -----------------------------------------------------
     * 4. Calculate exactly what the backend expected.
     * -----------------------------------------------------
     */
    const contributionAmount =
      calculateOutstandingAmount(
        outstanding
      );

    const {
      fee,
      totalPayable,
    } =
      calculateFlutterwaveFee(
        contributionAmount
      );

    /**
     * -----------------------------------------------------
     * 5. Verify the amount actually paid.
     *
     * Flutterwave v3 amounts are in NAIRA (major units).
     *
     * Gross vs settled (fix 4 — validated-amount capture,
     * reference-project intent, corrected for unit scale):
     * FLW returns BOTH `amount` (gross charged) and
     * `amount_settled` (net after FLW fees). We capture both
     * for the financial records and require a positive settled
     * value. We deliberately do NOT apply the reference
     * projects' `Math.floor(rawUsdCents / 100) * 100` trick:
     * that exists there because they inflate the charge by the
     * FLW fee and floor kobo back to wallet multiples. Here the
     * coverage check already compares the gross charge against
     * the exact server-computed `totalPayable` (which includes
     * our fee markup), and credit is month-settlement — flooring
     * naira to multiples of 100 would REJECT exact-fee payments
     * (e.g. charged ₦511 for an expected ₦511).
     * -----------------------------------------------------
     */
    const paidNaira = Number(flwData.charged_amount ?? flwData.amount ?? 0);
    const grossAmount = Number(flwData.amount ?? flwData.charged_amount ?? 0);
    const rawSettled = Number(flwData.amount_settled ?? 0);
    const settledNaira = rawSettled > 0 ? rawSettled : grossAmount;

    if (settledNaira <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid settlement amount.",
      });
    }

    const expectedNaira =
      totalPayable;

    console.log(
      `[MINUTES CALLBACK] ③ amount check | paid: ${paidNaira} | expected: ${expectedNaira} | settledNaira: ${settledNaira}`
    );

    if (paidNaira < expectedNaira) {
      return res.status(400).json({
        success: false,
        message:
          `Payment is insufficient. Expected ₦${totalPayable}, received ₦${paidNaira.toFixed(2)}.`,
      });
    }

    /**
     * -----------------------------------------------------
     * 6. ATOMIC SETTLEMENT
     *
     * All outstanding monthly obligations are completed
     * in ONE MongoDB transaction.
     *
     * If anything fails, none of them are marked completed.
     * -----------------------------------------------------
     */
    let settledMinutes = [];

    await session.withTransaction(
      async () => {
        /**
         * Re-fetch inside transaction to protect against
         * concurrent verification requests.
         */
        const currentOutstanding =
          await Minutes.find({
            userId,
            category:
              "monthly_contribution",

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
            })
            .session(session);

        if (
          !currentOutstanding.length
        ) {
          return;
        }

        /**
         * Recalculate inside transaction.
         */
        const currentAmount =
          calculateOutstandingAmount(
            currentOutstanding
          );

        /**
         * Make sure Flutterwave still covers the exact
         * obligations being settled.
         */
        const {
          totalPayable:
            currentTotalPayable,
        } =
          calculateFlutterwaveFee(
            currentAmount
          );

        if (
          paidNaira <
          currentTotalPayable
        ) {
          throw new Error(
            "Payment amount no longer covers all outstanding SocketMinutes obligations."
          );
        }

        /**
         * Complete ALL outstanding months.
         */
        const result =
          await Minutes.updateMany(
            {
              _id: {
                $in:
                  currentOutstanding.map(
                    (item) =>
                      item._id
                  ),
              },

              status: {
                $in: [
                  "pending",
                  "failed",
                  "overdue",
                ],
              },
            },

            {
              $set: {
                status:
                  "completed",

                transactionId:
                  String(
                    flwData.id
                  ),

                flutterwaveRef:
                  String(
                    flwData.id
                  ),

                paidAt:
                  new Date(),
              },
            },

            {
              session,
            }
          );

        if (
          result.modifiedCount !==
          currentOutstanding.length
        ) {
          throw new Error(
            "Not all SocketMinutes obligations could be settled."
          );
        }

        settledMinutes =
          currentOutstanding;

        console.log(
          `[MINUTES CALLBACK] ④ ATOMIC SETTLEMENT | settling ${currentOutstanding.length} outstanding month(s) | paid: ${paidNaira} | expected: ${currentTotalPayable}`
        );
      }
    );

    console.log(
      `[MINUTES CALLBACK] ⑤ settlement committed | settled months: ${settledMinutes.length}`
    );

    /**
     * -----------------------------------------------------
     * 6b. Mark the pending checkout Savings record as
     *     completed so reconciliation doesn't re-process it.
     * -----------------------------------------------------
     */
    await Savings.findOneAndUpdate(
      { reference: ref, status: "pending" },
      {
        $set: {
          status: "completed",
          transactionId: String(flwData.id),
        },
      }
    );

    /**
     * -----------------------------------------------------
     * 7. Notify member AFTER successful transaction.
     * -----------------------------------------------------
     */
    if (settledMinutes.length) {
      const settledAmount =
        settledMinutes.reduce(
          (sum, item) =>
            sum +
            Number(
              item.amount || 0
            ),
          0
        );

      await createNotification({
        userId,

        type: "minutes",

        title:
          "SocketMinutes Payment Successful",

        message:
          settledMinutes.length === 1
            ? "Your ₦500 SocketMinutes contribution has been received successfully."
            : `Your SocketMinutes payment of ₦${settledAmount.toLocaleString()} has cleared ${settledMinutes.length} outstanding monthly contributions.`,
      });

      /**
       * ---------------------------------------------------
       * 8. Audit
       * ---------------------------------------------------
       */
      await logAudit({
        userId,

        action:
          "monthly_minutes_arrears_paid",

        targetType:
          "minutes",

        targetId:
          settledMinutes[0]?._id,

        details: {
          reference: ref,

          transactionId:
            flwData.id,

          flutterwaveRef:
            String(flwData.id),

          contributionAmount:
            settledAmount,

          totalPaid:
            paidNaira,

          // Finance audit trail (fix 4): gross charged vs net
          // settled as reported by Flutterwave's authoritative
          // verification response.
          grossAmount,

          settledAmount: settledNaira,

          monthsSettled:
            settledMinutes.map(
              (item) => ({
                month:
                  item.month,

                year:
                  item.year,

                amount:
                  item.amount,
              })
            ),

          monthsCount:
            settledMinutes.length,
        },
      });
    }

    /**
     * -----------------------------------------------------
     * 9. Return success
     * -----------------------------------------------------
     */
    console.log(
      `[MINUTES CALLBACK] ✔ finished OK | ref: ${ref} | TX: ${flwData.id} | months settled: ${settledMinutes.length} | settled amount: ${settledAmount || "—"} — member notified + audit logged`
    );

    // Dual-write: dedicated minute transaction record (idempotent by reference).
    await recordMinuteTransaction({
      userId,
      reference: ref,
      transactionId: String(flwData.id),
      amount: paidNaira,
      currency: "NGN",
      status: "completed",
      method: "flutterwave",
      paidAt: new Date(),
      metadata: {
        source: "verifyMinutes",
        monthsSettled: settledMinutes.length,
        grossAmount,
        settledAmount: settledNaira,
      },
    });

    // SocketScore: minutes payment is verified financial activity — recalc
    // the current month provisionally (guarded; never fails verification).
    try {
      await updateUserScore(userId, "minutes_paid");
    } catch (scoreErr) {
      console.error("Minutes score update failed:", scoreErr?.message || scoreErr);
    }

    return res.json({
      success: true,

      message:
        "SocketMinutes contributions verified successfully.",

      data: {
        reference: ref,

        tx_ref: ref,

        transactionId:
          flwData.id,

        contributionAmount:
          settledMinutes.reduce(
            (sum, item) =>
              sum +
              Number(
                item.amount || 0
              ),
            0
          ),

        monthsSettled:
          settledMinutes.length,
      },
    });
  } catch (err) {
    console.error(
      "Verify Minutes error:",
      err
    );

    return res.status(err.statusCode || 500).json({
      success: false,
      message:
        err.message ||
        "Unable to verify SocketMinutes payment.",
    });
  } finally {
    await session.endSession();
  }
};
/**
 * =========================================================
 * GET MINUTES DUE
 * =========================================================
 *
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
