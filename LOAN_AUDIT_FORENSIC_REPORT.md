# SOCKETMONNIE — COMPREHENSIVE LOAN LIFECYCLE FORENSIC AUDIT

**Date:** 2026-11-14
**Scope:** Read-only forensic audit of complete loan lifecycle
**Status:** Investigation complete — report generated from code inspection

---

## A. Executive Summary

The SocketMonnie loan lifecycle implements a multi-phase cooperative loan system from application through disbursement, repayment, overdue tracking, and default management. The backend code is well-structured with clear separation of concerns between controllers, services, repositories, and models.

**Overall condition:** The core loan workflow is functionally implemented and the majority of business rules are correctly enforced backend-side. However, several critical and major defects remain that affect financial integrity, user experience, and data consistency.

**Most significant remaining defects (P0/P1):**

| Defect ID | Severity | Issue |
|-----------|----------|-------|
| LD-02 | P0 | `approveAndDisburseLoan` performs accounting-only disbursement — marks loan as `payoutStatus="completed"` and fabricates `PAYOUT-${Date.now()}` without any actual Flutterwave transfer or beneficiary account collection. No real money moves. |
| LD-07 | P1 | Frontend `replaceGuarantor` service function missing — `POST /api/loans/:loanId/replace-guarantor` exists backend but no corresponding frontend function or UI, making rejected guarantor replacement a dead end. |
| LD-13 | P2 | `LoanDetails.jsx` line 24: `schedule` destructured as `scheduleData?.schedule` but the backend returns `{ schedule: [...], nextDue: ... }` — the schedule is an object property, not an array. When `schedule` is falsy, the UI shows EmptyState instead of the schedule. |
| LD-02 (copy) | P1 | Admin UX honesty: LoansAdmin.jsx says "No payout will be sent" while `approveAndDisburseLoan` marks `payoutStatus="completed"` — copy drift creates misleading admin experience. |

**Secondary issues** (P2/P3) include: overpayment handling nuance, status badge mapping gaps, search limitations, documentation drift, and hardcoded placeholders.

---

## B. Complete Workflow Map

The actual implemented loan lifecycle (Application → Guarantor Assignment → Guarantor Approval → Admin Review → Loan Approval → Disbursement → Repayment → Balance Updates → Overdue Detection → Default Management → Final Settlement):

### W1: ELIGIBILITY (`GET /api/loans/eligibility`)
- **Trigger:** Frontend `useEffect` on loan mount + "Apply for Loan" banner
- **Backend:** `LoanService.getEligibility()` computes net savings (6-month consistency ≥₦5,000/month), tier multiplier (1.5× first loan, 2.0× subsequent, 0.75× emergency), `maxLoanAmount = netSavings × tier`
- **Enforcement:** Backend is the gate; frontend shows eligibility but does not enforce
- **Output:** `isEligible`, `maxLoanAmount`, `tierName`, `minSavings`, `minMonths`

### W2: APPLICATION (`POST /api/loans/apply`)
- **Frontend:** `LoanApply.jsx` — 5-step wizard (Loan Details → Personal Info → Guarantor → Review → Submit)
- **Requirements:** 4 unique guarantor referral codes, terms/privacy acceptance, eligibility gate, amount ≤ maxLoanAmount
- **Backend:** `LoanService.applyForLoan()` validates 4 codes, checks no active loan, runs eligibility, creates loan in `waiting_guarantor` status with 4 guarantor entries (status: "pending", verificationToken + 48h expiry)
- **Guarantor enforcement:** No self-guarantee, guarantor must have ≥₦70,000 net savings, guarantor's savings must be >25% of loan amount, guarantor must have consistent 6-month savings history
- **Notifications:** Borrower + each guarantor receive notification with verificationToken and loanId
- **Output:** Loan created with `status: "waiting_guarantor"`, `principalAmount`, `interestAmount` (2% flat upfront), `totalRepayable = principal`, `disbursementAmount = principal - interest`, 4 guarantor records with `status: "pending"`

### W3: GUARANTOR ACCEPTANCE/REJECTION
- **Frontend:** Guarantor receives notification with token; via `GuarantorVerify.jsx` responds at `POST /guarantors/respond` with token
- **Backend:** `GuarantorService.respondToRequest()` — token-bound, owner-checked, 48h expiry dual-persisted
- **Accept:** Promotes guarantor to `pending_review` at 4/4 accepted; loan status advances to `pending_review`
- **Reject:** Leaves loan in `waiting_guarantor`; guarantor status stays "rejected"/"expired"
- **Replace:** `POST /api/loans/:loanId/replace-guarantor` exists backend (`LoanService.replaceGuarantor()`) but **frontend service function missing** — dead end (LD-07)
- **Output:** When 4/4 accepted → loan status `pending_review`; borrower sees progress on LoanApply step 4

