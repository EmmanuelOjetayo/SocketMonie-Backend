# SocketMonnie Loan Workflow - Complete Business Workflow

## Overview

This document documents every loan stage and its transitions, based on the actual implemented code and confirmed business rules. The loan system follows Model A financial semantics: 2% flat upfront interest, total repayment obligation equals original principal, net disbursement = principal - interest.

---

## 1. Loan Application

### Trigger
- Borrower initiates loan application via `POST /api/loans/apply`

### Required Conditions
- Member must be eligible (`getEligibility` returns `isEligible: true`)
- Member must have accepted Terms and Conditions and Privacy Policy
- Requested amount must not exceed maximum borrowing limit
- Four unique guarantor referral codes must be provided
- Each guarantor must independently have net savings >= 25% of the loan principal
- Guarantors must have consistent savings history (minimum ₦5,000/month for 6 months)
- Member must not have an active or processing loan application

### Trigger Actor
- Borrower (via frontend `LoanApply` page)

### Database Changes
- Creates loan record with status `waiting_guarantor`
- Creates embedded guarantor entries (status: `pending`, `isReplaced: false`)
- Creates standalone guarantor documents with verification tokens
- Sets `principalAmount`, `interestAmount` (calculated via `InterestCalculationService`), `totalRepayable = principalAmount`, `disbursementAmount = principalAmount - interestAmount`
- Sets `remainingBalance = totalRepayable`, `amountPaid = 0`
- Sets `installments = []` (populated on manual disbursement)
- Records `interestSnapshot` with rate, amount, ruleName, ruleVersion, calculatedAt
- Records `eligibilitySnapshot` with netSavings, maxLoanAmount, tier, isEmergency

### Notifications
- Borrower: "Loan Application Submitted" 
- Each guarantor: "Loan Guarantee Request" with token and loanId

### Possible Failure Conditions
- Ineligibility (`netSavings < minSavings` or `monthsCount < minMonths`)
- Amount exceeds borrowing limit
- Duplicate active/processing loan application
- Self as guarantor
- Guarantor already serving as active guarantor on another loan
- Guarantor does not meet minimum savings requirement (₦70,000)
- Guarantor has not maintained consistent savings history

### SocketScore Implications
- Loan application event may trigger score update depending on established scoring formula
- See `SOCKETSCORE.md` for complete event mapping

---

## 2. Four-Guarantor Invitation and Acceptance

### Trigger
- Guarantor receives invitation via token link (`GET /api/guarantor/details/:token`)

### Required Conditions
- Guarantor request must be `pending` and not expired
- Token must not have expired (`tokenExpiresAt > now`)
- Loan status must be `waiting_guarantor`

### Transition: Guarantor Acceptance
- Guarantor responds via `POST /api/guarantor/respond` with `decision: "accept"`
- System records acceptance timestamp, IP, and collected KYC data
- Embedded loan guarantor entry status changes from `pending` to `accepted`
- Standalone guarantor request status changes from `pending` to `accepted`
- System checks if all 4 guarantors have accepted
- If all 4 accepted: loan status changes from `waiting_guarantor` to `pending_review`
- If not all 4: loan remains in `waiting_guarantor`

### Database Changes (accept)
- `loan.guarantors[i].status = "accepted"`
- `loan.guarantors[i].acceptedAt = now`
- `loan.guarantors[i].remainingGuaranteedBalance = loan.remainingBalance || loan.totalRepayable`
- **Each guarantor's `remainingGuaranteedBalance` represents 25% of the original approved principal (Q1, Q2)**
- `guarantorRequest.status = "accepted"`
- `guarantorRequest.acceptedAt = now`
- `guarantorRequest.ipAddress = clientIp`
- `loan.status = "pending_review"` (if 4th acceptance)
- Audit log: `guarantor_accepted`
- **Mandate/cosent record created at guarantee acceptance, covering specific loan, maximum liability (25% of principal), default conditions, recovery calculation, and authorized collection mechanism (Q5)**

