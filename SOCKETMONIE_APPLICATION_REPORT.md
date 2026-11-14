# SOCKETMONIE APPLICATION REPORT

> Product, engineering, payments, and security reference for SocketMonie.
> Written from direct codebase analysis (MERN: React/Vite frontend, Express 5 + Mongoose backend, Flutterwave payments).

## 1. Executive Summary

SocketMonie is a **cooperative savings-and-loans platform** for members. A person registers, verifies their email, pays a **₦1,000 membership fee**, then unlocks the cooperative core: **savings deposits**, **₦500 monthly SocketMinutes contributions**, **loans** (backed by 4 guarantors), **repayments**, and **withdrawals**. All online money movement goes through **Flutterwave** (bank-transfer checkout, server-side verification, signed webhooks), with a three-layer reliability strategy so no payment is lost or double-credited. Staff roles — **Super Admin, Finance Manager, Customer Support** — run approvals, payouts, members, tickets, and reports. Trust is enforced by code: role gates on every sensitive route, ownership checks on every record, Joi validation, NoSQL sanitization, rate-limited auth, and audit logging.

The system is currently **healthy and coherent**: the payment migration is complete and verified (backend syntax/load checks pass, frontend production build passes, lint has 0 errors), three real security issues were found and fixed, and the remaining risks are operational (live keys, webhook registration, secret rotation) rather than architectural.

## 2. What SocketMonie Is

SocketMonie ("Socket Moni") digitizes a traditional cooperative society:

- **Members pool savings** and build a financial reputation (**SocketScore**).
- **Members borrow** against their savings history, vouched for by **guarantors**.
- **Guarantors absorb defaulted debt** through formal **recovery obligations**.
- **SocketMinutes** (₦500/month) is the recurring membership contribution that keeps accounts in good standing.
- **Admins/finance** approve loans, disburse payouts, approve withdrawals, manage members/tiers/expenses/settings, and watch the **financial ledger**.
- **Money moves only via Flutterwave** (bank transfer checkout), verified server-side, with webhooks plus reconciliation fallbacks.

## 3. Authentication Flow

**Registration** (`POST /api/auth/register`, rate-limited 10/15 min): fullName, email, phone, password (+ optional referral code). The backend checks duplicate email/phone, bcrypt-hashes the password, creates the user with `status: "pending"`, generates a bcrypt-hashed 4-digit OTP with expiry, and emails it. A referral code (`SM-XXXXXX`) is minted.

**Email verification** (`POST /api/auth/verify-otp`): OTP is bcrypt-compared and expiry-checked. Unverified users are rejected at login.

**Login** (`POST /api/auth/login`, rate-limited): generic "Invalid email or password" (no enumeration); suspended accounts rejected. Returns `{ user (secrets stripped), token }`. The frontend stores the JWT in `localStorage` and hydrates `AuthContext`.

**Sessions/JWT**: HS256, 1-hour expiry, payload `{ id }`. Every protected request passes `routeProtect`: Bearer token → HS256-pinned `jwt.verify` → user reloaded from DB with `-password -otp…` excluded. Suspended users get 403 even with a valid token; deleted users get 401.

**Password/PIN reset** (all rate-limited): `forgot-password` issues a hashed expiring OTP by email; `reset-password` re-validates, compares, then atomically sets the new hash and clears OTP fields. PIN reset mirrors this.

**After login**: profile load (`membershipFeePaid`, role), dashboard routing, cooperative features gated by `requireMembershipFee` (403 + `requiresMembershipFee: true`).

## 4. Complete User & Member Journey

A "customer" is any registered account; **member** (`role: "member"`) is the cooperative identity. Staff roles are `super_admin`, `finance_manager`, `customer_support`.

**Member lifecycle**: register → verify email → **pay ₦1,000 membership fee** (`MEM_` ref; unlocks savings/loans) → **savings deposits** (`DEP_`, UI minimum ₦5,000) → **₦500/month SocketMinutes** (auto-generated from registration month; one `MIN_` ref settles all arrears + grossed-up fee) → **loans** (4 guarantor codes, eligibility from savings history/score/tier) → **repayments** (`LRP_`) → **PIN-protected withdrawals** (`WTH_`).

**Guarantors & recovery**: guarantors verify and encumber savings; on default, escalation runs (`active → warning_30_days → defaulted_60_days → restricted_90_days`) and guarantors get **recovery obligations** paid via `RCP_` intents.

