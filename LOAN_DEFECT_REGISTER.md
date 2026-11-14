# SocketMonnie Loan Workflow — Defect Register & Fixes

_Verified against actual code 2026-11-09. Confidence: every entry was read in source._

## CONFIRMED DEFECTS

### P0

| ID | Sev | Workflow | File | Problem | Root cause | Fix |
|----|-----|----------|------|---------|-----------|-----|
| LD-01 | P0 | W5/W6 Admin review & approve | `Frontend/src/pages/admin/LoansAdmin.jsx:64,90,95,106,112,118,134` | `toast.*` and `<TopHeader>` used but **neither imported** (imports L1-15) → `ReferenceError` on any load failure or approve/reject | Missing imports | Import `toast` (react-hot-toast) + `TopHeader`; copy fix (LD-02) |
| LD-02 | P0 | W6 Disbursement | `Backend/Services/LoanService.js:608-760` | "Approve" performs **accounting-only disbursement**: sets `payoutStatus="completed"`, fabricates `PAYOUT-${Date.now()}`, credits no account. No FLW `transfer` call exists; no beneficiary account is ever collected in apply (`disbursementMethod` only). Admin UI copy says "No payout will be sent" while backend claims disbursed. | Transfer integration never implemented; destination details never captured | **Business-rule blocker** — cannot auto-transfer without a verified destination account + payout integration. Fix applied: honest copy + audit note. Do NOT ship real-money disbursement until transfer integration lands. |

### P1

| ID | Sev | Workflow | File | Problem | Root cause | Fix |
|----|-----|----------|------|---------|-----------|-----|
| LD-03 | P1 | W8 Repayment verify | `Backend/Services/LoanService.js:1104-1109` | `verifyLoanRepayment` allows only `active|warning_30_days` — defaulted/restricted/recovery borrowers can initialize but cannot callback-verify | Allowlist narrower than `initialize`/`process` | Unify to the 5 payable statuses |
| LD-04 | P1 | W8 Repayment init | `Backend/Services/LoanService.js:995` | `initializeLoanRepayment` omits `recovery_120_days` — last-stage borrower cannot repay | Missing status | Add `recovery_120_days` |
| LD-05 | P1 | W3 Guarantor visibility | `Backend/Repositories/GuarantorRepository.js:18`, `Controllers/GuarantorController.js:39-73` | `GET /guarantors/loan/:loanId` returns ONE arbitrary guarantor (findOne) though every loan has 4 | findOne vs array | Return all active guarantors (filter `isReplaced:false`) |
| LD-06 | P1 | W9 Overdue/default detection | `Backend/Server/app.js:325-343` | No defaulter cron — escalation only via manual `POST /api/loans/admin/process-defaulters`. Statuses never advance automatically; `warning_30_days` etc. never trigger. | Cron never scheduled | Schedule daily defaulter cron (same pattern as reconciliation/score crons) |
| LD-07 | P1 | W4 Replace-guarantor flow | Frontend: `services/loans.js` missing `replaceGuarantor` | Backend `POST /api/loans/:loanId/replace-guarantor` exists but no frontend fn/UI — rejection is a dead-end | Frontend gap | Add service fn + replace UI on LoanApply (waiting_guarantor + rejected guarantor) |
| LD-08 | P1 | W1 Eligibility drift | `Backend/Services/AdminService.js:12-18` | `defaultSettings.loanTiers.firstLoan=0.7` vs `constants.js` 1.5 — whichever seeds SystemSettings first wins, shifting `maxLoanAmount` | Duplicated defaults | Align AdminService defaults to `LOAN_TIERS` |
| LD-09 | P1 | W5 Admin UX honesty | `Frontend/src/pages/admin/LoansAdmin.jsx:476` | Says "No payout will be sent" while backend `approveAndDisburseLoan` marks disbursed | Copy drift | Correct copy to approve+ledger-disburse wording |

### P2