### Notifications (accept)
- Guarantor: "Guarantee Accepted" with message about becoming active only if admin-approved
- Borrower: "Guarantor Accepted" with guarantor name and loan status
- Borrower (if all 4 accepted): "All Guarantors Accepted" - forwarded for admin review

### Possible Failure Conditions
- Request already accepted or rejected
- Request expired (`new Date() > guarantorRequest.tokenExpiresAt`)
- Loan no longer in `waiting_guarantor` status
- Unauthorized responder (guarantorUserId mismatch)
- **Guarantor replacement not allowed after admin approval** — once all four guarantors are `accepted` and loan status changes to `pending_review`, guarantors are locked; replacement only permitted while `status === "waiting_guarantor"` (Q6)

### Transition: Guarantor Rejection
- Guarantor responds via `POST /api/guarantor/respond` with `decision: "reject"`
- System records rejection timestamp and reason
- Embedded loan guarantor entry status changes from `pending` to `rejected`
- Standalone guarantor request status changes from `pending` to `rejected`
- Loan status remains `waiting_guarantor` (loan is NOT cancelled or rejected)
- Borrower must find and invite another eligible guarantor to replace the rejecting one
- Non-replaced guarantor requests are closed/expired

### Database Changes (reject)
- `loan.guarantors[i].status = "rejected"`
- `loan.guarantors[i].rejectedAt = now`
- `loan.guarantors[i].rejectionReason = rejectionReason`
- `guarantorRequest.status = "rejected"`
- `guarantorRequest.rejectedAt = now`
- `guarantorRequest.rejectionReason = rejectionReason`
- Notify borrower to replace this guarantor

### Notifications (reject)
- Borrower: "Guarantor Request Declined" with message to select replacement

### Possible Failure Conditions
- Same as acceptance failure conditions above

### SocketScore Implications
- Guarantor acceptance/rejection events may trigger score updates
- See `SOCKETSCORE.md` for complete event mapping

---

## 3. Guarantor Replacement

### Trigger
- Borrower initiates replacement of a rejected or expired guarantor
- **Only valid while loan is in `waiting_guarantor` status (Q6)**

### Required Conditions
- **Loan status must be `waiting_guarantor` (Q6)**
- Old guarantor must have status `rejected` or `expired` (not `accepted`)
- New guarantor must have valid referral code
- New guarantor must not already be on this loan (as active or replaced guarantor)
- New guarantor must meet 25% minimum savings of loan principal
- New guarantor must have consistent savings history

### Process
1. Borrower provides new guarantor referral code
2. System validates new guarantor eligibility (savings >= 25% principal, consistent history)
3. ****After admin approval**, all four guarantors are locked; replacement is no longer permitted (Q6)**
- **If a material guarantor issue arises before disbursement, suspend disbursement readiness and require auditable admin re-review; do not silently replace a guarantor (Q6)**
3. System marks old guarantor as `isReplaced = true` in both embedded and standalone records
4. System creates new standalone guarantor document with `status: "pending"`
5. System adds new guarantor entry to embedded `loan.guarantors` array with `status: "pending"`
6. Borrower's new guarantor receives invitation notification
7. System checks if all 4 active (non-replaced) guarantors are now accepted
- If all 4 accepted: loan status changes to `pending_review`
- If not: loan remains in `waiting_guarantor`

### Database Changes (replace)
- Old standalone guarantor: `isReplaced = true`
- Old embedded entry: `isReplaced = true`, `replacedBy = newGuarantorUserId`, `replacementReason` recorded
- New standalone guarantor document created with full tracking fields
- New entry added to embedded `loan.guarantors` array
- `loan.guarantors` array now has 5 entries (4 active + 1 replaced), or still 4 if old was removed

### Notifications (replace)
- New guarantor: "Loan Guarantee Request" with amount and loan details
- Borrower: notification about replacement sent