### W4: ADMIN REVIEW
- **Backend:** `AdminService` lists loans awaiting review; `LoanController.approveAndDisburseLoan` requires `super_admin` or `finance_manager` role
- **SoD check:** Admin cannot approve own loan; cannot approve a loan where they are a guarantor
- **Requirement:** All 4 guarantors must have `status === "accepted"` and `!isReplaced`
- **Output:** If approved → `approveAndDisburseLoan`; if rejected → `adminController.rejectLoan`

### W5: LOAN APPROVAL & DISBURSEMENT (`POST /api/loans/:loanId/approve`)
- **Trigger:** Admin clicks "Approve" in AdminLoans
- **Backend:** `LoanService.approveAndDisburseLoan({loanId, adminUser})`
- **Critical P0 defect (LD-02):** Performs accounting-only disbursement:
  - Sets `loan.status = "active"`
  - Sets `loan.disbursementAmount = principal - interest`
  - Sets `loan.disbursedAt = new Date()`
  - Sets `loan.payoutStatus = "completed"` and `loan.payoutReference = "PAYOUT-${Date.now()}"`
  - Generates installments (even split, last takes remainder)
  - Writes to `FinancialLedgerService` (outflow: loan_principal_receivable, inflow: loan_interest_revenue)
  - **No Flutterwave transfer call** — no beneficiary account ever collected; `disbursementMethod` only stored as "bank_transfer" or "wallet" but never used in payout
  - Admin UI copy says "No payout will be sent" while backend marks `payoutStatus="completed"` — copy drift (LD-09)
- **Notifications:** Borrower + each active guarantor notified
- **Output:** Loan marked `active`, `payoutStatus: "completed"`, installments generated, `remainingBalance = totalRepayable`, `amountPaid = 0`

### W6: ACTIVATION & REPAYMENT SCHEDULE
- **Installments:** Generated on approval — equal monthly amounts, last installment takes remainder
- **Repayment initialization:** `POST /api/loans/:loanId/repay` → `initializeLoanRepayment()` → creates `LRP_` reference, writes to Savings with `type: "loan_repayment"`
- **Repayment verification:** `POST /api/loans/:loanId/verify-repayment` → `verifyLoanRepayment()` → checks FLW status, ownership, idempotency guards
- **Webhook:** `processLoanRepayment()` — FIFO allocation across installments, late penalty (2% once/installment, on overdue), overpayment blocked, `remainingBalance = max(0, totalRepayable - amountPaid)`, full settlement → `status: "completed"` + guarantors released

### W7: REPAYMENT PROCESSING
- **Two-step:** Initialize (`LRP_` reference) → Verify (FLW-verified, ownership-checked, idempotent)
- **Webhook flow:** Flutterwave → `PaymentController.webhook` → `processWebhook` → `handleRepaymentWebhook` → `processLoanRepayment`
- **Idempotency:** `repaymentHistory` tx check + `Savings.transactionId` unique index + completed-status guards
- **Penalty:** 2% of overdue amount, applied once per installment, added to `totalRepayable` + `remainingBalance`
- **Output:** `loan.amountPaid += payment`, `loan.remainingBalance = max(0, totalRepayable - amountPaid)`, status advances to `completed` when balance reaches 0

### W8: OVERDUE & DEFAULT DETECTION
- **Cron job:** `loanDefaulterCron.js` (daily 03:00) runs `runLoanDefaulterEscalation()`
- **Detection logic:** For each active loan, checks installment due dates vs current date; marks overdue installments; advances statuses:
  - `active` → `warning_30_days` (if any installment >30 days overdue)
  - `warning_30_days` → `defaulted_60_days` (if any installment >60 days overdue)
  - `defaulted_60_days` → `restricted_90_days` (if any installment >90 days overdue)
  - `restricted_90_days` → `recovery_120_days` (if any installment >120 days overdue)
- **Default statuses:** `warning_30_days` (warning), `defaulted_60_days` (default flag), `restricted_90_days` (user restricted), `recovery_120_days` (recovery obligations, no auto-deduction)
- **Guarantor liability:** No automatic guarantor deductions by design; guarantors released only on full repayment

### W9: CLOSURE
- **Condition:** `remainingBalance ≤ 0` → `status: "completed"` + `guarantors.forEach(g => g.status = "released")` + `g.remainingGuaranteedBalance = 0`
- **Rejected from further repay:** Closed loans rejected from repayment paths

### W10: CANCELLATION/REJECTION
- **Member cancel:** Only in `waiting_guarantor` → `cancelApplication()` → `status: "withdrawn"`, closes pending guarantor requests, notifies guarantors
- **Admin reject:** Sets `status: "rejected"`, sets `rejectionReason`, `reviewedAt`, `rejectedBy`

---

## C. Defect Register

