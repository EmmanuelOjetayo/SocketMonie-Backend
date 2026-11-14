# SocketMonnie Loan Database Models and Relationships

## Overview

This document documents the actual database models and relevant fields based on the implemented codebase. All models use Mongoose schema definitions with Postgres as the underlying database.

---

## 1. Loan Model (`LoanModel`)

### Collection: `loans`

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Primary key |
| `loanNumber` | String | Unique loan identifier format: `LNP-YYYYMMDD-XXXXX` |
| `user` | ObjectId | Reference to borrower's User record |
| `principalAmount` | Number | Original loan principal |
| `interestAmount` | Number | Flat 2% upfront interest deducted once |
| `totalRepayable` | Number | Equals `principalAmount` (Model A invariant) |
| `disbursementAmount` | Number | `principalAmount - interestAmount` |
| `status` | String | One of: `waiting_guarantor`, `pending_review`, `active`, `warning_30_days`, `defaulted_60_days`, `restricted_90_days`, `recovery_120_days`, `completed` |
| `createdAt` | Date | Application timestamp |
| `updatedAt` | Date | Last update timestamp |

### Financial Invariants (Enforced)

- `totalRepayable = principalAmount` — total borrower repayment obligation equals original principal
- `disbursementAmount = principalAmount - interestAmount`
- `interestAmount = principalAmount × 0.02` (flat 2% upfront)
- `disbursementAmount = principalAmount - interestAmount`

### Disbursement Fields (Manual Confirmation)

| Field | Type | Description |
|-------|------|-------------|
| `payoutStatus` | String | `manual`, `completed`, `pending`, `failed` |
| `payoutReference` | String | `MANUAL_${loanNumber}_${timestamp}` — manual confirmation reference |
| `payoutRef` | String | Manual reference for ledger trace |
| `payoutInitiatedAt` | Date | When payout was initiated (null for manual) |
| `payoutFailedAt` | Date | When payout failed (null if not failed) |
| `payoutFailureReason` | String | Reason if payout failed |
| `payoutProviderResponse` | Object | `{ mode: "manual", confirmedBy, confirmedAt }` |
| `disbursementBankDetails` | Object | Snapshot from borrower's profile `{ bankCode, bankName, accountNumber, accountName }` |
| `approvedBy` | ObjectId | Admin who approved |
| `approvedAt` | Date | Approval timestamp |
| `reviewedAt` | Date | Manual disbursement confirmation timestamp |
| `disbursedBy` | ObjectId | Admin who confirmed disbursement |
| `disbursedAt` | Date | Manual disbursement completion timestamp |

### Guarantor Management

| Field | Type | Description |
|-------|------|-------------|
| `guarantors` | Array | Embedded documents `[{ userId, fullName, referralCode, status, acceptedAt, isReplaced, replacedBy, replacementReason, guaranteedBalance, remainingGuaranteedBalance }]` |
| `allGuarantorsAccepted` | Boolean | Whether all 4 guarantors have accepted |
| `recoveryStatus` | String | `not_in_recovery`, `in_recovery` |

### Repayment Schedule

| Field | Type | Description |
|-------|------|-------------|
| `installments` | Array | `[{ installmentNumber, dueDate, amountDue, amountPaid, status }]` |
| `amountPaid` | Number | Total amount paid across all installments |
| `remainingBalance` | Number | Outstanding balance (`totalRepayable - amountPaid`) |

### Interest Snapshot

| Field | Type | Description |
|-------|------|-------------|
| `interestSnapshot` | Object | `{ rate, amount, ruleName, ruleVersion, calculatedAt }` |
| `eligibilitySnapshot` | Object | `{ netSavings, maxLoanAmount, tier, isEmergency }` |

### Overpayment Refunds

| Field | Type | Description |
|-------|------|-------------|
| `overpaymentRefunds` | Array | `[{ amount, status: "pending_review"|"approved"|"rejected", reference, transactionId, recordedAt }]` |

### Example Document

