const mongoose = require("mongoose");

const { verifyPayment, verifyTransactionById, FLW_PUBLIC_KEY, FLW_SUBACCOUNT_ID } = require("../Utilis/Flutterwave");
const User = require("../Models/UserModel");
const Minutes = require("../Models/MinutesModel");

const { logAudit } = require("../Utilis/auditLogger");
const {
  createNotification,
} = require("../Utilis/notificationHelper");

const MONTHLY_MINUTES_AMOUNT = 500;

/**
 * ---------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------
 */

/**
 * Generate a unique internal reference.
 */
function generateReference(userId) {
  return `MIN_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 8)}_${userId
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

/**
 * ---------------------------------------------------------
 * Flutterwave processing fee (gross-up so the member covers it)
 * ---------------------------------------------------------
 *
 * This assumes the member pays the processing fee.
 *
 * Preserves the existing SocketMonnie pricing model:
 * 1.5% + ₦100 (waived under ₦2,500), capped at ₦2,000.
 */
function calculateFlutterwaveFee(amount) {
  const percentage = 0.015;
  const fixedFee = amount >= 2500 ? 100 : 0;
  const cap = 2000;

  // Standard gross-up formula
  let totalPayable = Math.ceil((amount + fixedFee) / (1 - percentage));
  let fee = totalPayable - amount;

  // Apply maximum cap of ₦2,000 on the fee
  if (fee > cap) {
    fee = cap;
    totalPayable = amount + cap;
  }

  return {
    fee,
    totalPayable,
  };
}

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
     * We do NOT create a new Minutes record here.
     *
     * Minutes records are monthly obligations.
     *
     * The Flutterwave tx_ref represents the settlement
     * of all those obligations.
     * -----------------------------------------------------
     */
    const reference =
      generateReference(userId);

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
          phone_number: user.phone || "",
        },

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
    await mongoose.startSession();

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

    if (!ref && !txId) {
      return res.status(400).json({
        success: false,
        message:
          "Payment reference is required.",
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

    if (
      verification?.status !==
        "success" ||
      String(verification?.data?.status || "").toLowerCase() !==
        "successful"
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

    /**
     * -----------------------------------------------------
     * 2. Get user from metadata.
     *
     * NEVER trust userId sent by frontend.
     * We use the Flutterwave meta generated by our
     * backend during initialization, falling back to the
     * authenticated caller.
     * -----------------------------------------------------
     */
    const userId =
      flwData?.meta?.userId ||
      flwData?.metadata?.userId ||
      req.user?._id?.toString();

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
      return res.json({
        success: true,
        message:
          "All SocketMinutes contributions are already settled.",
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
     * -----------------------------------------------------
     */
    const paidNaira = Number(flwData.charged_amount ?? flwData.amount ?? 0);

    const expectedNaira =
      totalPayable;

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