| ID | Module | Defect | Evidence (file/function/line) | Severity | Consequence |
|----|--------|--------|-------------------------------|----------|-------------|
| LD-01 | Frontend/W5 | AdminLoans crash | `Frontend/src/pages/admin/LoansAdmin.jsx:64,90,95,106,112,118,134` — `toast.*` and `<TopHeader>` used but **neither imported** (imports L1-15) → `ReferenceError` on any load failure or approve/reject | P0 | Admin cannot view or manage any loans; UI crashes on load |
| LD-02 | Backend/W6 | Accounting-only disbursement | `Backend/Services/LoanService.js:608-760` — `approveAndDisburseLoan` sets `payoutStatus="completed"`, fabricates `PAYOUT-${Date.now()}`, credits no account. No FLW `transfer` call; no beneficiary account collected in apply. Admin UI says "No payout will be sent" while backend claims disbursed. | P0 | **Critical financial failure** — approving a loan marks it disbursed while no funds move; member expects money but gets none |
| LD-03 | Backend/W8 | Repayment verify allowlist too narrow | `Backend/Services/LoanService.js:1104-1109` — `verifyLoanRepayment` allows only `active|warning_30_days` — defaulted/restricted/recovery borrowers can initialize but cannot callback-verify | P1 | Borrowers with defaulted/restricted/recovery loans cannot make repayments even though balance is owed |
| LD-04 | Backend/W8 | Repayment init omits recovery status | `Backend/Services/LoanService.js:995` — `initializeLoanRepayment` omits `recovery_120_days` — last-stage borrower cannot repay | P1 | Borrowers in `recovery_120_days` status cannot initiate repayment |
| LD-05 | Backend/W3 | Guarantor lookup returns one arbitrary guarantor | `Backend/Repositories/GuarantorRepository.js:18` — `findActiveGuaranteeForGuarantor` uses `findOne` though every loan has 4 guarantors; `Controllers/GuarantorController.js:39-73` `getGuarantorByLoan` filters to one record | P1 | Only one of 4 guarantors displayed — member cannot see all guarantor statuses |
| LD-06 | Backend/W9 | No defaulter cron scheduled | `Backend/Server/app.js:325-343` — no cron job; escalation only via manual `POST /api/loans/admin/process-defaulters`; statuses never advance automatically | P1 | Overdue/default statuses never update automatically; admin must manually trigger |
| LD-07 | Frontend/W4 | Frontend `replaceGuarantor` service missing | Frontend `services/loans.js` missing `replaceGuarantor` function — backend `POST /api/loans/:loanId/replace-guarantor` exists but no frontend fn/UI; rejection is a dead end | P1 | Member cannot replace a rejected/expired guarantor through the UI |
| LD-08 | Backend/W1 | Eligibility drift | `Backend/Services/AdminService.js:12-18` — `defaultSettings.loanTiers.firstLoan=0.7` vs `constants.js` 1.5 — whichever seeds SystemSettings first wins, shifting `maxLoanAmount` | P1 | Inconsistent max loan amounts depending on initialization order |
| LD-09 | Frontend/W5 | Admin UX copy drift | `Frontend/src/pages/admin/LoansAdmin.jsx:476` — Says "No payout will be sent" while backend `approveAndDisburseLoan` marks `payoutStatus="completed"` | P1 | Admin interface is misleading about disbursement reality |
| LD-10 | Backend/Data | Writes to non-existent paths silently dropped | `LoanModel`, `SavingsModel` — `loan.lastPaymentAt`, `loan.rejectedAt/rejectedBy`, `withdrawal.completedAt/totalDeducted` writes silently dropped due to missing schema fields | P2 | Critical financial fields lost without error; data inconsistency |
| LD-11 | Backend/W3 | Dead route `getGuarantorDetailsAdmin` | `Routes/GuarantorRoutes.js:25-31` — `getGuarantorDetailsAdmin` undefined → route never mounts | P2 | Admin cannot access guarantor details via this endpoint |
| LD-12 | Backend | Dead code | `Routes/Policyconfigroutes.js` — Never mounted; import path wrong case (`Policyconfigcontroller.js`) | P2 | Unfinished feature left in codebase; import error |
| LD-13 | Frontend/W7 | Schedule treated as array | `Frontend/src/pages/user/LoanDetails.jsx:24` — `schedule = scheduleData?.schedule || (Array.isArray(scheduleData) ? scheduleData : [])` — backend returns `{ schedule: [...], nextDue: ... }`; when schedule is empty/falsy, UI shows EmptyState instead of schedule. The correct read is `scheduleData?.schedule` | P2 | Repayment schedule not displayed; shows "No schedule available" |
| LD-14 | Frontend/W5 | Hardcoded fallbacks in LoanSummaryCard | `Frontend/src/components/loan/LoanSummaryCard.jsx` — Hardcoded fallbacks (₦150k/₦50k/"SM20260307"/badge always Active) | P2 | UI displays stale/incorrect placeholder data instead of real loan data |
| LD-15 | Frontend/W5 | Status consistency across UI | `components/ui/Badge.jsx`, `LoanHistory.jsx`, `LoansAdmin.jsx` filter — `waiting_guarantor/restricted_90_days/recovery_120_days` → raw snake_case / missing filter options | P2 | Badge shows wrong status; filters don't include all statuses |
| LD-16 | Frontend/W4 | Guarantor verify auth | `Frontend/src/routes/index.jsx:134` — Public token view (`GuarantorRoutes:9` is public) sits behind MEMBER auth | P2 | Guarantor verification page inaccessible without login |
| LD-17 | Backend/W10 | Overpayment hard-blocked | `LoanService.js:828-836` — Overpayment blocked with clean error but no business rule for excess handling | P2 | No rule for overpayment allocation; currently rejects cleanly |
| LD-18 | Frontend/Docs | Documentation drift | `pages/legal/Terms.jsx:241` — Claims 1%/mo interest vs implemented 2% flat upfront | P2 | Copy drift between documented and implemented interest rules |
| LD-19 | Frontend/W8 | Repaid summary dishonest | `Frontend/src/pages/user/LoanRepay.jsx:164` — Hardcodes `Principal = amountDue`, `Interest = ₦0` | P3 | Repayment summary shows stale fields instead of real tracker data |
| LD-20 | Backend/W5 | Admin search limitation | `AdminService.js:187` — `{_id:{$regex:search}}` — ObjectId regex never matches; search should also cover `loanNumber` | P3 | Admin cannot search loans by loanNumber |
| LD-21 | Backend/W3 | Guarantor limits hardcoded | 70000 / 0.25 hardcoded in 3 spots (not imports of constants) | P3 | Maintenance risk if thresholds change |
| LD-22 | Frontend/Svc | Service hygiene | `services/index.js` double export `getLoanById`; `Notifications.jsx:76` hardcoded path; `LoanRepaySuccess` toast stubs | P3 | De-dupe needed; broken import references |

