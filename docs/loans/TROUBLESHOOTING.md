# SocketMonnie Developer Troubleshooting Guide

## Overview

This document covers common failures, their causes, relevant files, debugging steps, and safe recovery procedures for the SocketMonnie loan module.

---

## 1. Repayment Failures

### Symptom: Repayment webhook returns 400 "Unable to verify payment"

**Cause**: Flutterwave transaction ID not found, currency mismatch, or transaction already processed.

**Debugging Steps**:

1. Verify the `reference` and `tx_ref` match expected format (`LRP_YYYYMMDD_Hex_userIdLast6`)
2. Check that the `currency` in the request matches `NGN`
3. Confirm the transaction ID (`transactionId` or `transaction_id`) is a valid Flutterwave transaction
4. Check `socketmonnie` logs for `handleRepaymentWebhook` error details
5. Verify the loan is in a payable status (`active`, `warning_30_days`, `defaulted_60_days`, `restricted_90_days`, `recovery_120_days`)

**Safe Recovery**:

- If the payment was already processed (idempotent check), return success without re-processing
- If the transaction is truly new, verify Flutterwave dashboard for the transaction status
- Use `GET /api/payments/status/:reference` to check payment status independently
- For duplicate webhook redelivery: the `eventKey` deduplication in `processLoanRepayment()` prevents double-counting

### Symptom: Repayment applied but SocketScore not updated

**Cause**: Score update function not called after `processLoanRepayment()`, or deduplication prevented the update on second attempt.

**Debugging Steps**:

1. Check `processLoanRepayment()` in `LoanService.js` — does it call `updateSocketScore()`?
2. Verify `socketScoreHistory` has the expected entry for the repayment event
3. Check if the webhook was redelivered — the deduplication key may have prevented the second update
4. Look for `eventKey` in the webhook payload vs. history entries

**Safe Recovery**:

- Run reconciliation: `reconcileSocketScore(memberId)` (see `SOCKETSCORE.md`)
- If a qualifying event is missing from `socketScoreHistory`, manually trigger the appropriate score update via backend endpoint
- Never retroactively change `socketScore` without tracing the original event

### Symptom: Overpayment excess not recorded in `overpaymentRefunds`

**Cause**: `processLoanRepayment()` logic flow: payment <= remainingBalance, so no excess recorded.

**Debugging Steps**:

1. Check the payment amount vs. `loan.remainingBalance` at the time of repayment
2. If `payment > remainingBalance`, the excess should have been recorded in `loan.overpaymentRefunds[]` with `status: "pending_review"`
3. Verify the ledger entry was written with `eventKey: overpayment_excess:${paymentReference}`
4. Check that the notification included both applied and excess amounts

**Safe Recovery**:

- If excess was genuinely not recorded (bug), the reconciliation process will detect the discrepancy
- Admin can review pending overpayment refunds via admin dashboard
- Approve or reject the overpayment refund; if approved, the excess can be handled per approved business rule
- Never silently discard excess; it must either be refunded to borrower or recorded for review

---

## 2. Duplicate Webhook Handling

### Symptom: Same Flutterwave webhook processed twice, causing overpayment

**Cause**: Flutterwave redelivers webhook after timeout or network error.

**Debugging Steps**:

1. Check the `eventKey` or `reference` in the webhook payload
2. Query the database for existing repayment records with the same reference
3. Verify `processLoanRepayment()` ran the idempotency check: `if (loan.repaymentHistory.some(r => r.reference === reference)) return success`
4. Check `socketScoreHistory` for duplicate event entries

**Safe Recovery**:

- The deduplication logic is built into `processLoanRepayment()` — second processing returns success without score/ledger changes
- If duplicates somehow occurred despite deduplication, run reconciliation to detect the double-counting
- Manually adjust: subtract the duplicated amount from `remainingBalance`, remove the duplicate repayment history entry, and adjust `socketScore` accordingly (with audit trail)

### Symptom: Webhook signature validation fails

**Cause**: Invalid `FLW_SECRET_HASH` header, wrong endpoint, or tampered payload.