| ID | Sev | Workflow | File | Problem | Root cause | Fix |
|----|-----|----------|------|---------|-----------|-----|
| LD-10 | P2 | Data loss | `LoanModel`, `SavingsModel` | Writes to non-existent paths silently dropped: `loan.lastPaymentAt`, `loan.rejectedAt/rejectedBy`, `withdrawal.completedAt/totalDeducted` | Missing schema fields | Add fields to both models |
| LD-11 | P2 | Display/admin | `Routes/GuarantorRoutes.js:25-31` | `getGuarantorDetailsAdmin` undefined → route never mounts | Dead conditional | Remove dead route block |
| LD-12 | P2 | Dead code | `Routes/Policyconfigroutes.js` | Never mounted; import path wrong case (`Policyconfigcontroller.js`) | Unfinished feature | Delete file (dead + broken) |
| LD-13 | P2 | Frontend schedule | `Frontend/src/pages/user/LoanDetails.jsx:57-58` | Schedule object treated as array → always EmptyState | Wrong destructure | Use `schedule.schedule` |
| LD-14 | P2 | Frontend honesty | `pages/user/LoanSummaryCard.jsx` | Hardcoded fallbacks (₦150k/₦50k/"SM20260307"/badge always Active) | Placeholders | Render real data / "—" when absent, status from loan |
| LD-15 | P2 | Status consistency | `components/ui/Badge.jsx`, `LoanHistory.jsx`, `LoansAdmin.jsx` filter | `waiting_guarantor/restricted_90_days/recovery_120_days` → raw snake_case / missing filter options | Incomplete mapping | Add badge cases + filter options |
| LD-16 | P2 | Guarantor verify auth | `Frontend/src/routes/index.jsx:134` | Public token view (`GuarantorRoutes:9` is public) sits behind MEMBER auth | Wrong nesting | Move route outside ProtectedRoute as public |
| LD-17 | P2 | Overpay nuance | `LoanService.js:828-836` | Overpayment hard-blocked (no business rule for excess) | No rule | **Blocker note**: excess handling unimplemented; currently rejects cleanly. No invented rule. |
| LD-18 | P2 | Documentation | `pages/legal/Terms.jsx:241` | Claims 1%/mo interest vs implemented 2% flat upfront | Copy drift | Align copy to 2% flat |

### P3

| ID | Sev | Workflow | File | Problem | Fix |
|----|-----|----------|------|---------|-----|
| LD-19 | P3 | Repaid-summary honesty | `LoanRepay.jsx:164` | Hardcodes `Principal = amountDue`, `Interest = ₦0` | Show real fields (Tracker pattern) |
| LD-20 | P3 | Admin search | `AdminService.js:187` `{_id:{$regex:search}}` — ObjectId regex never matches | Search `loanNumber` too |
| LD-21 | P3 | Guarantor limits | Hardcoded 70000 / 0.25 in 3 spots (not imports of constants) | Import `GUARANTOR_MIN_SAVINGS`, `GUARANTOR_MIN_PERCENTAGE` |
| LD-22 | P3 | Service hygiene | `services/index.js` double export `getLoanById`; `Notifications.jsx:76` hardcoded path; `LoanRepaySuccess` toast stubs | De-dupe export; use `ROUTES.GUARANTOR_VERIFY` |

## VERIFIED-NOT-BROKEN (evidence kept)

- 2% interest: fixed flat in `InterestCalculationService`, upfront deduction, `totalRepayable = principal` — consistent everywhere loan money math happens
- Eligibility enforced backend-side (tiers, savings, consistency, active-loan guard, terms gate, SoD on approve)
- Repayment idempotency (`repaymentHistory` tx check + `Savings.transactionId` unique + status guards), FLW-verified before credit, `LRP_` references, idempotent webhook
- Guarantor response token ownership + expiry dual-persist, 48h TTL, promote only at 4/4
- `processLoanRepayment` allowed statuses = 5 payable statuses; overpay blocked; FIFO allocation; penalty once per installment
- LoanRepay navigates to `CompleteLoanRepayment` (live); `LoanRepaySuccess` reachable by URL only