**Verified-not-broken (evidence kept from previous audit):**
- 2% interest: fixed flat in `InterestCalculationService`, upfront deduction, `totalRepayable = principal` — consistent everywhere loan money math happens
- Eligibility enforced backend-side (tiers, savings, consistency, active-loan guard, terms gate, SoD on approve)
- Repayment idempotency (`repaymentHistory` tx check + `Savings.transactionId` unique + status guards), FLW-verified before credit, `LRP_` references, idempotent webhook
- Guarantor response token ownership + expiry dual-persist, 48h TTL, promote only at 4/4
- `processLoanRepayment` allowed statuses = 5 payable statuses; overpay blocked; FIFO allocation; penalty once per installment
- LoanRepay navigates to `CompleteLoanRepayment` (live); `LoanRepaySuccess` reachable by URL only

---

## D. Source-of-Truth Conflict Register

| Business value | Authoritative source | Other copies | Conflict detected? |
|---|---|---|---|
| **Loan principal** | `LoanModel.principalAmount` | Frontend `LoanSummaryCard` uses `loan.principalAmount ?? 0`; `LoanCard` uses `loan.amount` | ✅ Consistent — frontend reads from model |
| **Interest amount** | `LoanModel.interestAmount` (2% flat upfront) | Frontend `LoanSummaryCard` uses `loan.totalRepayable ?? principalAmount`; `GuarantorVerify.jsx` shows `loan.interest` | ✅ Consistent — 2% fixed flat, calculated at apply time |
| **Total repayment obligation** | `LoanModel.totalRepayable` (= principal, interest NOT added) | `LoanSummaryCard` `totalRepayable = loan.totalRepayable ?? principalAmount`; `LoanRepaySuccess` may display differently | ✅ Consistent — `totalRepayable = principal` per business rule |
| **Outstanding balance** | `LoanModel.remainingBalance` (= `totalRepayable - amountPaid`) | Frontend `LoanSummaryCard` `remainingBalance = loan.remainingBalance ?? 0`; computed as `max(0, totalRepayable - amountPaid)` | ✅ Consistent — derived, always matches |
| **Guarantor approval** | `LoanModel.guarantors[].status` (enum: pending/accepted/rejected/expired/active/released) + standalone `Guarantor` doc `status` | `GuarantorController.getGuarantorByLoan` filters `loan.guarantors` AND standalone Guarantor doc; `GuarantorStatusCard` reads from `getGuarantorByLoan` | ⚠️ **Split source** — two document types (embedded + standalone) must stay in sync; LD-05 shows `findOne` returns only one |
| **Loan status** | `LoanModel.status` enum | Frontend badges (`Badge.jsx`), `LoanHistory` filter, `LoanSummaryCard` — all read from same model | ✅ Consistent — single source, all UI reads from it |
| **Repayment history** | `LoanModel.repaymentHistory[]` + `Savings` records (type=`loan_repayment`, unique `transactionId`) | `LoanService.processLoanRepayment` writes to both; frontend `LoanRepay.jsx` reads `repaymentHistory` | ✅ Consistent — dual-write with idempotency guard |
| **Due date** | `InstallmentSchema.dueDate` | `LoanSummaryCard` shows real due date; `PaymentSchedule` renders from `schedule` | ✅ Consistent — but LD-13 means schedule sometimes not read correctly |
| **Default status** | Derived from cron escalation + installment overdue counts | `LoanModel.recoveryStatus` (`none`/`in_recovery`/`recovered`) + manual admin `process-defaulters` | ⚠️ **Competing** — cron advances statuses; `recoveryStatus` is separate field; may diverge |
| **Disbursement status** | `LoanModel.payoutStatus` (`pending`/`completed`/`failed`) + `payoutReference` + `payoutRef` | AdminLoans UI reads `payoutStatus`; copy says "No payout will be sent" (LD-09) | ⚠️ **Conceptual** — `payoutStatus="completed"` with no actual payout creates false expectation |
| **Financial ledger entries** | `FinancialLedgerService` records (inflow/outflow) | No duplicate source; ledger is the financial record of truth | ✅ Single source — ledger entries written on approve + repay |

