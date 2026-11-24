const test = require("node:test");
const assert = require("node:assert/strict");

const { LoanRepository } = require("../Repositories/LoanRepository");
const notificationHelper = require("../Utilis/notificationHelper");
const auditLogger = require("../Utilis/auditLogger");
const transactionRunner = require("../Utilis/transactionRunner");

const makeLoan = (overrides = {}) => ({
  _id: "loan-1",
  userId: "user-1",
  loanNumber: "LN-001",
  principalAmount: 50000,
  status: "waiting_guarantor",
  amountPaid: 0,
  disbursedAt: null,
  approvedAt: null,
  payoutStatus: "pending",
  repaymentHistory: [],
  guarantors: [
    { userId: "g-1", isReplaced: false, status: "pending" },
    { userId: "g-2", isReplaced: false, status: "accepted" },
    { userId: "g-3", isReplaced: true, status: "rejected" },
  ],
  ...overrides,
});

const withFakeSession = async (fn) => {
  const original = transactionRunner.startSafeSession;
  transactionRunner.startSafeSession = async () => ({
    withTransaction: async (work) => work({}),
    endSession: async () => {},
  });
  delete require.cache[require.resolve("../Services/LoanService")];
  try {
    const { LoanService } = require("../Services/LoanService");
    return await fn(LoanService);
  } finally {
    transactionRunner.startSafeSession = original;
    delete require.cache[require.resolve("../Services/LoanService")];
  }
};

test("pre-approval loan termination deletes loan, cleans guarantor docs, and notifies guarantors", async () => {
  const original = {
    findById: LoanRepository.findById,
    findGuarantorDocumentsByLoanId: LoanRepository.findGuarantorDocumentsByLoanId,
    deleteGuarantorDocumentsByLoanId: LoanRepository.deleteGuarantorDocumentsByLoanId,
    deleteLoanById: LoanRepository.deleteLoanById,
    createNotification: notificationHelper.createNotification,
    logAudit: auditLogger.logAudit,
  };

  const calls = {
    deleteGuarantors: [],
    deleteLoan: [],
    notifications: [],
    audits: [],
  };

  LoanRepository.findById = async () => makeLoan();
  LoanRepository.findGuarantorDocumentsByLoanId = async () => [
    { guarantorUserId: "g-1", isReplaced: false },
    { guarantorUserId: "g-4", isReplaced: false },
  ];
  LoanRepository.deleteGuarantorDocumentsByLoanId = async (...args) => { calls.deleteGuarantors.push(args); return { deletedCount: 2 }; };
  LoanRepository.deleteLoanById = async (...args) => { calls.deleteLoan.push(args); return { deletedCount: 1 }; };
  notificationHelper.createNotification = async (payload) => { calls.notifications.push(payload); return payload; };
  auditLogger.logAudit = async (payload) => { calls.audits.push(payload); return payload; };

  try {
    const result = await withFakeSession((LoanService) => LoanService.cancelApplication({
      userId: "user-1",
      loanId: "loan-1",
      reason: "Personal reasons",
    }));

    assert.equal(result.deleted, true);
    assert.equal(result.status, "terminated");
    assert.equal(result.loanNumber, "LN-001");
    assert.equal(calls.deleteGuarantors.length, 1);
    assert.equal(calls.deleteLoan.length, 1);

    const notifiedIds = calls.notifications.map((n) => n.userId).sort();
    assert.deepEqual(notifiedIds, ["g-1", "g-2", "g-4"]);
    for (const n of calls.notifications) {
      assert.equal(n.type, "loan");
      assert.equal(n.data.status, "terminated");
      assert.match(n.message, /terminated by the applicant before admin approval/i);
    }

    assert.equal(calls.audits.length, 1);
    assert.equal(calls.audits[0].action, "loan_withdraw");
    assert.equal(calls.audits[0].details.deleted, true);
    assert.equal(calls.audits[0].details.reason, "Personal reasons");
  } finally {
    Object.assign(LoanRepository, {
      findById: original.findById,
      findGuarantorDocumentsByLoanId: original.findGuarantorDocumentsByLoanId,
      deleteGuarantorDocumentsByLoanId: original.deleteGuarantorDocumentsByLoanId,
      deleteLoanById: original.deleteLoanById,
    });
    notificationHelper.createNotification = original.createNotification;
    auditLogger.logAudit = original.logAudit;
  }
});

test("loan termination is blocked after admin approval/processing", async () => {
  const original = {
    findById: LoanRepository.findById,
    deleteGuarantorDocumentsByLoanId: LoanRepository.deleteGuarantorDocumentsByLoanId,
    deleteLoanById: LoanRepository.deleteLoanById,
  };

  LoanRepository.findById = async () => makeLoan({ status: "active" });
  LoanRepository.deleteGuarantorDocumentsByLoanId = async () => { throw new Error("should not delete guarantors"); };
  LoanRepository.deleteLoanById = async () => { throw new Error("should not delete loan"); };

  try {
    await withFakeSession((LoanService) => assert.rejects(
      () => LoanService.cancelApplication({ userId: "user-1", loanId: "loan-1" }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /before admin approval/i);
        return true;
      }
    ));
  } finally {
    Object.assign(LoanRepository, original);
  }
});

test("loan termination allows pending_review but not processed financials", async () => {
  const originalFind = LoanRepository.findById;
  try {
    LoanRepository.findById = async () => makeLoan({ status: "pending_review", amountPaid: 1 });
    await withFakeSession((LoanService) => assert.rejects(
      () => LoanService.cancelApplication({ userId: "user-1", loanId: "loan-1" }),
      (err) => err.statusCode === 400 && /already been processed/i.test(err.message)
    ));
  } finally {
    LoanRepository.findById = originalFind;
  }
});