### Possible Failure Conditions
- **Loan not in `waiting_guarantor` status — replacement not permitted after admin approval (Q6)**
- Old guarantor status is `accepted` or `active` (replacement not allowed)
- New guarantor already on this loan
- New guarantor does not meet 25% eligibility
- New guarantor has inconsistent savings history
- New guarantor is the borrower themselves
- New guarantor is already serving as active guarantor on another loan

### SocketScore Implications
- Guarantor replacement may trigger score recalculation
- See `SOCKETSCORE.md`

---

## 4. Admin Review and Approval

### Trigger
- Admin reviews loan application via admin dashboard

### Required Conditions
- All four guarantors must have `status === "accepted"` and not be `isReplaced`
- Loan status must be `pending_review`
- Admin must pass separation-of-duties check (cannot approve own loan)
- Admin cannot be one of the four guarantors

### Process
1. Admin clicks "Approve and Confirm Manual Disbursement" in admin dashboard
2. System validates all prerequisites (4 accepted guarantors, SoD, bank details present/valid)
3. System performs financial invariant check: `disbursementAmount + interestAmount = principalAmount`
4. System activates loan: `status = "active"`, generates installments via `buildLoanInstallments()`
5. Sets `amountPaid = 0`, `remainingBalance = totalRepayable`
6. Activates all four guarantors: `g.status = "active"`, `g.remainingGuaranteedBalance = remainingBalance`
7. Records manual disbursement confirmation:
   - `payoutStatus = "completed"`
   - `payoutReference = MANUAL_${loanNumber}_${timestamp}` (not an external provider transfer)
   - `payoutRef = payoutReference` (manual confirmation reference)
   - `payoutProviderResponse = { mode: "manual", confirmedBy: adminUserId, confirmedAt: disbursedAt }`
   - `disbursementBankDetails` snapshot from borrower's profile
8. Writes ledger entries:
   - `outflow: loan_principal_receivable` for disbursementAmount
   - `inflow: loan_interest_revenue` for interestAmount (if > 0) - deducted once only
9. Sets installments: each installment `amountDue = totalRepayable / durationMonths` (last may differ)
10. Sends notifications:
    - Borrower: "Loan Approved & Disbursement Confirmed" with manual disbursement message
    - Each guarantor: "Guarantee Activated" 
    - Audit log: `loan_manual_disbursement_confirmed`
11. Loan repayment schedule is now active

### Database Changes (approve + disburse)
- `loan.status = "active"`
- `loan.approvedAt = now`, `loan.reviewedAt = now`, `loan.approvedBy = adminUserId`
- `loan.disbursedBy = adminUserId`, `loan.disbursedAt = now`
- `loan.disbursementAmount = principal - interest`
- `loan.payoutStatus = "completed"`
- `loan.payoutReference = MANUAL_${loanNumber}_${timestamp}`
- `loan.payoutRef = payoutReference`
- `loan.payoutInitiatedAt = null`, `loan.payoutFailedAt = null`, `loan.payoutFailureReason = null`
- `loan.payoutProviderResponse = { mode: "manual", confirmedBy, confirmedAt }`
- `loan.disbursementBankDetails = { bankCode, bankName, accountNumber, accountName }`
- `loan.installments = buildLoanInstallments(loan, disbursedAt)`
- `loan.amountPaid = 0`, `loan.remainingBalance = totalRepayable`
- Each guarantor: `g.status = "active"`, `g.remainingGuaranteedBalance = remainingBalance`

### Notifications (approve/disburse)
- Borrower: "Loan Approved & Disbursement Confirmed" - manual disbursement message, repayment schedule active
- Each guarantor: "Guarantee Activated" - guarantee now active
- Audit: `loan_manual_disbursement_confirmed` with full details