```json
{
  "_id": "loan_id",
  "loanNumber": "LNP-20240115-00001",
  "user": "user_123",
  "principalAmount": 100000,
  "interestAmount": 2000,
  "totalRepayable": 100000,
  "disbursementAmount": 98000,
  "status": "active",
  "guarantors": [
    { "userId": "g1", "fullName": "G1", "status": "active", "remainingGuaranteedBalance": 100000 },
    { "userId": "g2", "fullName": "G2", "status": "active", "remainingGuaranteedBalance": 100000 },
    { "userId": "g3", "fullName": "G3", "status": "active", "remainingGuaranteedBalance": 100000 },
    { "userId": "g4", "fullName": "G4", "status": "active", "remainingGuaranteedBalance": 100000 }
  ],
  "installments": [
    { "installmentNumber": 1, "dueDate": "...", "amountDue": 33333, "amountPaid": 0, "status": "unpaid" },
    { "installmentNumber": 2, "dueDate": "...", "amountDue": 33333, "amountPaid": 0, "status": "unpaid" },
    { "installmentNumber": 3, "dueDate": "...", "amountDue": 33334, "amountPaid": 0, "status": "unpaid" }
  ],
  "amountPaid": 0,
  "remainingBalance": 100000,
  "payoutStatus": "completed",
  "payoutReference": "MANUAL_LNP-20240115-00001_1705305600000",
  "payoutRef": "MANUAL_LNP-20240115-00001_1705305600000",
  "payoutProviderResponse": { "mode": "manual", "confirmedBy": "admin_1", "confirmedAt": "2024-01-15T14:00:00Z" },
  "disbursementBankDetails": { "bankCode": "058", "bankName": "Access Bank", "accountNumber": "1234567890", "accountName": "Borrower Name" },
  "approvedBy": "admin_1",
  "approvedAt": "2024-01-15T10:30:00Z",
  "reviewedAt": "2024-01-15T14:00:00Z",
  "disbursedBy": "admin_1",
  "disbursedAt": "2024-01-15T14:00:00Z",
  "recoveryStatus": "not_in_recovery"
}
```

---

## 2. Recovery Obligation Model (`RecoveryObligationModel`)

### Collection: `recovery_obligations`

### Purpose

Tracks guarantor recovery obligations when a loan enters `defaulted_60_days` status. Infrastructure tracking only; no automatic deductions executed without authorized collection mechanism.

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Primary key |
| `loan` | ObjectId | Reference to the associated Loan record |
| `guarantor` | ObjectId | Reference to the Guarantor record |
| `totalAssignedRecovery` | Number | Share amount assigned to this guarantor (typically 25% of applicable obligation) |
| `remainingRecoveryBalance` | Number | Outstanding amount still to recover (starts at `totalAssignedRecovery`) |
| `amountRecovered` | Number | Actual amount recovered so far (starts at 0) |
| `monthlyRecoveryAmount` | Number | Current cycle share amount |
| `deductionExecutionStatus` | String | `"not_enabled"` — no actual deductions executed; attempt tracked infrastructure-only |
| `currentCycleObligation` | Number | Total obligation for current cycle (overdue + current-month installments) |
| `currentCycleShare` | Number | Guarantor's share of current cycle obligation |
| `currentCycleOverdueAmount` | Number | Portion of current cycle representing overdue installments |
| `currentCycleCurrentMonthAmount` | Number | Portion of current cycle representing current-month installment outstanding |
| `deductions` | Array | `[{ amount, status, paidAt, attemptedAt, reference, providerReference, installmentNumber, failureReason, recordedAt }]` |
| `lastCalculatedAt` | Date | When obligation was last recalculated |
| `createdAt` | Date | When obligation was first created |

### Example Document

```json
{
  "_id": "obligation_id",
  "loan": "loan_id",
  "guarantor": "g1_user_id",
  "totalAssignedRecovery": 10000,
  "remainingRecoveryBalance": 10000,
  "amountRecovered": 0,
  "monthlyRecoveryAmount": 10000,
  "deductionExecutionStatus": "not_enabled",
  "currentCycleObligation": 12000,
  "currentCycleShare": 3000,
  "currentCycleOverdueAmount": 8000,
  "currentCycleCurrentMonthAmount": 4000,
  "deductions": [],
  "lastCalculatedAt": "2024-03-15T10:00:00Z",
  "createdAt": "2024-03-15T10:00:00Z"
}
```

---

## 3. User Model (`UserModel`)

### Collection: `users`

### Purpose

Member profiles with banking, savings, and profile dependencies for loan disbursement.

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Primary key |
| `fullName` | String | Member's full name |
| `email` | String | Unique email address |
| `phone` | String | Phone number (Nigeria format) |
| `password` | String | Hashed password |
| `role` | String | `member`, `super_admin`, `finance_manager` |
| `tier` | String | Membership tier affecting borrowing limits |
| `netSavings` | Number | Current net savings balance |
| `monthsCount` | Number | Months of consistent savings history |
| `bankDetails` | Object | `{ bankCode, bankName, accountNumber, accountName }` — **authoritative beneficiary source for manual disbursement** |
| `referralCode` | String | Unique referral code for new member acquisition |
| `referredBy` | ObjectId | Referring member (if any) |
| `referralCount` | Number | Number of successful referrals |
| `socketScore` | Number | Current SocketScore (updated across qualifying events) |
| `socketScoreHistory` | Array | `[{ event, oldScore, newScore, timestamp, reason }]` — audit trail |
| `status` | String | `active`, `restricted`, etc. |
| `isVerified` | Boolean | KYC verification status |
| `createdAt` | Date | Account creation timestamp |