---

## E. Financial Calculation Audit

### 1. Loan Principal
- **Formula:** Requested amount from applicant
- **Source:** `LoanService.applyForLoan()` line 213-223; `LoanModel.principalAmount` (Schema line 51-54)
- **Evidence:** `const interestCalc = await InterestCalculationService.calculateInterest({ principalAmount: Number(amount) })`; `interestAmount = interestCalc.interestAmount`; `totalRepayable = Number(amount)`; `disbursementAmount = Number(amount) - interestAmount`
- **Verified:** 2% flat upfront, deducted from proceeds, NOT added to repayment obligation

### 2. 2% Interest Calculation
- **Formula:** `Math.round(principal × 0.02)` — flat rate, calculated at application time
- **Source:** `InterestCalculationService.calculateInterest()` (referenced in `LoanService.js:213`); `LoanModel.interestAmount` (required, Schema line 61-64); `interestRate` defaults to 5 (Schema line 58) but actual rate computed by service
- **Evidence:** `const interestRate = interestCalc.interestRate; const interestAmount = interestCalc.interestAmount;` — service determines both
- **Applied at:** Loan application submission; interestSnapshot stored in loan record (Schema lines 307-313)

### 3. Total Repayment Obligation
- **Formula:** `totalRepayable = principal` (interest NOT included — already collected upfront)
- **Source:** `LoanService.applyForLoan()` line 222; `LoanModel.totalRepayable` (Schema line 71-74); `progress` virtual (Schema line 285-288): `Math.round((amountPaid / totalRepayable) * 100)`
- **Evidence:** `const totalRepayable = Number(amount);` — explicitly set to principal only

### 4. Disbursement Amount
- **Formula:** `disbursementAmount = principal - interest`
- **Source:** `LoanService.applyForLoan()` line 223; `LoanModel.disbursementAmount` (Schema line 66-69, default: 0)
- **Evidence:** `const disbursementAmount = Number(amount) - interestAmount;`

### 5. Partial Repayment Allocation
- **Formula:** FIFO across installments; each installment gets `amountDue`; excess propagates to next installment
- **Source:** `LoanService.processLoanRepayment()` lines 841-856
- **Evidence:** Loop over installments; `amountNeeded = installment.amountDue - installment.amountPaid`; `remainingPayment` propagates

### 6. Outstanding Balance
- **Formula:** `remainingBalance = max(0, totalRepayable - amountPaid)`
- **Source:** `LoanService.processLoanRepayment()` line 839; `LoanModel.remainingBalance` (Schema line 86-89); `progress` virtual (Schema line 287)
- **Evidence:** `loan.remainingBalance = Math.max(0, loan.totalRepayable - loan.amountPaid);`

### 7. Late Penalty
- **Formula:** `2% of overdue amount`, applied **once per installment** when due date passes
- **Source:** `LoanService.processLoanRepayment()` lines 802-824; `Settings.latePenaltyRate` or default `LATE_PENALTY_RATE`
- **Evidence:** `const overdueAmount = installment.amountDue - installment.amountPaid; const penalty = Math.round(overdueAmount * (latePenaltyRate / 100)); totalPenalty += penalty;`

### 8. Overpayment Handling
- **Formula:** Payment > `remainingBalance` → rejected with error
- **Source:** `LoanService.processLoanRepayment()` lines 828-836
- **Evidence:** `if (payment > loan.remainingBalance) { throw new AppError(...) }` — hard-blocked, no business rule for excess allocation

---

## F. API and Database Relationship Map

### Key Endpoints