### Possible Failure Conditions
- Not all 4 guarantors accepted → error: "All 4 guarantors must accept this loan before approval"
- Admin approving own loan → error: "You cannot approve your own loan application"
- Admin is a guarantor on this loan → error: "You cannot approve a loan in which you are a guarantor"
- Borrower bank details incomplete → error: "Borrower bank details are incomplete in profile"
- Borrower bank account number invalid (not 10 digits) → error: "Borrower bank account number is invalid"
- Financial values inconsistent → error: "Loan financial values are inconsistent. Disbursement cannot proceed"
- Loan not in `pending_review` status → error: "Loan is not awaiting admin approval"

### SocketScore Implications
- Manual disbursement confirmation triggers score update
- Repayment schedule activation may trigger score update
- See `SOCKETSCORE.md`

---

## 5. Manual Disbursement Confirmation

### Important
- **Flutterwave loan payout is NOT authorized for now**
- The actual bank transfer is handled manually outside SocketMonnie
- The administrator's "Approve and Disburse" action confirms that the manual transfer has actually been completed
- The system then records the confirmed disbursement and activates the repayment schedule
- Never generate a fake Flutterwave transaction or falsely report an external transfer

### Authoritative Beneficiary Details
- Use the applying member's existing profile bank details as the authoritative beneficiary source
- Do not introduce a second independent beneficiary source
- Validate and display the bank details for admin review
- Prevent manual disbursement confirmation when required details are missing or invalid

### Confirmed Financial Model (Model A)
For a ₦100,000 loan:
- Original principal: ₦100,000
- Upfront interest: ₦2,000 (flat, deducted once only)
- Net manual disbursement: ₦98,000
- Total repayment obligation: ₦100,000

### Formulas
- `interest = approvedPrincipal × 0.02`
- `netDisbursement = approvedPrincipal - interest`
- `totalRepayable = approvedPrincipal`

### Admin Manual Confirmation Process
1. Admin verifies borrower's profile bank details are present and valid
2. Admin confirms that manual transfer of net disbursement amount has been completed outside the platform
3. Admin clicks "Confirm Manual Disbursement" in the admin dashboard
4. System records the confirmation and activates the loan
5. Repayment schedule becomes active immediately
6. Audit trail shows: admin who confirmed, date/time, amount, financial terms

### Database Changes (manual confirmation)
- `loan.status = "active"`
- `loan.approvedAt` or `loan.reviewedAt = now` (whichever is set)
- `loan.reviewedAt = now` (disbursement timestamp)
- `loan.approvedBy = adminUserId`, `loan.disbursedBy = adminUserId`
- `loan.disbursedAt = now`
- `loan.disbursementAmount = principal - interest`
- `loan.payoutStatus = "completed"`
- `loan.payoutReference = MANUAL_${loanNumber}_${timestamp}`
- `loan.payoutRef = payoutReference` (manual reference, not provider transfer id)
- `loan.payoutInitiatedAt = null`, `loan.payoutFailedAt = null`, `loan.payoutFailureReason = null`
- `loan.payoutProviderResponse = { mode: "manual", confirmedBy: adminUserId, confirmedAt: now }`
- `loan.disbursementBankDetails = snapshot from borrower profile`
- `loan.installments = buildLoanInstallments(loan, now)`
- `loan.amountPaid = 0`, `loan.remainingBalance = totalRepayable`
- Each guarantor: `g.status = "active"`, `g.remainingGuaranteedBalance = remainingBalance`

### Notifications
- Borrower: "Loan Approved & Disbursement Confirmed" - manual disbursement message, repayment schedule now active
- Each guarantor: "Guarantee Activated" - guarantee now active
- Audit: `loan_manual_disbursement_confirmed`

### Failure if Admin Confirms Without Manual Transfer
- System will have recorded the confirmation, but the borrower will not have received funds
- This is an admin governance issue, not a system enforcement issue
- System relies on admin honesty that manual transfer occurred

---

## 6. Repayment Schedule Creation

### Trigger
- Activated automatically on manual disbursement confirmation
- Can also be initialized manually via `POST /api/loans/repay/initialize`