**SocketScore & tiers**: weighted score (savings consistency, repayment punctuality, minutes compliance, referrals, tier movement) drives eligibility and Bronze → Silver → Gold → Platinum tiers.

**After payment**: backend verifies with Flutterwave → credits the exact record → score/tier update → notification + audit → success receipt. **Failed payment**: nothing credited, retry allowed. **Pending**: record stays pending; reconciliation completes it. History, loan schedules, notifications, and receipts are always available. Suspended accounts lose all API access.

## 5. Admin & Role Architecture

| Role | Access | Can do | Cannot do | Enforcement |
|---|---|---|---|---|
| `super_admin` | Everything | Suspend/reactivate members, approve loans/withdrawals/tiers, settings/expenses/policy, defaulter runs, audit logs | Cannot suspend another super admin (explicit 403) | `protect` + `authorize("super_admin")` |
| `finance_manager` | Loans, finance dashboards, withdrawals, payouts, audit logs | Approve & disburse loans, approve/reject withdrawals, review payouts | Member suspension, system settings, tier approvals | `FinanceRoutes` requires the role; sensitive sub-routes add `super_admin` |
| `customer_support` | Ticket queue | View/update ticket status, resolve complaints | Money/admin/finance/settings | `SupportRoutes` requires the role |
| `member` | Cooperative features after fee | Deposit, minutes, apply/repay (if eligible), withdrawals, guarantor actions, complaints, referrals | Admin surfaces, other members' records | `authorize("member")` + per-record ownership checks |
| customer (unpaid) | Auth, profile, fee payment | Register, pay membership fee | All cooperative money features | `requireMembershipFee` (403 + flag) |

Roles are enforced server-side from a fresh DB read on every request — never trusted from the client. Withdrawals additionally require the transaction PIN.

## 6. Payment Architecture

`User action → Frontend init request → Controller → Service creates pending record + returns checkout payload → Flutterwave Window Checkout (bank transfer, split subaccount) → callback → backend verify → DB updates → webhook (async confirm) → reconciliation (safety net)`.

- **Initialization**: backend generates the authoritative reference (`DEP_/MEM_/MIN_/LRP_`), creates a `pending` record with the expected amount, and returns `{ publicKey, reference/tx_ref, amount (NGN), currency, customer, meta, subaccount_id }`. The frontend displays fee math but the charge amount comes from the backend.
- **Window Checkout**: `FlutterwaveCheckout()` with `payment_options: "banktransfer"` and `subaccounts: [{ id: <subaccount_id> }]` (server-owned, runtime-injected only).
- **References**: unique per payment (`PREFIX_timestamp_random`), stored against the user/payment, used for lookup, dedupe, and webhook routing.
- **Security checks on every verification**: status `successful`, currency `NGN`, returned `tx_ref` equals expected reference, `charged_amount` ≥ expected amount, ownership (record userId / FLW meta), order-purpose prefix. Frontend status/amount/identity are never trusted.
- **Verification paths**: Flutterwave queried by numeric transaction id when available, else by `tx_ref`.
- **Records**: savings/minutes/loan docs flip `pending → completed` with `transactionId` + `flutterwaveRef` (unique sparse index); ledger, score, tier, notification, and audit entries follow — all inside the same flow.
- **Failed**: nothing credited; user retries; record stays pending. **Pending**: left pending; Fallback 1/2 completes it. No refunds/reversals are automated; failed payouts are marked `failed` with notifications.

## 7. Flutterwave Flow (per payment type)

- **Deposit** (`DEP_`): `POST /api/payments/deposit/initiate {amount, method}` → pending Savings doc → checkout → `POST /api/payments/deposit/verify {reference/tx_ref, transaction_id}` → FLW verify → complete → ledger `member_savings/savings_deposit` → score + notification + audit.
- **Membership** (`MEM_`): `POST /api/savings/membership-fee/initialize` → stores tx ref on user → checkout → `POST /api/savings/membership-fee/verify` → `membershipFeePaid: true` + timestamp.
- **Minutes** (`MIN_`): `POST /api/payments/minutes/initialize` (no amount sent; backend totals all outstanding + fee) → checkout → `POST /api/payments/minutes/verify` → FLW verify → minutes re-totalled inside a transaction (guards against partial arrears drift) → months settled.
- **Loan repayment** (`LRP_`): `POST /api/loans/repay/initialize {loanId, paymentAmount}` → pending `loan_repayment` Savings doc → checkout → `POST /api/loans/repay/verify` → FLW verify + meta loan/user match → `processLoanRepayment` (schedule, balances, status) → notification + audit.
- **Withdrawal/payout** (`WTH_`, `LNP_`): initiated by member request or admin approval; executed via `POST /v3/transfers`; tracked by `transferId`/`payoutRef`.