**Debugging Steps**:

1. Verify the `FLW_SECRET_HASH` environment variable is set correctly
2. Check that the webhook URL matches what Flutterwave has configured
3. Inspect the raw payload — ensure no encoding issues
4. Look for `401 Unauthorized` errors in the webhook route handler

**Safe Recovery**:

- Flaskwave will redeliver webhooks automatically; no manual intervention needed
- Ensure the endpoint is reachable and returns HTTP 200 to acknowledge receipt
- Check nginx/routing config if behind a proxy
- Verify `FLW_PUBLIC_KEY` and `FLW_SECRET_KEY` are correct in `.env`

---

## 3. Guarantor Acceptance Failures

### Symptom: Guarantor responds but acceptance not recorded

**Cause**: Token expired, loan status changed, or unauthorized responder.

**Debugging Steps**:

1. Check `tokenExpiresAt` — must be > `new Date()`
2. Verify loan status is still `waiting_guarantor` (not `pending_review` or `active`)
3. Confirm the guarantor's `userId` matches the token's `guarantorUserId`
4. Look for `403: "You are not authorized to respond to this guarantor request."`

**Safe Recovery**:

- If token expired, initiate a new guarantor invitation via `POST /api/loans/:loanId/replace-guarantor` or have the borrower send new invitations
- If loan status changed, borrower may need to restart guarantor invitation process
- Never modify token expiration from the frontend; handle from backend only

### Symptom: "All 4 guarantors must accept this loan before approval"

**Cause**: One or more guarantors have status other than `accepted`, or a guarantor is `isReplaced`.

**Debugging Steps**:

1. Check `loan.guarantors[i].status` for each of the 4 guarantors
2. Verify none have `isReplaced: true` and then `status !== "accepted"`
3. Check if any guarantor was rejected and not replaced
4. Use `GET /api/admin/loans/:loanId` to see full loan state

**Safe Recovery**:

- Borrower must replace rejected/expired guarantors via `POST /api/loans/:loanId/replace-guarantor`
- Only guarantors with status `rejected` or `expired` can be replaced
- After replacement, wait for new guarantor acceptances; all 4 must accept before admin approval

---

## 4. Incorrect Loan Statuses

### Symptom: Loan shows `active` but no installments generated

**Cause**: Disbursement confirmation may have failed partway through, or admin skipped installment generation.

**Debugging Steps**:

1. Check loan `payoutStatus` — should be `completed`
2. Check `loan.installments` array — should have entries for the loan duration
3. Check `loan.reviewedAt` and `loan.disbursedAt` — should have timestamps
4. Look for admin notification errors when `POST /api/admin/loans/:loanId/approve` was called

**Safe Recovery**:

- If `payoutStatus === "completed"` but no installments: admin can re-run approval, which is idempotent
- If `payoutStatus === "pending"`: manual disbursement not yet confirmed; verify outside transfer completed
- Check `Backend/Controllers/AdminController.js` → `approveLoan` messaging for the exact flow

### Symptom: Loan stuck in `pending_review` despite all 4 guarantors accepted

**Cause**: Admin approval not triggered, or financial invariant check failed.

**Debugging Steps**:

1. Verify all 4 guarantors have `status === "accepted"` and `!isReplaced`
2. Check `loan.allGuarantorsAccepted` flag
3. Look for financial invariant error: `disbursementAmount + interestAmount != principalAmount`
4. Verify borrower bank details are present and valid (10-digit account number)

**Safe Recovery**:

- If all prerequisites met but admin hasn't approved: admin should review and approve via dashboard
- If financial invariant failed: check the interest calculation; must be `principal × 0.02`
- If bank details missing: borrower must add/update profile bank details before disbursement

---

## 5. SocketScore Inconsistencies

### Symptom: Member's score differs between frontend and admin API

**Cause**: Score updated by different code paths without consistent deduplication, or reconciliation not run after bulk events.

**Debugging Steps**:

1. Retrieve score from both endpoints; compare `socketScore` values
2. Check `socketScoreHistory` length and entries — are there duplicate events?
3. Run reconciliation: `reconcileSocketScore(memberId)`
4. Check for recent events that should have triggered updates (repayments, defaults, referrals)

