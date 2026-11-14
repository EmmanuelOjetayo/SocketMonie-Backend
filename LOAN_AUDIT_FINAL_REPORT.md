# SocketMonnie — Loan Workflow Audit & Fix Report
_Date: 2026-11-09 (verified against actual codebase)_

## A. Complete Loan User Journey (as implemented + after fixes)

**Eligibility (W1)** — `GET /api/loans/eligibility` → `LoanService.getEligibility` computes net savings, 6-month consistency (≥₦5,000/month), tier multiplier (first 1.5×, second 2.0×, emergency 0.75×), and `maxLoanAmount = netSavings × tier`. Enforced backend-side; `applyForLoan` re-runs eligibility and rejects over-limit or active-loan-blocked requests. Frontend shows eligibility but does not enforce it — backend is the gate. Fixed: AdminService defaultSettings aligned to LOAN_TIERS (LD-08).

**Application (W2)** — `POST /api/loans/apply` requires membership fee, terms gate, exactly 4 unique guarantor referral codes, creates loan waiting_guarantor. Interest rule verified: 2% flat, upfront deduction — `InterestCalculationService` → `Math.round(principal * 0.02)`; `disbursementAmount = principal − interest`; `totalRepayable = principal` (interest NOT added to repayable). Frontend never calculates interest (trusts backend). Not broken.

**Guarantor selection & invitation (W3)** — Backend enforces: no self-guarantee, no active guarantee elsewhere, guarantor net savings ≥ ₦70,000, capacity > 25% of amount, consistency. Invitations created with 48h tokens + notifications. Was returning one arbitrary guarantor (findOne on 4 docs). Fixed: repo returns all active guarantors (LD-05).

**Acceptance/rejection (W4)** — `POST /guarantors/respond` token-bound, owner-checked, expiry dual-persisted. Accept promotes to pending_review at 4/4; reject leaves loan waiting_guarantor. Replace endpoint exists. Partial fix (LD-07): added replaceGuarantor() service fn; full in-app replace UI not added — remaining blocker.

**Admin review (W5)** — Admin lists/details via /admin/loans, approves via approveAndDisburseLoan (SoD: admin ≠ borrower, admin ≠ guarantor; all 4 accepted). Members blocked by route + service checks. Fixed: LoansAdmin crashed on toast/TopHeader (missing imports, LD-01) — now imports correctly.

**Approval & disbursement (W6)** — CRITICAL BUSINESS-RULE BLOCKER (LD-02): approveAndDisburseLoan performs accounting-only disbursement — flips loan active/payoutStatus=completed, fabricates PAYOUT-ts, writes ledger, generates installments — no Flutterwave transfer, no beneficiary account collected, no bank verification. Admin copy fixed to honest wording. DO NOT treat as real-money disbursement.

**Activation & schedule (W7)** — Installments generated once on approval (even split, last takes remainder). Fixed (LD-13): LoanDetails destructured schedule as array → always empty — now reads schedule.schedule.

**Repayment processing (W8)** — Two-step: initialize (LRP_ ref) → verify (FLW-verified, ownership-checked, idempotent). Webhook: processWebhook routes LRP_/RPL_ → handleRepaymentWebhook → processLoanRepayment. Idempotency: repaymentHistory guard + Savings.transactionId unique + completed-status guards. FIFO allocation; penalty once per overdue installment; full settlement → completed + guarantors released. Fixed: verifyLoanRepayment allowlist unified to 5 payable statuses (LD-03); initialize includes recovery_120_days (LD-04).

**Missed payment / overdue (W9)** — Detection via runLoanDefaulterEscalation. Fixed (LD-06): no cron was scheduled — escalation was manual-only. Added loanDefaulterCron.js (daily 03:00) in Server/app.js.

**Default (W10)** — Thresholds: ≥30d warning_30_days; ≥60d defaulted_60_days + user restricted; ≥90d restricted_90_days + recovery obligations (remaining/4, no auto-deduction); ≥120d recovery_120_days + in_recovery. No automatic guarantor deductions by design.

**Closure (W11)** — remainingBalance ≤ 0 → completed + guarantors released. Closed loans rejected from further repay paths.

**Cancellation/rejection (W12)** — Cancel only in waiting_guarantor. Admin reject sets rejected. Duplicate payments rejected by idempotency. Fixed (LD-10): schema fields added for loan.rejectedAt/rejectedBy/lastPaymentAt, withdrawal.completedAt/totalDeducted/payoutFailedAt.

## B. Defect Register (see LOAN_DEFECT_REGISTER.md)

Fixed: LD-01, LD-03, LD-04, LD-05, LD-06, LD-07 partial, LD-08, LD-09, LD-10, LD-13, LD-14, LD-15, LD-16, LD-19. Remaining: LD-02 (P0 blocker), LD-07 UI, LD-12 dead file, LD-17 overpay rule.

## C. Financial Integrity
principal = requested; interest = round(principal × 0.02) upfront; disbursementAmount = principal − interest; totalRepayable = principal. remainingBalance = max(0, totalRepayable − amountPaid). Late penalties (2%, once/installment) add to totalRepayable + remainingBalance when applied. Every repayment writes Savings(type=loan_repayment, completed) + repaymentHistory + FinancialLedger inflow + LoanTransaction upsert. No double-credit path found. Risks: approve ≠ real payout; payoutReference/payoutRef split (unused, no transfer); overpayment rejected.

## D. Security
All loan routes behind protect + role authorize. SoD on approve. Guarantor respond token + expiry + ownership. Repayment verify FLW status/currency/ref + meta ownership. Webhook timing-safe signature. Guarantor-verify now public by token (48h expiry) matching backend public verify endpoint.

## E. Files Modified
Backend: Controllers/GuarantorController.js, Repositories/GuarantorRepository.js, Services/GuarantorService.js, Services/LoanService.js, Services/AdminService.js, Models/LoanModel.js, Models/SavingsModel.js, Server/app.js, Utilis/loanDefaulterCron.js (new).
Frontend: pages/admin/LoansAdmin.jsx, pages/user/LoanDetails.jsx, pages/user/LoanRepay.jsx, pages/user/Notifications.jsx, components/ui/Badge.jsx, components/loan/LoanSummaryCard.jsx, services/loans.js, routes/index.jsx.
Reports: LOAN_WORKFLOW_AUDIT.md, LOAN_DEFECT_REGISTER.md, LOAN_AUDIT_FINAL_REPORT.md.

## F. Test Results (actual)
- node --check (all modified backend files): clean ✅
- Tests/loanInterest.test.js: 10/10 passed ✅
- Tests/batchE.test.js: 9/9 passed ✅
- Frontend npm run build: passed ✅ (2874 modules, 25.07s)
- Not executed: full 30-scenario E2E with live DB/FLW/cron (no running server/test credentials here).

## G. Production Readiness Verdict
NOT PRODUCTION READY — Critical defect remains (real-money disbursement).

Evidence: LD-02 — disbursement is accounting-only with no Flutterwave transfer and no verified beneficiary collection. Approving a loan would mark it active/disbursed while no funds move. P0 financial failure.

To reach CONDITIONAL: (1) real idempotent disbursement or explicit manual off-platform payout state; (2) replace-guarantor UI; (3) 30-scenario E2E on staging with FLW test keys.

No code pushed, no deployments triggered.