### Repayment Model
- Total repayment obligation = principal amount (₦100,000 for ₦100k loan)
- Interest is NOT added to installments or repayment balances (deducted once upfront)
- Installments are equal monthly amounts; last installment may differ to balance
- Each installment has: `installmentNumber`, `dueDate`, `amountDue`, `amountPaid`, `status`

### Installment Calculation
```
installmentAmount = Math.floor(totalRepayable / durationMonths)
for i from 1 to durationMonths:
  if i === durationMonths:
    amountDue = totalRepayable - allocatedSoFar
  else:
    amountDue = installmentAmount
  allocated += amountDue
  dueDate = disbursedAt + i months
  push { installmentNumber: i, dueDate, amountDue, amountPaid: 0, status: "unpaid" }
```

### Example (₦100,000, 3-month loan)
- installmentAmount = floor(100000 / 3) = 33333
- Installment 1: amountDue = 33333, dueDate = disbursedAt + 1 month
- Installment 2: amountDue = 33333, dueDate = disbursedAt + 2 months
- Installment 3: amountDue = 100000 - 66666 = 33334, dueDate = disbursedAt + 3 months

### Repayment Initialization
- Borrower can initiate repayment via `POST /api/loans/repay/initialize`
- System creates a Flutterwave checkout payload
- Returns `publicKey`, `reference` (`LRP_${timestamp}_${hex}_${userId[-6]}`)
- Borrower completes payment via Flutterwave checkout
- Webhook handler (`handleRepaymentWebhook`) verifies and processes the payment

### Repayment Webhook Handling
1. Verify Flutterwave transaction by ID
2. Check idempotency: not already in `repaymentHistory`
3. Call `processLoanRepayment()` with verified data
4. `processLoanRepayment()` applies payment logic:
   - Apply only valid outstanding amount to loan
   - Excess over remainingBalance recorded in `loan.overpaymentRefunds[]` with `status: "pending_review"`
   - Separate ledger entry for excess (cash_asset / reversal_adjustment)
   - Update installments: pay down from oldest first
   - If `remainingBalance <= 0`: set `loan.status = "completed"`, release guarantors
   - Record repayment in `repaymentHistory`
   - Record excess in ledger as separate inflow (not revenue)
   - Update user score
   - Send notifications

### Overpayment (refund_review) Handling
- If `payment > loan.remainingBalance`:
  - `appliedToLoan = loan.remainingBalance`
  - `excessAmount = payment - loan.remainingBalance`
  - Record excess in `loan.overpaymentRefunds.push({ amount, status: "pending_review", reference, transactionId, recordedAt })`
  - Write ledger entry: `inflow: cash_asset, activityType: reversal_adjustment, amount: excessAmount, reference: ${paymentReference}_EXCESS, eventKey: overpayment_excess:${paymentReference}`
  - Notification includes: applied amount + excess amount flagged for admin review
  - Excess is **never** silently discarded, never applied to another loan, never treated as revenue
- If `payment <= loan.remainingBalance`:
  - `appliedToLoan = payment`
  - `excessAmount = 0`
  - No overpayment recording needed

### Possible Failure Conditions
- Payment already processed (idempotent check)
- Loan not in payable status (`active`, `warning_30_days`, `defaulted_60_days`, `restricted_90_days`, `recovery_120_days`)
- Invalid payment amount
- Payment verification fails

### SocketScore Implications
- Successful repayment triggers score update
- On-time repayment may have different score impact than late repayment
- Default events trigger score changes
- See `SOCKETSCORE.md` for complete mapping

---

## 7. Missed Repayments and Overdue Status

### Installment Overdue
- An installment becomes overdue immediately after its `dueDate` passes (no additional grace period)
- Status changes from `unpaid` to `overdue`
- Penalty may be applied per `latePenaltyRate` from system settings

### Warning_30_Days Status
- Trigger: Oldest overdue installment >= 30 days
- Loan status changes from `active` to `warning_30_days`
- Notification sent to borrower: "Loan Repayment Overdue (30 Days)"
- Borrower advised to clear balance to avoid further escalation
- No automatic deductions or collections

