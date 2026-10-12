const RecoveryObligation = require("../Models/RecoveryObligationModel");
const RecoveryPayment = require("../Models/RecoveryPaymentModel");
const Loan = require("../Models/LoanModel");

const RecoveryRepository = {
  findForGuarantorUser: (guarantorUserId) => RecoveryObligation.find({ guarantorUserId }).sort({ createdAt: -1 }).lean(),
  findForGuarantor: (obligationId, guarantorUserId, session = null) => {
    const query = RecoveryObligation.findOne({ _id: obligationId, guarantorUserId });
    if (session) query.session(session);
    return query;
  },
  createPayment: (data, session) => RecoveryPayment.create([data], { session }).then(([payment]) => payment),
  findPaymentByReference: (reference, session = null) => {
    const query = RecoveryPayment.findOne({ reference });
    if (session) query.session(session);
    return query;
  },
  savePayment: (payment, session) => payment.save({ session }),
  saveObligation: (obligation, session) => obligation.save({ session }),
  findLoan: (loanId, session = null) => {
    const query = Loan.findById(loanId);
    if (session) query.session(session);
    return query;
  },
  saveLoan: (loan, session) => loan.save({ session }),
};

module.exports = { RecoveryRepository };