**Safe Recovery**:

- Reconciliation will detect discrepancies without auto-fixing
- If a genuine mismatch is found, investigate the original event sources
- Apply corrected score update with full audit trail in `socketScoreHistory`
- Never simply set `socketScore` to a new value without tracing the event

### Symptom: Score not updating after default escalation

**Cause**: `runLoanDefaulterEscalation()` not calling score update, or deductionExecutionStatus blocking.

**Debugging Steps**:

1. Check cron execution: `POST /api/admin/loans/:loanId/trigger-defaulter-check`
2. Look at `loanDefaulterEngine.js` → `runLoanDefaulterEscalation()` — does it call `updateSocketScore()` for default events?
3. Verify loan status changed to `defaulted_60_days`
4. Check `socketScoreHistory` for a `default_60_days` entry

**Safe Recovery**:

- If the cron ran but score wasn't updated, an admin can manually trigger the score update via backend
- The default event weight is -40; ensure it was applied
- Check that `deductionExecutionStatus` on recovery obligations doesn't block the update (it shouldn't for scoring purposes)

---

## 6. Failed Collections

### Symptom: Guarantor recovery obligation tracked but no actual deduction

**Cause**: `deductionExecutionStatus = "not_enabled"` by default; no authorized collection mechanism active.

**Debugging Steps**:

1. Check `RecoveryObligationModel` → `deductionExecutionStatus`
2. Verify mandate/consent is present for the guarantor
3. Check if provider integration is available for actual bank deductions
4. Look at `collectionAttempts` array for tracked attempts

**Safe Recovery**:

- By design, no actual deductions occur without authorized collection mechanism and guarantee consent
- Collection attempts are tracked infrastructure-only via `attempt-collection` endpoint
- If collection is needed, the blocker must be explicitly resolved (mandate, provider integration, authorization)
- Do not bypass consent or simulate successful collections

### Symptom: "Cannot find recovery obligation" error

**Cause**: Obligation not created for this loan/guarantor pair, or obligation was already completed/deleted.

**Debugging Steps**:

1. Check if loan is in `defaulted_60_days` or `recovery_120_days` status
2. Verify the guarantor was actually on this loan (check `loan.guarantors`)
3. Use `POST /api/loans/:loanId/initiate-recovery` to create obligations
4. Check existing obligations via database direct query

**Safe Recovery**:

- Initiate recovery via admin endpoint if loan is in defaulted state
- Obligations are created per guarantor (equal 25% share of applicable obligation)
- If obligation already exists, it may have been completed; check `amountRecovered` and `remainingRecoveryBalance`

---

## 7. Database and Schema Issues

### Symptom: Mongoose validation error on loan creation

**Cause**: Financial values don't satisfy invariants, or guarantor validation failed.

**Debugging Steps**:

1. Check `principalAmount`, `interestAmount`, `totalRepayable`, `disbursementAmount` relationship
2. Verify `interestAmount = principalAmount × 0.02` and `totalRepayable = principalAmount` and `disbursementAmount = principalAmount - interestAmount`
3. Check that exactly 4 guarantor referral codes were provided
4. Verify each guarantor meets 25% minimum savings requirement

**Safe Recovery**:

- Correct the financial values before creating the loan
- Use the `InterestCalculationService` or equivalent for interest computation
- Do not hardcode values that violate invariants

### Symptom: Duplicate loan numbers

**Cause**: Race condition during concurrent application, or manual insertion bypassing schema validation.

**Debugging Steps**:

1. Check if `loanNumber` already exists in database: `Loan.findOne({ loanNumber })`
2. Verify the generation algorithm includes timestamp + random suffix
3. Look for `unique: true` index on `loanNumber` in schema

**Safe Recovery**:

- The `{ loanNumber: 1 }` unique index should prevent duplicates at DB level
- If duplicate slipped through, one record must be deleted or merged (admin decision)
- Investigate the concurrent application that caused the clash

---

## 8. Admin Dashboard Inconsistencies

