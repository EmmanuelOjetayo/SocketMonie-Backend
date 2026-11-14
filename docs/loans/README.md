# SocketMonnie Loan System - Overview

## Architecture

The SocketMonnie loan module is a full-stack fintech system for managing cooperative loans. It follows a branch-first workflow with Lakebase Postgres as the database, deployed on Neon. The system is built on a microservice architecture with clear separation between:

### Backend Services (Node.js + Express)
- **LoanService**: Core loan application, approval, disbursement, repayment, and default logic
- **PaymentService**: Flutterwave payment integration, webhook handling, deposit/withdrawal/payout processing
- **GuarantorService**: Guarantor management, acceptance/rejection, replacement flow
- **AdminService**: Admin loan review, approval, rejection, and reporting
- **FinancialLedgerService**: Audit trail and financial ledger entries for all transactions
- **RecoveryService**: Guarantor recovery obligation tracking and escalation

### Frontend (React + React Router)
- **User-facing**: Loan application, repayment, loan details, loan history
- **Guarantor-facing**: Guarantee requests, acceptance/rejection, liability exposure
- **Admin-facing**: Loan table, details, approval/rejection, financial reports

### Database (Postgres via Mongoose)
- **LoanModel**: Core loan records with financial invariants
- **RecoveryObligationModel**: Guarantor recovery tracking
- **UserModel**: Member profiles with bankDetails, savings, tier information
- **GuarantorModel**: Guarantor records with acceptance status and replacement history

### Key Design Principles
- **One authoritative source of truth**: Backend models and schemas define all financial values
- **Financial correctness invariants**: 2% flat upfront interest, totalRepayable = principal, disbursementAmount = principal - interest
- **No fake financial records**: All money movement is tracked; no simulated success responses
- **Backend-authoritative calculations**: Frontend never trusts frontend-submitted financial calculations
- **Idempotent financial operations**: All webhook handlers and API endpoints are idempotent

## Major Components

| Component | Purpose |
|-----------|---------|
| `LoanService` | Loan application, eligibility, guarantor validation, approval, disbursement, repayment |
| `PaymentService` | Flutterwave payment integration, webhook handlers, deposit/withdrawal/payout |
| `GuarantorService` | Guarantor invitation, acceptance, rejection, replacement, status tracking |
| `AdminService` | Admin loan search, approval, rejection, reporting, member management |
| `FinancialLedgerService` | Audit trail entries for all financial events |
| `RecoveryService` | Guarantor recovery obligation tracking at default_60_days |
| `SocketScoreService` | Member credit score updates across qualifying events |

## Frontend-Backend Communication

- **API Base**: `GET/POST /api/loans/*`, `GET/POST /api/admin/loans/*`, `GET/POST /api/payments/*`
- **Authentication**: JWT-based via `AuthContext`; roles include `super_admin`, `finance_manager`, `member`
- **Data format**: JSON responses with `success`, `message`, and resource data fields
- **Error handling**: All errors use `AppError` with appropriate HTTP status codes (400, 403, 404, 502)
- **Webhooks**: Flutterwave event callbacks handled at `POST /api/webhook` with signature validation

## Loan Lifecycle

The loan lifecycle flows from application through settlement:

```
Application → Guarantor Invitation → Acceptance → Admin Review → Manual Disbursement → Repayment → Default Progression → Settlement
```

Each stage has specific triggers, required conditions, database changes, notifications, and SocketScore implications documented in `LOAN_WORKFLOW.md`.

## Getting Started for Developers

1. **Explore the backend services** in `Backend/Services/` - start with `LoanService.js` for core loan logic
2. **Review the database schemas** in `Backend/Models/` - understand LoanModel, RecoveryObligationModel, UserModel
3. **Examine the API routes** in `Backend/Routes/` - see all implemented endpoints
4. **Check the frontend pages** in `Frontend/src/pages/user/` and `Frontend/src/pages/admin/`
5. **Review the confirmed business rules** in this documentation package, especially `LOAN_WORKFLOW.md` and `LOAN_API_REFERENCE.md`
6. **Run the test suite** in `Backend/tests/` to verify functionality
7. **Check environment variables** in `.env` for FLW_PUBLIC_KEY, FLW_SECRET_KEY, etc.

## Supported Loan Statuses

`["waiting_guarantor", "pending_review", "active", "warning_30_days", "defaulted_60_days", "restricted_90_days", "recovery_120_days"]`

Each status has specific transitions, conditions, and side effects documented in the workflow documentation.