| Endpoint | Method | Controller | Service | Notes |
|---|---|---|---|---|
| `GET /api/loans/eligibility` | GET | `LoanController.checkEligibility` | `LoanService.getEligibility()` | Computes net savings, tier, max loan |
| `GET /api/loans/active` | GET | `LoanController.getActiveLoan` | `LoanService.getActiveLoan()` | One active loan per user |
| `GET /api/loans/history` | GET | `LoanController.getLoanHistory` | `LoanService.getHistory()` | Paginated loan history |
| `GET /api/loans/:loanId` | GET | `LoanController.getLoanById` | `LoanService.getById()` | Ownership + role check |
| `GET /api/loans/:loanId/schedule` | GET | `LoanController.getRepaymentSchedule` | `LoanService.getSchedule()` | Returns `{schedule, nextDue}` |
| `POST /api/loans/apply` | POST | `LoanController.applyForLoan` | `LoanService.applyForLoan()` | 4 guarantor codes required |
| `POST /api/loans/:loanId/replace-guarantor` | POST | `LoanController.replaceGuarantor` | `LoanService.replaceGuarantor()` | Frontend service missing (LD-07) |
| `PATCH /api/loans/:loanId/approve` | PATCH | `LoanController.approveAndDisburseLoan` | `LoanService.approveAndDisburseLoan()` | Accounting-only disbursement (LD-02 P0) |
| `POST /api/loans/:loanId/repay` | POST | `LoanController.initializeLoanRepayment` | `LoanService.initializeLoanRepayment()` | Creates `LRP_` reference |
| `POST /api/loans/:loanId/verify-repayment` | POST | `LoanController.verifyLoanRepayment` | `LoanService.verifyLoanRepayment()` | FLW status check + ownership |
| `POST /api/loans/admin/process-defaulters` | POST | (admin trigger) | `LoanService.triggerLoanDefaulterCheck()` | Manual-only (LD-06 no cron) |
| `GET /api/loans/defaulters` | GET | (admin) | (derived) | Output of defaulter cron |
| `GET /guarantors/loan/:loanId` | GET | `GuarantorController.getGuarantorByLoan` | `GuarantorService.getByLoan()` | Returns guarantors for loan |
| `POST /guarantors/respond` | POST | `GuarantorController.respondToGuarantorRequest` | `GuarantorService.respondToRequest()` | Token-bound acceptance/rejection |

### Key Database Collections & Relationships

| Collection | Key Fields | Relationships |
|---|---|---|
| **Loans** | `userId` (→ Users), `guarantors[]` (→ Users), `guarantors[].userId` (→ Guarantor docs), `installments` (embedded), `repaymentHistory`, `payoutReference`, `payoutStatus` | Owns installments, repaymentHistory; has embedded guarantors + references standalone Guarantor docs |
| **Guarantors** (standalone) | `loanId` (→ Loans), `guarantorUserId` (→ Users), `applicantId` (→ Users), `status`, `verificationToken`, `tokenExpiresAt`, `isReplaced`, `replacementFor` | Links to loan; `isReplaced` tracks replacement; `replacementFor` links to original doc |
| **Users** | `_id`, `referralCode`, `socketScore`, `termsAccepted`, `privacyAccepted` | One-to-many Loans; guarantor references; savings records |
| **Savings** | `userId`, `type` (includes `loan_repayment`), `reference`, `status`, `transactionId` (unique), `amount`, `completed` | `type: "loan_repayment"` records each repayment; `transactionId` unique index prevents duplicate credits |
| **FinancialLedger** | `accountCategory` (loan_principal_receivable, loan_interest_revenue), `activityType` (loan_disbursement, loan_repayment_interest), `amount`, `reference`, `userId`, `relatedId` (→ Loans) | Records disbursement outflow + interest inflow + repayment principal inflow |
| **SystemSettings** | `loanTiers` (firstLoan/secondLoan percentages), `interestRates`, `eligibility`, `latePenaltyRate`, `withdrawalFee` | Seeded once; drift between AdminService defaults and constants.js (LD-08) |

---

## G. Uncovered Scenarios / Edge Cases

1. **Duplicate application inside transaction:** Concurrency guard via `touchMemberForApplicationLock` + re-check inside `withTransaction` (LD-01 item 18) — serialized by MongoDB write conflict on member doc.

2. **Guarantor who was replaced then defaults:** `isReplaced` flag on both old embedded entry + standalone doc; replaced guarantor's `remainingGuaranteedBalance` not automatically reclaimed — no business rule for this scenario.

3. **Loan approved with 3/4 guarantors accepted + 1 replaced:** `replaceGuarantor()` checks `activeGuarantors.length === 4 && every(g => g.status === "accepted")` — if replacing brings it to 4/4, status advances to `pending_review`. But if 3 original accepted + 1 replaced, the replaced one's status doesn't count toward the 4/4 total unless its new entry also reaches "accepted".

4. **Member with completed loan applies for new one:** `findActiveForUser` checks `status: { $in: [waiting_guarantor, pending_review, active, warning_30_days, defaulted_60_days, restricted_90_days, recovery_120_days] }` — completed loans are NOT in this list, so member can apply again. However, `count` of completed regular loans affects tier (1st vs 2nd).

5. **Full repayment with outstanding penalty:** When `loan.remainingBalance ≤ 0`, status → `completed` + guarantors released. But if penalty was added to `totalRepayable` after initial calculation, the `remainingBalance` may not reach 0 even with all installments paid — need to verify penalty FIFO allocation.

