# SocketMonnie — Workflow Checklist (working doc)

Status: ✅ verified · 🛠 fixed this pass · ⚠ issue found · ⛔ external blocker

| # | Workflow | Pages | API (frontend → backend) | Status | Notes |
|---|----------|-------|--------------------------|--------|-------|
| A | Savings | Savings.jsx, SavingsDeposit.jsx, DepositSuccess/Failed, Withdraw.jsx, ConfirmWithdrawal.jsx, WithdrawalSuccess.jsx | `/savings/summary|history|report`, `/payments/deposit/initiate|verify|callback|webhook`, `/savings/withdraw-request`, `/admin/withdrawals/*` | 🛠 fixed this pass | deposit→verify→ledger→score chain verified end-to-end in code; refund/withdrawal ledger re-check fixed |
| B | SocketScore | SocketScore.jsx | `/scores/me|breakdown|history`, `<admin score config>` | 🛠 fixed this pass | components validated, score fallback fixed, admin config routes present |
| C | SocketMinutes | Minutes.jsx | `/payments/minutes/due|initialize|verify` | 🛠 fixed this pass | gateway-authoritative verify, atomic settlement, ownership check added; minutes webhook `v` scope bug FIXED this pass |
| D | Loan | LoanApply.jsx, LoanDetails.jsx, LoanHistory.jsx, LoansTracker.jsx | `/loans/eligibility|apply|:id|schedule|history`, `/loans/repay/initialize|verify`, `<admin approve/reject>` | 🛠 fixed this pass | 2% upfront interest implemented; withdraw/cancel application added (`POST /loans/:id/cancel`) |
| E | Reports | Reports.jsx, AdminReports.jsx | `/reports/monthly|download-pdf`, `/admin/reports|pdf|excel` | 🛠 fixed this pass | outstanding-loan status chain fixed; real MoM growth metrics |
| F | Profile | Profile.jsx | `/user/me`, `/user/personal-info`, `/user/bank-details`, `/user/kyc`, `/user/pin` | 🔍 in progress | |
| G | Guarantor | LoanApply (guarantors), GuarantorStatusCard, GuarantorVerify | `/guarantors/*`, `/loans/:id/replace-guarantor` | 🔍 | |
| H | Onboarding | GetStarted, PersonalInfo, KycUpload, CreatePin, Biometrics | `/auth/*`, `/user/*` | 🔍 | OTP read path ⛔ external blocker (owner decision: do not read OTP inbox) |
| I | Auth | Login, Register, VerifyOtp, Forgot/Reset | `/auth/*` | ✅ login verified live (member: praisee827@gmail.com / 87654321 — login succeeds with terms+privacy flags; earlier 400s were missing flags); register ⛔ needs OTP inbox (owner decision) | |
| J | Admin | Dashboard, Members, LoansAdmin, WithdrawalApprovals, AdminReports, Settings, AuditTrail | `/admin/*`, `/settings/*` | 🛠 fixed this pass | support referrals endpoint rewritten (was missing User import + fabricated data); ticket status filter fixed |
| K | Referrals | Referrals.jsx | `/referrals/stats|activity` + support verify queue | 🛠 fixed this pass | `ReferralService.processQualification` wired; support `/support/referrals` now queries real Referral collection (pending → registered/verified) |

## Cross-module consistency checks
- [x] deposit settles exactly once (webhook idempotency) — verified in code
- [x] savings balance = sum ledger — verified in code
- [x] SocketScore updates derived from real activity only — verified in code
- [x] minutes balance consistent — verified in code (atomic settlement + idempotency)
- [x] loan totals immutable post-terms (pre-change loans keep stored totals) — verified in code
- [ ] admin dashboards reflect ledger — pending live admin pass (browser disconnected)

## Live verification status (this pass)
- Backend `:5000` healthy after fixes (HTTP 200 /api/health)
- Frontend `:5173` serving (HTTP 200 /login)
- Frontend production build: ⏳ running
- Backend tests: loanInterest 10/10 ✅, batchE 9/9 ✅
- Member login: ✅ LIVE SUCCESS (praisee827@gmail.com / 87654321, terms+privacy accepted) — user data: socketScore 35, tier Bronze, membershipFeePaid true, kyc pending_review, status pending
- Member browser journey: ⛔ blocked — desktop browser disconnected (need user to re-open session in app)
- OTP signup/read journey: ⛔ external blocker (owner decision)

## Fixes applied this pass (uncommitted)
Backend:
- ReferralService.processQualification + hooks (K)
- AdminService withdrawal ledger re-check (A/J)
- LoanService.cancelApplication + LoanModel status withdrawn + routes (D)
- ReportsController outstanding-loan status + score fallback; FinanceController real growth metrics; SupportController resolvedThisMonth; CapitalService cleanup; ExpenseService reversal — (E/J)
- SupportController.getReferrals: missing User import + fabricated users query → real Referral collection with pending mapping (J)
- SupportController.getTickets: invalid status filter guard (J)
- MinuteController.verifyMinutes: ownership check (caller must equal meta userId) (C)
- PaymentService.handleMinuteWebhook: out-of-scope `v` ReferenceError → verifiedData fix (C)

Frontend:
- Admin Settings toast import fix; SupportDashboard ticket status open→pending (J)
- Loan cancel wiring (D)

## Known remaining / blockers
- ⛔ OTP-inbox signup/verify journey (owner-approved path blocked by owner decision)
- ⛔ Desktop browser disconnected — member journey browser testing paused
