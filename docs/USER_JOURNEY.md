# SOCKETMONNIE — USER JOURNEYS

## Overview

End-to-end member and administrative journeys across the SocketMonnie platform, tracing
user intent → frontend flow → backend endpoint → service → database → external provider →
confirmation/UI state.

---

## Member Journeys

### J1 — Registration & Onboarding → Savings → Dashboard

1. **Register** (`/register`) → backend `POST /api/auth/register` (Joi-validated; bcrypt hash).
2. **Verify OTP** (`/verify-otp`) → backend `POST /api/auth/verify-otp` → sets `socketmoni_token` cookie (httpOnly, secure, sameSite).
3. **Onboarding** (`/onboarding/*`) → personal info → KYC upload (`/api/user/kyc`, multer: JPEG/PNG/PDF ≤ 5MB) → PIN → biometrics.
4. **Dashboard** (`/dashboard`) → `GET /api/savings/summary`, `GET /api/scores`, `GET /api/notifications`.

### J2 — Savings Deposit → Deposit Success → Loan Eligibility

1. **Savings deposit** (`/dashboard/savings/deposit`) → initiate (`POST /api/payments/deposits`) → Flutterwave checkout (`GET /api/payments/flutterwave/checkout`).
2. **Flutterwave callback** → backend `GET /api/payments/callback` → server-side authoritative reconcile via `PaymentService.reconcileDepositByReference()` → success/failed page; cron fallback sweeps pending (`runReconciliation`).
3. **Deposit success** → frontend fetches summary → balance reflects confirmed credit.

### J3 — Loan Application → Guarantor Flow → Approval → Repayment

1. **Eligibility** → `GET /api/loans/eligibility`.
2. **Apply** → `POST /api/loans/apply` (requires 4 unique guarantor referral codes; 2% flat upfront interest; net payout = principal − interest).
3. **Guarantor verify** → token acceptance via `POST /api/guarantors/respond` (expiry persisted on standalone + embedded records; `isReplaced` enforced).
4. **Admin approval** → `POST /api/admin/loans/:id/approve` (4 accepted guarantors, self-approval blocked, audit logged).
5. **Disbursement** → loan disbursed (outflow `loan_disbursement` + inflow interest revenue once).
6. **Repayment** → `POST /api/loans/repayments` (idempotent by transactionId/reference; rejects overpayment; interest not re-charged).
7. **Completion** → loan closes; guarantors released.

### J4 — Savings Withdrawal

1. **Request** → `POST /api/savings/withdrawals` (available balance = net savings − pending/approved reservations; fee ₦100).
2. **Admin approval** → `POST /api/admin/withdrawals/:id/approve|reject` (self-approval blocked; payout success/failure handled via webhook).
3. **Payout webhook** → `POST /api/payments/webhook` (Flutterwave `verif-hash`; terminal states protected).

### J5 — SocketMinutes (Monthly Contributions)

1. **Init** → `POST /api/payments/minutes/initialize` (arrears checkout in one reference).
2. **Verify/webhook** → bounded settlement to arrears covered by checkout budget.

### J6 — Reporting & Score

1. **Monthly report** → `GET /api/reports/monthly` (+ PDF via `GET /api/reports/download-pdf`).
2. **SocketScore** → components: savings discipline (6m, tier-min fallback), loan repayment timeliness, referral activity; overall redistributed over scoreable components.

---

## Admin Journeys

### A1 — Loan Approval & Disbursement
- List/filter, review, approve (self-approval + 4-guarantor revalidation), audit log entry (`loan_approve`).

### A2 — Withdrawal Approvals & Payouts
- List pending, approve (self-approval blocked, available-balance aware), reject (audit log), payout webhook handling.

### A3 — Audit & System Oversight
- `GET /api/settings/audit-logs` (super_admin/finance_manager), filters by action/target/actor.

---

## Shared Financial Invariants (all journeys)

- Interest: fixed 2% upfront; netPayout = principal − interest; repayable = principal; revenue recorded once at disbursement.
- Deposits: one credit per provider transaction (idempotent by unique ref/transactionId; callback + webhook + cron converge safely).
- Withdrawals: one debit per approval (amount + fee once); reservations prevent overdraft.
- Repayments: one allocation per transaction; overpayment rejected.