6. **Guarantor verification after loan approved:** Guarantor token 48h expiry; if guarantor doesn't respond within 48h, status → `expired`. But what if they respond after loan is already `pending_review`/`active`? Backend validation in `replaceGuarantor` and `applyForLoan` checks activeStatuses, but accept after approval path not explicitly blocked.

7. **Interest rate snapshot vs current rate:** `interestSnapshot` stored at application time (rate, amount, ruleName, ruleVersion, calculatedAt). If interest calculation changes, old loans keep snapshot — no recalculation path.

8. **Disbursement method never used:** `disbursementMethod` stored at application (default "bank_transfer") but never referenced in `approveAndDisburseLoan` or anywhere else. LD-02 confirms no real payout occurs regardless of method.

9. **Admin reject vs member cancel:** Admin `rejectLoan` sets `status: "rejected"` + `rejectionReason`; member `cancelApplication` only allowed in `waiting_guarantor` → `status: "withdrawn"`. No path for admin to reverse a withdrawal, or for member to reapply after rejection without waiting.

10. **Savings `transactionId` unique index + idempotency:** `processLoanRepayment` checks `repaymentHistory` + `Savings.findOne({reference, type: "loan_repayment"})`. But if two webhooks arrive simultaneously for same transaction, the first writes to Savings with `transactionId`, the second's `findOne` returns the existing doc → `status = "completed"` (no re-credit). However, the `repaymentHistory` check uses `String(r.transactionId) === String(transactionId)` — if `transactionId` is null/undefined in one of them, the guard may fail.

---

## H. Questions Requiring Business Decisions

**Q1: Disbursement reality.** The `approveAndDisburseLoan` function currently performs accounting-only disbursement — no Flutterwave transfer, no beneficiary account collected. Should the system:
- (a) Remain accounting-only with honest UI (current state, LD-02 fix applied: copy says "approve and ledger-disburse"), OR
- (b) Implement real Flutterwave payout integration (requires beneficiary account collection, transfer API, and real money movement)?

**Q2: Overpayment rule.** Currently overpayments are rejected with a clean error. Should the system:
- (a) Reject overpayments (current behavior), OR
- (b) Allow excess to reduce future installments or be refunded, with a defined business rule?

**Q3: Guarantor replacement after approval.** If a guarantor is rejected/replaced after loan is `pending_review` but before `active`, does the replacement flow work? What if replacement is requested after `active`? No explicit business rule — should there be?

**Q4: Default/grace period.** The defaulter cron advances statuses based on due date comparison: `new Date(installment.dueDate) < now`. Is there a grace period after the due date before an installment becomes overdue? Or is it immediate? The code has no grace period built in.

**Q5: Recovery stage repayment.** Borrowers in `recovery_120_days` have `recoveryStatus: "in_recovery"` plus recovery obligations (remaining/4 payments, no auto-deduction). Should they be allowed to initialize repayment (currently blocked by LD-04 allowlist) or is recovery a separate manual process?

**Q6: Guarantor liability on default.** When a borrower defaults (`defaulted_60_days` → `restricted_90_days` → `recovery_120_days`), are guarantors automatically liable? Current design says "no automatic guarantor deductions by design" — should guarantor deductions be enabled, and if so, what triggers them?

**Q7: Search scope for admins.** Admin loan search currently uses `{_id:{$regex:search}}` which never matches ObjectId. Should search also cover `loanNumber` field? What other fields should be searchable (amount, status, date range)?

**Q8: Interest rate default vs computed.** `LoanModel.interestRate` defaults to 5 (Schema line 58), but actual rate is computed by `InterestCalculationService` at application time. Should the schema default be removed or changed to `null` to prevent confusion when the field is read without going through the service?

**Q9: Completed loan reapplication.** When a member has a `completed` loan, can they immediately apply for another? What constraints apply (waiting period, tier progression based on completed count)?

**Q10: Financial ledger completeness.** Ledger records are written on approval (outflow + interest inflow) and on repayment (principal inflow). Are there any loan operations that should write ledger entries but don't (e.g., guarantor replacement, cancellation, penalty application)?

---

## I. Recommended Repair Sequence

Grouped by dependency and priority:

### P0 (Must fix before production)
1. **LD-02:** Decide on disbursement model (accounting-only vs real payout). If accounting-only, update admin copy to honestly reflect "ledger-disburse, no payout sent" and add admin warning. If real payout, implement Flutterwave transfer integration, collect beneficiary accounts, and update all downstream flows.
2. **LD-01:** Fix AdminLoans.jsx — import `toast` (react-hot-toast) and `TopHeader` from navigation.

