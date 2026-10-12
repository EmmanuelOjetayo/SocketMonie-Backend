const FinancialLedger = require("../Models/FinancialLedgerModel");

const FinancialLedgerRepository = {
  findByEventKey: (eventKey, session = null) => {
    const query = FinancialLedger.findOne({ eventKey });
    if (session) query.session(session);
    return query;
  },
  createEntry: (entryData, session = null) => {
    if (session) {
      return FinancialLedger.create([entryData], { session }).then((docs) => docs[0]);
    }
    return FinancialLedger.create(entryData);
  },

  findEntries: (filter, skip = 0, limit = 50) =>
    FinancialLedger.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "fullName email")
      .lean(),

  countEntries: (filter) => FinancialLedger.countDocuments(filter),

  aggregateSummary: async (filter = {}) => {
    const pipeline = [
      { $match: { status: "posted", ...filter } },
      {
        $group: {
          _id: {
            entryType: "$entryType",
            accountCategory: "$accountCategory",
            activityType: "$activityType",
          },
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ];
    return await FinancialLedger.aggregate(pipeline);
  },
};

module.exports = { FinancialLedgerRepository };