### Defaulted_60_Days Status
- Trigger: Oldest overdue installment >= 60 days
- Loan status changes from `active`/`warning_30_days` to `defaulted_60_days`
- Borrower user status changes to `"restricted"`
- **Recovery begins immediately at `defaulted_60_days`; not waiting until `recovery_120_days` (Q3)**
- Notification: "Loan Defaulted (60 Days) - Guarantor Recovery Initiated"
- **Recovery obligation = unpaid installment from overdue month + installment due in current calendar month (Q3)**
- **Divided equally among four guarantors, each subject to 25% of principal liability cap (Q1, Q2)**
- **Each guarantor's maximum liability = 25% of original approved principal (Q2)**
- **Explicit guarantor consent required for recovery mechanism (Q5)**
- Recovery obligations tracked in `RecoveryObligationModel` with `deductionExecutionStatus: "not_enabled"` — actual deductions require authorized collection mechanism and mandate consent (Q5)

### Restricted_90_Days Status
- Trigger: Oldest overdue installment >= 90 days
- Loan status changes to `restricted_90_days`
- Notification: "Loan Restricted (90 Days)"
- Guarantor recovery obligations remain tracked and recalculated as repayments are made

### Recovery_120_Days Status
- Trigger: Oldest overdue installment >= 120 days
- Loan status changes to `recovery_120_days`, `loan.recoveryStatus = "in_recovery"`
- Recovery infrastructure updates monthly via `processGuarantorRecoveryMonthly()`
- No automatic guarantor deduction execution
- Borrower may still initiate repayment through normal system
- Repayment reduces outstanding obligation and reduces guarantor exposure

---

## 8. Guarantor Recovery and Deductions

### Important
- **Guarantor recovery infrastructure is implemented but no automatic deductions are executed without authorized collection mechanism and mandate consent (Q3, Q5)**
- System tracks obligations but requires explicit authorization before any real money movement
- **Equal 25% allocation across four guarantors; no guarantor automatically absorbs another's unpaid share (Q1)**
- **Each guarantor's maximum liability = 25% of original approved principal; do not increase individual liability because another fails to pay (Q2)**
- **Guarantor consent must cover specific loan, maximum liability, default conditions, recovery calculation, and authorized collection mechanism; guarantee acceptance alone does not authorize direct bank debit (Q5)**
- **Refund approval: all overpayments remain `pending_review` until reviewed by authorized administrator with auditable identity, reason, amount, and timestamp (Q4)**
- **Replacement permitted only while loan is in `waiting_guarantor`; after admin approval, all four guarantors are locked (Q6)**

### Trigger
- Automatic recovery begins immediately when loan enters `defaulted_60_days` status
- Not waiting until `recovery_120_days`

### Recovery Amount
- Covers: unpaid installment from overdue month + installment due for current month
- Uses outstanding amounts, not original values when partial payments made
- Capped by loan remaining balance context
- Excludes already settled amounts; avoids duplicate inclusion

### Current-Month Interpretation
- Uses outstanding-in-current-calendar-month interpretation
- Identifies overdue installment and current-month installment outstanding
- Excludes future installments not yet due
- Respects loan's repayment calendar and due dates

### Four-Guarantor Allocation
- **Equal 25% share per guarantor of applicable recovery obligation (Q1)**
- No guarantor should automatically absorb another guarantor's unpaid share (Q1)
- Example: ₦40,000 recovery → ₦10,000 per guarantor
- **Each guarantor capped by 25% of original approved loan principal (`principalAmount × 0.25`) (Q2)**
- Never deduct beyond applicable liability or collect more than remaining obligation
- Capping prevents cross-guarantor liability transfer; obligations allocated at origination and remain fixed per guarantor