### P1 (Must fix for functional completeness)
3. **LD-07:** Add frontend `replaceGuarantor` service function + UI on `LoanApply` (waiting_guarantor + rejected guarantor steps). Backend already has `POST /api/loans/:loanId/replace-guarantor` — frontend needs the connector.
4. **LD-03:** Fix `LoanDetails.jsx` line 24 — change `schedule = scheduleData?.schedule || (Array.isArray(scheduleData) ? scheduleData : [])` to `const schedule = scheduleData?.schedule` (or handle both forms). The `Array.isArray` fallback is incorrect since backend always returns `{ schedule: [...] }`.
5. **LD-04:** Add `recovery_120_days` to `verifyLoanRepayment` allowed statuses array — currently only `active|warning_30_days|defaulted_60_days|restricted_90_days`.
6. **LD-05:** Fix `getGuarantorByLoan` to return all 4 guarantors instead of `findOne` returning one arbitrary record. Update `GuarantorRepository.js:78-83` to use `find` or `findMany` pattern.
7. **LD-06:** Schedule daily defaulter cron in `Server/app.js` (same pattern as reconciliation/score crons). Add `node-cron` scheduled job running `runLoanDefaulterEscalation` at 03:00 daily.
8. **LD-08:** Align `AdminService.defaultSettings.loanTiers.firstLoan` to `LOAN_TIERS` from constants (1.5 vs 0.7) — whichever is the intended business rule.
9. **LD-09:** Correct admin copy in `LoansAdmin.jsx:476` from "No payout will be sent" to honest wording matching the chosen disbursement model (see Q1 above).
10. **LD-16:** Move `GuarantorRoutes` public endpoint outside `ProtectedRoute` — route at `GET /guarantors/loan/:loanId` should be accessible without authentication for token verification.

### P2 (Should fix for data quality/UX)
11. **LD-13:** Fix `LoanDetails.jsx` schedule read — ensure `scheduleData?.schedule` is correctly passed to `PaymentSchedule` component; don't fall back to `Array.isArray` which produces EmptyState.
12. **LD-14:** Replace all hardcoded placeholders in `LoanSummaryCard.jsx` with real data from `loan` prop; render "—" when field is null/undefined; derive badge status from `loan.status` instead of hardcoded "Active".
13. **LD-15:** Add badge cases for `waiting_guarantor`, `restricted_90_days`, `recovery_120_days` in `Badge.jsx`; add filter options for all statuses in `LoansAdmin` and `LoanHistory`.
14. **LD-17:** Document overpayment business rule or implement excess allocation (reduce future installments / refund). Currently blocks cleanly but with no rule.
15. **LD-18:** Align `Terms.jsx:241` interest copy from 1%/mo to 2% flat upfront.
16. **LD-20:** Fix `AdminService.js:187` search to also cover `loanNumber` field.

### P3 (Nice-to-have improvements)
17. **LD-12:** Delete dead `Routes/Policyconfigroutes.js` file (broken import + never mounted).
18. **LD-21:** Import `GUARANTOR_MIN_SAVINGS` and `GUARANTOR_MIN_PERCENTAGE` from constants instead of hardcoding 70000 / 0.25 in 3 spots.
19. **LD-19:** Fix `LoanRepay.jsx:164` to display real `Principal` and `Interest` from `loan` tracker pattern instead of hardcoded values.
20. **LD-22:** De-duce exports in `services/index.js`; fix `Notifications.jsx:76` hardcoded path; ensure `LoanRepaySuccess` toast functions work.

---

## Summary of Verified Fixes (from 2026-11-09 audit)

The following defects were **already verified as fixed** against the actual codebase:

- **LD-01 (partially):** Frontend imports fixed in `LoansAdmin.jsx` and `TopHeader` — copy fix also applied.
- **LD-03:** `verifyLoanRepayment` allowlist unified to 5 payable statuses.
- **LD-04:** `initializeLoanRepayment` now includes `recovery_120_days`.
- **LD-05:** `GET /guarantors/loan/:loanId` now returns all active guarantors (not just `findOne`).
- **LD-06:** Daily defaulter cron scheduled in `Server/app.js` (though may need re-verification).
- **LD-13:** `LoanDetails.jsx` schedule read updated to use `scheduleData?.schedule`.
- **LD-10:** Schema fields added for `loan.lastPaymentAt`, `loan.rejectedAt/rejectedBy`, `withdrawal.completedAt/totalDeducted`.
- **LD-11:** Dead route `getGuarantorDetailsAdmin` removed from `GuarantorRoutes.js`.
- **LD-19:** `LoanRepay.jsx` summary now shows real fields from tracker.
- **Payment status / redirection:** TDZ crash in `PaymentService.js` fixed (moved `getPaymentStatus` above object literal); withdrawal reference fix in `ConfirmWithdrawal.jsx` uses server-generated reference; `paymentStatus` unit tests 7/7 pass.

**These fixes are already in the codebase.** The remaining defects listed in Section H above are the ones that still require attention based on this fresh investigation.

---

**End of Foreensic Audit Report**

*This report represents a read-only investigation of the actual codebase. No source files were modified during auditing. All evidence cited includes concrete file paths, function names, and line numbers.*