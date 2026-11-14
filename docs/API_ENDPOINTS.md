# SOCKETMONNIE — API ENDPOINT INVENTORY

## Auth
| Method | Path | Purpose | Guard |
|---|---|---|---|
| POST | `/api/auth/register` | Register (Joi password policy) | financialLimiter |
| POST | `/api/auth/login` | Login (JWT cookie) | financialLimiter |
| POST | `/api/auth/verify-otp` | Verify OTP | financialLimiter |
| POST | `/api/auth/forgot-password` | Forgot password | financialLimiter |
| POST | `/api/auth/reset-password` | Reset password | financialLimiter |
| POST | `/api/auth/logout` | Logout | — |

## User / KYC / Onboarding
| Method | Path | Purpose | Guard |
|---|---|---|---|---|
| GET | `/api/user/me` | Current user | protect |
| PATCH | `/api/user/personal-info` | Update personal info | protect + validate |
| POST | `/api/user/kyc` | KYC upload (multer JPEG/PNG/PDF ≤5MB) | protect + validate |
| POST | `/api/user/pin` | Set PIN | protect + validate |
| PUT | `/api/user/bank-details` | Set bank details | protect + validate |

## Savings & Withdrawals
| Method | Path | Purpose | Guard |
|---|---|---|---|---|
| POST | `/api/payments/deposits` / `GET /api/payments/flutterwave/checkout` | Deposit init/checkout | protect + financialLimiter |
| GET | `/api/payments/callback` | Flutterwave redirect → reconcile+redirect | public (server-side) |
| GET | `/api/savings/summary` | Savings summary + available balance | protect |
| POST | `/api/savings/withdrawals` | Request withdrawal | protect + financialLimiter |
| GET | `/api/savings/history` | Savings history | protect |
| POST | `/api/payments/minutes/initialize` | Minutes arrears checkout | protect |
| GET | `/api/payments/minutes/verify` | Minutes verify | protect |
| GET | `/api/payments/minutes/due` | Minutes due | protect |

## Loans & Guarantors
| Method | Path | Purpose | Guard |
|---|---|---|---|---|
| GET | `/api/loans/eligibility` | Eligibility | protect |
| POST | `/api/loans/apply` | Apply (4 guarantors, 2% interest) | protect + financialLimiter |
| POST | `/api/guarantors/respond` | Guarantor accept/reject (token) | protect |
| POST | `/api/loans/repayments` | Repay (idempotent, overpay guard) | protect + financialLimiter |
| GET | `/api/loans/:id` | Loan details | protect |

## Payments / Webhooks / Reconciliation
| Method | Path | Purpose | Guard |
|---|---|---|---|---|
| POST | `/api/payments/webhook` | Flutterwave webhook (verif-hash, timing-safe) | provider signature |
| GET | `/api/payments/callback` | Flutterwave redirect | server-side |
| POST | `/api/payments/reconcile` | Fallback reconcile by reference | server-side |

## Reports, Scores, Admin, Settings, Notifications
| Method | Path | Purpose | Guard |
|---|---|---|---|---|
| GET | `/api/reports/monthly` | Monthly report | protect |
| GET | `/api/reports/download-pdf` | PDF statement | protect |
| GET | `/api/scores/history` | Score history | protect |
| GET | `/api/admin/loans` | Admin loan list | admin |
| POST | `/api/admin/loans/:id/approve` | Approve loan | admin + self-approval guard |
| GET | `/api/admin/withdrawals/pending` | Pending withdrawals | admin |
| POST | `/api/admin/withdrawals/:id/approve` | Approve withdrawal | admin + self-approval guard |
| POST | `/api/admin/withdrawals/:id/reject` | Reject withdrawal | admin |
| GET | `/api/settings/audit-logs` | Audit logs | super_admin/finance_manager |
| GET | `/api/settings` | System settings | protect/ super_admin PUT |
| GET | `/api/notifications` | Notifications | protect |

## Frontend service modules mapping
- `src/services/auth.js`, `user.js`, `savings.js`, `loans.js`, `guarantor.js`, `payments.js`, `reports.js`, `scores.js`, `adminService.js`, `tier.js`, `financeService.js`, `notifications.js`, etc.
