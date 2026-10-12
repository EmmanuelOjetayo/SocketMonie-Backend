const mongoose = require("mongoose");
const { RecoveryRepository } = require("../Repositories/RecoveryRepository");
const { FinancialLedgerService } = require("./FinancialLedgerService");
const AppError = require("../Utilis/AppError");

const createPaymentIntent = async ({ obligationId, guarantorUserId, amount }) => {
  const obligation = await RecoveryRepository.findForGuarantor(obligationId, guarantorUserId);
  if (!obligation) throw new AppError("Recovery obligation not found.", 404);
  if (!["active", "partially_paid"].includes(obligation.status)) throw new AppError("Recovery obligation is not payable.", 400);
  const paymentAmount = Number(amount);
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) throw new AppError("Payment amount must be positive.", 400);
  if (paymentAmount > obligation.remainingRecoveryBalance) throw new AppError("Payment exceeds the remaining recovery obligation.", 400);
  const reference = `RCP_${Date.now()}_${new mongoose.Types.ObjectId()}`;
  return RecoveryRepository.createPayment({
    obligationId: obligation._id,
    loanId: obligation.loanId,
    borrowerId: obligation.borrowerId,
    guarantorUserId,
    amount: paymentAmount,
    reference,
  }, null);
};

const listForGuarantor = (guarantorUserId) => RecoveryRepository.findForGuarantorUser(guarantorUserId);

const completePayment = async ({ reference, providerReference = null, callerUserId = null }) => {
  const session = await mongoose.startSession();
  let payment;
  try {
    await session.withTransaction(async () => {
      payment = await RecoveryRepository.findPaymentByReference(reference, session);
      if (!payment) throw new AppError("Recovery payment not found.", 404);
      if (payment.status === "completed") return;
      // Ownership: only the guarantor who owns this recovery payment may
      // report it complete. Anyone else is rejected — even other members.
      if (callerUserId && String(payment.guarantorUserId) !== String(callerUserId)) {
        throw new AppError("You are not authorized to complete this recovery payment.", 403);
      }
      const obligation = await RecoveryRepository.findForGuarantor(payment.obligationId, payment.guarantorUserId, session);
      if (!obligation) throw new AppError("Recovery obligation not found.", 404);
      const loan = await RecoveryRepository.findLoan(payment.loanId, session);
      if (!loan) throw new AppError("Loan not found.", 404);
      if (payment.amount > obligation.remainingRecoveryBalance) throw new AppError("Payment exceeds the remaining recovery obligation.", 409);
      if (payment.amount > loan.remainingBalance) throw new AppError("Payment exceeds the remaining loan balance.", 409);
      payment.status = "completed";
      payment.providerReference = providerReference;
      payment.paidAt = new Date();
      obligation.amountRecovered += payment.amount;
      obligation.remainingRecoveryBalance -= payment.amount;
      obligation.status = obligation.remainingRecoveryBalance <= 0 ? "completed" : "partially_paid";
      if (obligation.status === "completed") obligation.completedAt = payment.paidAt;
      obligation.paymentReferences.push(payment.reference);
      loan.amountPaid = Math.min(loan.totalRepayable, loan.amountPaid + payment.amount);
      loan.remainingBalance = Math.max(0, loan.remainingBalance - payment.amount);
      loan.recoveryStatus = loan.remainingBalance === 0 ? "recovered" : "in_recovery";
      if (loan.remainingBalance === 0) {
        loan.status = "completed";
        loan.completedAt = payment.paidAt;
      }
      await RecoveryRepository.savePayment(payment, session);
      await RecoveryRepository.saveObligation(obligation, session);
      await RecoveryRepository.saveLoan(loan, session);
      await FinancialLedgerService.recordEntry({
        entryType: "inflow",
        accountCategory: "recovery_repayment",
        activityType: "guarantor_recovery_deduction",
        amount: payment.amount,
        reference: payment.reference,
        userId: payment.guarantorUserId,
        relatedId: payment._id,
        relatedModel: "RecoveryObligations",
        notes: `Recovery payment for loan ${payment.loanId}`,
        session,
      });
    });
  } finally {
    await session.endSession();
  }
  return payment;
};

module.exports = { RecoveryService: { createPaymentIntent, completePayment, listForGuarantor } };