### Collection Authorization and Execution
- **Mandate/Consent Tracking**: Guarantor bank details collected at acceptance; consent status recorded (Q5)
- **Provider Integration Point**: Infrastructure prepared for supported collection provider
- **Before Initiating Collection**:
  1. Verify guarantor identity and authorization
  2. **Verify valid mandate/consent is present, covering specific loan, maximum liability (25% of principal), default conditions, recovery calculation, and authorized collection mechanism (Q5)**
  3. Verify collection amount within guaranteed limit (25% of principal per guarantor) (Q2)
  4. Verify obligation is still outstanding
  5. Check for duplicate attempts
  6. Record collection reference
- **If Mandate/Provider Integration Unavailable**: Clearly report exact blocker; do not bypass consent or simulate successful collections (Q5)
- **Refund approval workflow**: all overpayments remain `pending_review` until administered by authorized administrator with auditable identity, reason, amount, and timestamp (Q4). Apply separation of duties where supported.

### Borrower Resumes Repayment
- Recalculate outstanding recovery obligation
- Credit only verified borrower repayments
- Reduce remaining guarantor recovery obligation
- Stop further collection when obligation fully satisfied
- Cancel or adjust pending collection attempts where provider supports it
- Prevent duplicate recovery

### Collection Records Maintained
- Recovery trigger, applicable installments, total recovery obligation
- Four guarantors with individual allocations
- Authorization and mandate status
- Collection attempts (successful/failed/partial)
- Provider references
- Reversals
- Outstanding guarantor liability
- Notifications
- Final settlement

### Database Changes (recovery tracking)
- `RecoveryObligation` created per guarantor with:
  - `totalAssignedRecovery` (share amount)
  - `remainingRecoveryBalance` (outstanding)
  - `amountRecovered` (actual recovered, starts at 0)
  - `monthlyRecoveryAmount` (current cycle share)
  - `deductionExecutionStatus` ("not_enabled" by default)
  - `currentCycleObligation`, `currentCycleShare`, `currentCycleOverdueAmount`, `currentCycleCurrentMonthAmount`
  - `deductions` array with: amount, status, paidAt, attemptedAt, reference, providerReference, installmentNumber, failureReason
  - `lastCalculatedAt` timestamp
- `loan.recoveryStatus = "in_recovery"` (on recovery_120_days)
- `loan.status = "defaulted_60_days"` (at trigger)

### Failure Conditions
- `deductionExecutionStatus = "not_enabled"`: No actual deductions executed; attempt tracked infrastructure-only
- No valid mandate/consent: Collection cannot proceed
- Guarantor insufficient liability: Cannot deduct beyond guaranteed amount
- Obligation already satisfied: Stop collection
- Duplicate attempt: Prevented by reference tracking

### SocketScore Implications
- Guarantor recovery fulfillment/non-fulfillment may trigger score updates
- See `SOCKETSCORE.md`

---

## 9. Full Settlement

### Trigger
- Loan reaches `remainingBalance <= 0` after repayments

### Process
1. `loan.status = "completed"`
2. `loan.completedAt = now`
3. All non-replaced guarantors: `g.status = "released"`, `g.remainingGuaranteedBalance = 0`
4. Audit log: `loan_full_repayment`
5. Notifications to borrower and all guarantors: "Guarantee Released" / "Loan Fully Repaid"
6. SocketScore update for full settlement

### Notifications
- Borrower: "Congratulations! Your loan has been fully repaid."
- Each guarantor: "Guarantee Released" - liability released

### SocketScore Implications
- Full settlement triggers score update (likely positive)
- See `SOCKETSCORE.md`

---

## 10. Repeat Borrowing Eligibility

### Conditions
- Member with completed loan: eligible for new application
- Member with active/recovering loan: cannot apply until resolved
- Multiple completed loans: eligibility tier progresses (1st loan → 2nd loan → higher tiers)
- Savings consistency and months count reset per new application type (emergency vs regular)

### Process
1. Member clears outstanding balance (loan status → `completed`)
2. Member may immediately apply for new loan
3. Backend re-evaluates eligibility based on completed regular loan count
4. Tier percentage adjusts: first loan 1.5x, second loan 2.0x net savings (emergency loan independent at 0.75x)

---