### Example Document

```json
{
  "_id": "user_123",
  "fullName": "Borrower Name",
  "email": "borrower@example.com",
  "phone": "080512345678",
  "role": "member",
  "tier": "regular",
  "netSavings": 150000,
  "monthsCount": 12,
  "bankDetails": { "bankCode": "058", "bankName": "Access Bank", "accountNumber": "1234567890", "accountName": "Borrower Name" },
  "referralCode": "SM12345",
  "referredBy": null,
  "referralCount": 2,
  "socketScore": 850,
  "socketScoreHistory": [],
  "status": "active",
  "isVerified": true,
  "createdAt": "2023-06-01T08:00:00Z"
}
```

---

## 4. Guarantor Model (`GuarantorModel`)

### Collection: `guarantors`

### Purpose

Standalone guarantor records with full tracking fields, replacement history, and liability allocation.

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Primary key |
| `user` | ObjectId | Reference to User record |
| `fullName` | String | Guarantor's full name |
| `email` | String | Guarantor's email |
| `phone` | String | Guarantor's phone |
| `referralCode` | String | Unique referral code |
| `netSavings` | Number | Current net savings |
| `monthsCount` | Number | Months of consistent savings history |
| `minSavingsRequired` | Number | 25% of loan principal at time of guarantee |
| `status` | String | `pending`, `accepted`, `active`, `rejected`, `expired`, `released` |
| `acceptedAt` | Date | When guarantee was accepted (null if not accepted) |
| `guaranteedAmount` | Number | Loan principal amount guaranteed |
| `remainingGuaranteedBalance` | Number | Outstanding guaranteed balance |
| `isReplaced` | Boolean | Whether this guarantor was replaced on a loan |
| `replacedBy` | ObjectId | New guarantor who replaced this one (if applicable) |
| `replacementReason` | String | Reason for replacement |
| `replacementDate` | Date | When replacement occurred |
| `deductionExecutionStatus` | String | Collection execution status |
| `collectionAttempts` | Array | Tracked attempts (infrastructure-only without authorized mechanism) |
| `collectionHistory` | Array | `[{ amount, status, attemptedAt, reference, providerReference, failureReason }]` |
| `lastCalculatedAt` | Date | When liability was last calculated |
| `createdAt` | Date | When guarantor record was first created |

### Example Document

```json
{
  "_id": "g1_user_id",
  "user": "user_123",
  "fullName": "Guarantor 1",
  "email": "g1@example.com",
  "phone": "080598765432",
  "referralCode": "SM12345",
  "netSavings": 150000,
  "monthsCount": 12,
  "minSavingsRequired": 25000,
  "status": "active",
  "acceptedAt": "2024-01-15T10:30:00Z",
  "guaranteedAmount": 100000,
  "remainingGuaranteedBalance": 100000,
  "isReplaced": false,
  "replacementDate": null,
  "deductionExecutionStatus": "not_enabled",
  "collectionAttempts": [],
  "collectionHistory": [],
  "lastCalculatedAt": "2024-01-15T10:30:00Z",
  "createdAt": "2024-01-01T08:00:00Z"
}
```

---

## 5. Repayment Record (`RepaymentRecord` or `repaymentHistory`)

### Embedded in Loan Model or Separate Collection

### Purpose

Tracks individual repayment transactions against a loan.

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `paymentId` | ObjectId or String | Flutterwave transaction ID or reference |
| `reference` | String | Payment reference (e.g., `LRP_...`) |
| `amount` | Number | Amount paid |
| `currency` | String | `NGN` |
| `status` | String | `verified`, `failed`, `reversed` |
| `appliedToLoan` | Number | Amount applied to reduce loan balance |
| `excessAmount` | Number | Overpayment beyond remaining balance (if any) |
| `transactionId` | String | Flutterwave transaction ID |
| `transactionType` | String | `loan_repayment` |
| `recordedAt` | Date | When payment was recorded |
| `appliedAt` | Date | When applied to installment/loan |

### Example Entry

```json
{
  "paymentId": "pay_12345",
  "reference": "LRP_1705305600_abcd12_user123",
  "amount": 15000,
  "currency": "NGN",
  "status": "verified",
  "appliedToLoan": 15000,
  "excessAmount": 0,
  "transactionId": "FLW_tx_id_12345",
  "transactionType": "loan_repayment",
  "recordedAt": "2024-03-20T10:00:00Z",
  "appliedAt": "2024-03-20T10:00:00Z"
}
```

---

## 6. Financial Ledger Record (`LedgerEntry` or `financialLedger`)

### Collection: `financial_ledger` or embedded in Loan model

### Purpose