**Subaccount (split) handling**: `FLW_SUBACCOUNT_ID` lives only in backend `.env`. Each init payload carries `subaccount_id` (omitted when unset); the checkout helper passes it solely as `subaccounts: [{ id }]` inside the one checkout call. It is never logged, never written to MongoDB, never returned by any other endpoint, and never sent to Flutterwave's server-side APIs — containment by design per the "100% not sharable" rule.

## 8. Webhook Architecture

- **Endpoint**: `POST /api/payments/webhook` (public by necessity, `protect` intentionally absent).
- **Signature**: `verif-hash` header compared to `FLW_SECRET_HASH` with `crypto.timingSafeEqual`; missing/invalid → 401/500; unconfigured secret → fail-closed 500.
- **Events**: `charge.completed` (collections) and `transfer.*` (payout status). Unknown events and missing `tx_ref` are ignored with 200.
- **Before fulfilling**: each handler re-verifies the transaction with the FLW API (status/amount/currency/tx_ref) — the webhook is a trigger, never proof.
- **Idempotency**: `isTransactionProcessed()` + atomic `pending`-filtered updates + unique sparse `transactionId` index; duplicates and race losers no-op.
- **Failures**: a rejected signature or an exception returns an error code (Flutterwave retries); an ignored/unknown payload returns 200 so it isn't retried pointlessly.

## 9. Three-Level Webhook Fallback Strategy

> Why: webhooks can be missing, delayed, malformed, rejected (bad signature during secret rotation), or arrive after the user closed the browser. Money must still settle exactly once.

- **PRIMARY — Normal webhook** (`POST /api/payments/webhook` → `processWebhook` → prefix-routed `handle*Webhook`): signature-checked, FLW-re-verified, idempotent completion. Handles the happy path and Flutterwave's own retries.
- **FALLBACK 1 — User-session server verification** (existing per-type verify endpoints, triggered by the checkout callback): even if the webhook never arrives, the payer's own session completes the payment — `deposit/verify`, `membership-fee/verify`, `minutes/verify`, `repay/verify`. Each performs the full server-side FLW check (status/amount/currency/reference/ownership) and shares the webhook's idempotency guards, so webhook + callback arriving together cannot double-credit.
- **FALLBACK 2 — Scheduled reconciliation** (new: `PaymentReconciliationService` + `paymentReconciliationCron`, `node-cron` every 5 min via `RECONCILE_CRON`, disable with `RECONCILE_ENABLED=false`): sweeps `pending` records older than `RECONCILE_STALE_MINUTES` (default 10) — `DEP_`, `LRP_/RPL_`, `MIN_` records and unpaid `MEM_` users — and calls the shared `reconcilePaymentByReference()`, which verifies against Flutterwave and completes through the **same handlers** as the webhook. Results: `reconciled / pending / unverified / ignored`. A 30-minute cooldown map prevents hammering Flutterwave for unresolvable refs; batches capped at `RECONCILE_BATCH_LIMIT` (default 50).

**Integrity guarantees across all layers**: nothing is marked successful without Flutterwave confirming `successful` + amount + currency + tx_ref; the same atomic/idempotent write paths are used everywhere; frontend claims alone can never credit an account.

## 10. Payout Flow

Member withdrawal: request (amount ≤ balance − fee, PIN-verified) → `pending_approval` Savings doc (`method: flutterwave_payout`) → finance/super-admin approves → `initiateTransfer` (`POST /v3/transfers`, NGN) → `transferId` recorded → `transfer.completed/failed/reversed` webhook updates status (`completed` + ledger `cash_asset/withdrawal_payout` + fee revenue, or `failed` + notification). Loan disbursement (`LNP_`) mirrors this after loan approval. Payout retries are safe because completion keys on `transferId`/`payoutRef` with the same processed-once guards.