### Symptom: Admin loan table shows different status than loan details page

**Cause**: Cached data, stale API response, or different query filters applied.

**Debugging Steps**:

1. Clear browser cache and reload the admin dashboard
2. Check the API responses from `GET /api/admin/loans` vs `GET /api/admin/loans/:loanId`
3. Verify the same search/filter parameters are used
4. Check for frontend state management issues (e.g., Redux/store vs API data)

**Safe Recovery**:

- Refresh from API; the backend is the authoritative source
- If discrepancy persists, check for concurrent modifications (another admin modifying simultaneously)
- Audit logs show who changed what and when

### Symptom: Payout status/reference not showing in admin loan list

**Cause**: New fields (`payoutStatus`, `payoutReference`) not included in the list projection.

**Debugging Steps**:

1. Check `AdminService.getLoans` projection — does it include `payoutStatus` and `payoutReference`?
2. Verify the admin route query projects the correct fields
3. Look at `Backend/Routes/AdminController.js` or `AdminController.js` list endpoint

**Safe Recovery**:

- Add the missing fields to the projection; this is a frontend-data mapping issue, not a data loss
- The fields exist on the loan model; they just need to be projected in the list query

---

## 9. Environment and Configuration

### Symptum: Flutterwave webhooks not reaching endpoint

**Cause**: Wrong `WEBHOOK_URL` in Flutterwave dashboard, or endpoint blocked by firewall.

**Debugging Steps**:

1. Check `.env` for `FLW_PUBLIC_KEY`, `FLW_SECRET_KEY`, `FLW_SECRET_HASH`
2. Verify the webhook endpoint URL: `POST /api/webhook` is registered in Flutterwave dashboard
3. Check network connectivity — is the server publicly reachable?
4. Look for `401 Invalid signature` errors (means request reached endpoint but auth failed)

**Safe Recovery**:

- Update Flutterwave dashboard with correct webhook URL
- Ensure the server port/matching what's configured
- Return HTTP 200 from the endpoint immediately to acknowledge receipt; processing happens asynchronously

### Symptom: SocketScore always 0 or base value

**Cause**: Score update function never called, or `socketScoreHistory` deduplication blocking all updates after first.

**Debugging Steps**:

1. Check if any qualifying events occurred for the member
2. Verify `updateSocketScore()` was called after each event
3. Look at `socketScoreHistory` — if many entries exist but score is still base, there may be a weight calculation bug
4. Check that the member's `initialBaseScore` is correctly computed from tier and savings

**Safe Recovery**:

- Manually trigger reconciliation
- If score genuinely hasn't been updated, trace which events should have triggered updates and ensure those code paths are executed
- Never set score directly without event-based update; violates the authoritative update mechanism

---

## 10. Safe Recovery Procedures

### General Principles

1. **Never fabricate financial records** — no fake payments, repayments, or collections
2. **Always trace to the original event** — every fix must have an audit trail
3. **Use reconciliation before manual correction** — `reconcileSocketScore(memberId)` detects but does not auto-fix
4. **Preserve history** — `socketScoreHistory` and `financial_ledger` entries must not be deleted or altered retroactively
5. **When in doubt, present the issue for explicit approval** — especially for financial corrections

### Recovery Checklist

- [ ] Identify the exact symptom and affected records
- [ ] Trace to the authoritative source (database, webhook, API call)
- [ ] Run reconciliation to detect discrepancies
- [ ] Determine if the issue is a bug or expected behavior per business rules
- [ ] If bug: fix in code, then re-run affected operations with test data
- [ ] If expected behavior: document the workaround or config change
- [ ] Verify the fix with targeted tests (not real money)
- [ ] Document the root cause and recovery procedure

### When to Escalate

- Any scenario involving real money movement that was incorrectly handled
- SocketScore discrepancies that reconciliation cannot explain
- Data integrity issues (duplicate records, missing invariants)
- Webhook processing failures that lost or double-counted events
- Guarantor collection mechanism authorization gaps

For all of the above, present the exact issue with affected record IDs and relevant code references for explicit approval before taking action.