Audit trail of all financial events. Never silently discards excess; separate ledger entry for overpayment excess.

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `eventKey` | String | Unique identifier (e.g., `overpayment_excess:${paymentReference}`) — guards against duplicate processing |
| `activityType` | String | `outflow`, `inflow`, `reversal_adjustment`, `loan_principal_receivable`, `loan_interest_revenue` |
| `amount` | Number | Financial amount |
| `currency` | String | `NGN` |
| `reference` | String | Loan reference or payment reference |
| `relatedLoan` | ObjectId | Associated loan _id |
| `relatedGuarantor` | ObjectId | Associated guarantor _id (if applicable) |
| `description` | String | Human-readable description |
| `recordedAt` | Date | When ledger entry was created |
| `metadata` | Object | Additional context (e.g., `{ overpaymentType: "refund_review" }`) |

### Example Entry (Principal Disbursal)

```json
{
  "eventKey": "disbursal_manual:LNP-20240115-00001",
  "activityType": "outflow",
  "amount": 98000,
  "currency": "NGN",
  "reference": "LNP-20240115-00001",
  "relatedLoan": "loan_id",
  "description": "Manual disbursement of ₦98,000 to borrower",
  "recordedAt": "2024-01-15T14:00:00Z"
}
```

### Example Entry (Overpayment Excess)

```json
{
  "eventKey": "overpayment_excess:LRP_1705305600_abcd12_user123",
  "activityType": "reversal_adjustment",
  "amount": 2000,
  "currency": "NGN",
  "reference": "LRP_1705305600_abcd12_user123_EXCESS",
  "relatedLoan": "loan_id",
  "description": "Excess overpayment of ₦2,000 flagged for admin review — not revenue",
  "recordedAt": "2024-03-20T10:00:00Z"
}
```

---

## 7. SocketScore Record

### Field in User Model: `socketScore` (Number)

### History: `socketScoreHistory` (Array)

### Purpose

Member credit score updated across qualifying financial events. See `SOCKETSCORE.md` for complete formula and event mapping.

---

## 8. Indexes and Unique Constraints

### Loan Collection

| Index | Unique | Purpose |
|-------|--------|---------|
| `{ loanNumber: 1 }` | Yes | Enforce unique loan numbers |
| `{ user: 1, status: 1 }` | No | Index for borrower loan queries |
| `{ "guarantors.userId": 1 }` | No | Index for guarantor lookup |

### User Collection

| Index | Unique | Purpose |
|-------|--------|---------|
| `{ email: 1 }` | Yes | Unique email authentication |
| `{ referralCode: 1 }` | Yes | Unique referral codes |
| `{ socketScore: 1 }` | No | Score sorting/filtering |

### Recovery Obligation Collection

| Index | Unique | Purpose |
|-------|--------|---------|
| `{ loan: 1, guarantor: 1 }` | Yes | One obligation per loan/guarantor pair |

### Guarantor Collection

| Index | Unique | Purpose |
|-------|--------|---------|
| `{ referralCode: 1 }` | Yes | Unique guarantor referral codes |

---

## 9. Relationship Summary

```
User (1) --- (N) Loan
  |            |
  |            +--- guarantors (embedded in Loan)
  |            |
  +--- referralCode (unique)
  |
  +--- socketScore (updated across events)

Loan (1) --- (N) RecoveryObligation
  |            |
  |            +--- one per guarantor (4 max)
  |
  +--- installments (embedded array)
  +--- overpaymentRefunds (embedded array)
  +--- repaymentHistory (embedded array)

Guarantor (1) --- (1) RecoveryObligation
  (one obligation per guarantor per defaulted loan)
```

---

## 10. Data Integrity Rules

1. **Financial invariants enforced at schema level**: `totalRepayable = principalAmount`, `disbursementAmount = principalAmount - interestAmount`, `interestAmount = principalAmount × 0.02`
2. **Four guarantor requirement**: Loan cannot progress to `pending_review` unless all 4 guarantors have `status === "accepted"` and none are `isReplaced`
3. **Manual disbursement only**: No automated Flutterwave loan payout; admin must confirm manual transfer outside platform
4. **Overpayment handling**: Excess always recorded in `overpaymentRefunds[]` with `status: "pending_review"`; never silently discarded; separate ledger entry with `eventKey` guard
5. **Backend-authoritative calculations**: All financial values computed server-side; frontend never trusts frontend-submitted calculations
6. **Idempotent webhooks**: All webhook handlers use `eventKey` or reference-based deduplication to prevent duplicate processing
7. **Bank details source**: `User.bankDetails` is the authoritative beneficiary source for manual disbursement; no secondary independent source
8. **Recovery infrastructure gated**: Guarantor recovery tracking present but no automatic deductions without authorized collection mechanism and mandate consent