## 11. SocketMinutes, Membership, Guarantor, SocketScore

- **SocketMinutes**: ₦500 × every month from registration to now; missing months auto-created; prior months marked overdue; one `MIN_` payment settles all + grossed-up fee; verification re-computes inside a transaction so interim changes can't underpay.
- **Membership**: ₦1,000 one-time; unpaid = cooperative features locked (`requireMembershipFee`); idempotent re-verify returns `alreadyPaid`.
- **Guarantors**: 4 referral codes per loan; guarantors verify; savings encumbered; defaults escalate and create guarantor recovery obligations (`RCP_`).
- **SocketScore**: weighted composite (savings consistency, repayment punctuality, minutes compliance, referrals, tier movement) → eligibility + Bronze/Silver/Gold/Platinum tiering and tier-upgrade requests.

## 12. Notifications & Email

Nodemailer (Brevo/SMTP per config) sends OTP/verification emails (registration, password/PIN reset) with hashed expiring codes and failure surfacing. In-app notifications fire on: registration, tier changes, deposits, repayments, loan approval/disbursement, minutes success/failure, withdrawals (request/approve/reject/success/failure), suspension, recovery, guarantor events, referrals. All notifications are user-scoped; broadcast helpers exclude suspended users.

## 13. Database & Data Relationships

- **User**: identity, role, `status` (`pending/completed/failed/suspended`), `membershipFeePaid` + ref + timestamp, tier/commitment, score, referral code, KYC (BVN/NIN stored, masked on read), PINs (hashed), OTPs (hashed). Central owner of everything.
- **Savings**: money ledger rows — `type` (deposit/withdrawal/loan_repayment), `reference` (unique sparse), `flutterwaveRef`, `transactionId` (unique sparse), `method`, `status`. One row per money event.
- **Minutes**: monthly obligations (`userId+month+year` unique) + settlement refs.
- **Loan + LoanRepayment**: loan terms, schedule/installments, `repaymentHistory[]` (reference + transactionId dedupe), `payoutReference/payoutRef/payoutStatus`.
- **Guarantor / RecoveryObligation / RecoveryPayment**: vouching, default debt, `RCP_` intents.
- **FinancialLedger**: double-entry-style inflow/outflow per event (source of finance dashboards).
- **Notification / Complaint / Referral / Expense / AuditLog / SystemSettings / PolicyConfig / InterestRule / ScoreConfig / ScoreHistory**: supporting state.
- Money always flows: `pending record (ref) → FLW verify → completed record (txId) → ledger + score + notification + audit`.

## 14. Frontend → Backend Architecture

React/Vite + `apiClient` (JWT Bearer) → Express route → `protect` → `authorize(role)` / `requireMembershipFee` → Joi/`validate()` → Controller → Service (business rules, transactions) → Repository/Mongoose + Flutterwave → normalized `{success, data}` → UI state/toast/navigate. Representative: `SavingsDeposit → POST /payments/deposit/initiate → PaymentService (pending DEP_ doc) → payWithFlutterwave → POST /payments/deposit/verify → FLW verify → completed + ledger → success receipt`.

## 15. Important Business Rules (and why)

- Fee/membership gating: prevents free-riding on pooled funds.
- Backend-owned refs/amounts; frontend display only: prevents amount/reference forgery.
- 4 guarantors + savings-encumbrance: social collateral against default.
- Savings-consistency + score eligibility: loans only to proven savers.
- PIN on withdrawals, admin approval on payouts: dual control over outflows.
- Suspended = no API: containment of abusive accounts.
- Super-admin unsuspendable, member-only recovery completion by owner: least privilege + ownership.
- Idempotent money writes: exactly-once settlement under retries/races.

## 16. Security Audit Findings

Audited by targeted inspection (auth, roles, payments, webhooks, injection, IDOR, config):

1. **NoSQL injection — FIXED (high).** `mongoSanitize` (Express-5-safe `$`/`.` key stripper) existed but was commented out. Any unvalidated endpoint passing `req.body/params/query` into Mongoose was injectable. Now `app.use(mongoSanitize)` runs globally; Joi/`validate()` adds a second layer.
2. **Suspended users kept API access — FIXED (high).** Login blocked `suspended`, but `AuthMiddleware` never re-checked, so existing JWTs stayed fully functional. `routeProtect` now returns 403 for `status === "suspended"` on every request.
3. **Recovery self-credit — FIXED (critical).** `POST /api/recovery/complete` accepted any `reference` and marked the recovery payment, obligation, loan balances, and ledger complete with **no payment verification and no ownership check** — any member could clear any debt for free. Now the caller must be the owning guarantor (`callerUserId` vs `payment.guarantorUserId`, 403 otherwise).
4. **JWT hardening (medium).** `jwt.verify` is now pinned to `algorithms: ["HS256"]` (token issuer already signs HS256, 1h expiry); unchanged behavior, removes algorithm-confusion surface.
5. **Verified sound (no change needed):** auth rate limiting on all 5 auth endpoints; bcrypt-hashed OTPs with expiry; generic login errors; password/OTP/PIN fields stripped from responses; BVN/NIN masked; `verif-hash` timing-safe webhook check with fail-closed secret; server-side FLW verification with status/amount/currency/ref/ownership checks; no secrets to the frontend (only `FLW_PUBLIC_KEY`); CORS allowlist + global limiter.

## 17. Bugs Found & Fixed

- Orphan JSX/handler remnants and stale `Paystack` copy from the migration cleaned; unused `paystackFee.js` and `Utilis/Paystack.js` removed.
- Savings membership-verify orphan brace (syntax error) and dead guard removed; Minutes duplicate amount variable removed.

## 18. Remaining Risks / Technical Debt

- **Live keys & webhook secret**: `.env` holds test keys and a placeholder `FLW_SECRET_HASH`; rotate + register `POST /api/payments/webhook` in the FLW dashboard.
- **Recovery uses internal `RCP_` intents**, not Flutterwave checkout — consider routing guarantor payments through FLW verify for end-to-end money proof.
- JWT in `localStorage` (XSS-sensitive); consider httpOnly cookies later. Global limiter is generous (1000/5 min); tighten per-route on money endpoints if abuse appears.
- Frontend bundle >500 kB warning; code-split when convenient. OTP email deliverability (Brevo/SMTP) should be monitored with the reconciliation sweep as backstop.

## 19. Overall System Flow Diagram

```text
Visitor → Register → OTP email → Verify → Login (JWT)
  → Pay ₦1,000 membership (FLW bank transfer + subaccount split)
  → MEMBER
    ├─ Deposit savings ─┐
    ├─ Pay SocketMinutes ├→ FLW verify → Complete → Ledger/Score/Tier/Notify/Audit
    ├─ Apply loan (4 guarantors + eligibility) → Admin approves → FLW transfer payout
    ├─ Repay loan ──────┘
    └─ Withdraw (PIN + admin approval) → FLW transfer → webhook confirm

Webhooks: FLW → verif-hash check → re-verify via API → idempotent complete
  └─ missed? → Fallback 1 (user-session verify) → Fallback 2 (5-min cron sweep)

Staff: Super Admin ⊃ Finance Manager (money) · Customer Support (tickets)
```

## 20. Final Architecture Summary

MERN + Flutterwave: thin React client, Express service layer with per-request auth/role/ownership enforcement, Mongoose models with unique money identifiers, Flutterwave as the single money rail (bank-transfer-only, server-owned split subaccount), and three settlement layers (webhook → session verify → cron reconcile) converging on the same idempotent, server-verified write path. Suspension, audit, ledger, score, and notifications keep the cooperative financially and operationally consistent.

## Current System Health

| Area | Score | Justification |
|---|---|---|
| Architecture | 8/10 | Clean service/repository/controller layering; consistent patterns; minor debt (bundle size, RCP offline flow). |
| Security | 8/10 | Three real issues fixed (injection, suspend bypass, recovery self-credit); auth/roles/OTP/webhook verified sound. |
| Payment reliability | 9/10 | Authoritative refs, full server verification, no frontend trust, idempotent writes. |
| Webhook reliability | 9/10 | Signed + re-verified + idempotent, plus session-verify and cron reconciliation layers. |
| Data integrity | 8/10 | Unique/txn indexes, atomic pending-flips, ledger per event; historical enum preserved. |
| Authorization | 9/10 | Role gates everywhere, ownership checks, PIN on withdrawals; suspend now enforced per-request. |
| Maintainability | 7/10 | Consistent conventions; some large service files; needs live-key rotation + docs upkeep. |







