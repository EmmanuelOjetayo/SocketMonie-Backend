# SocketMonnie Loan API Reference

## Base URL
All loan-related endpoints: `/api/loans/*`
Admin loan endpoints: `/api/admin/loans/*`
Guarantor endpoints: `/api/guarantor/*`
Payment endpoints: `/api/payments/*`

## Authentication
- JWT Bearer token via `Authorization: Bearer <token>` header
- Roles: `super_admin`, `finance_manager`, `member`
- Separation of duties: admin cannot approve own loan
- Guarantor cannot approve loan they are guaranteeing

---

## 1. Loan Application Endpoints

### POST /api/loans/apply
**Purpose**: Submit a new loan application with four guarantor referral codes

**Authentication**: Member only (must be authenticated member)

**Request Body**:
```json
{
  "amount": 100000,
  "durationMonths": 6,
  "loanType": "cooperative",
  "disbursementMethod": "bank_transfer",
  "purpose": "Business Expansion",
  "guarantorReferralCodes": ["SM12345", "SM67890", "SM11111", "SM22222"]
}
```

**Validation Rules**:
- `amount` > 0, number
- `durationMonths` in supported durations (3, 6, 12, 24)
- `loanType` from allowed types (cooperative, emergency)
- `disbursementMethod` from allowed methods (bank_transfer)
- `guarantorReferralCodes`: exactly 4 unique codes
- Each guarantor must exist (found by referral code)
- None can be the borrower themselves (`!guarantor._id.toString() === userId`)
- None can have active guarantee on another loan (`findActiveGuaranteeForGuarantor`)
- Each guarantor's net savings >= GUARANTOR_MIN_SAVINGS (₦70,000)
- Each guarantor's net savings >= 25% of loan principal (`gNetSavings >= requiredGuarantorSavings`)
- Each guarantor must have consistent savings history (5 of last 6 months >= ₦5,000)
- Borrower must have accepted T&C and Privacy Policy
- Requested amount must not exceed max borrowing limit

**Successful Response**:
```json
{
  "success": true,
  "message": "Loan application submitted. Awaiting all four guarantor approvals.",
  "loan": {
    "_id": "loan_id",
    "loanNumber": "LNP-YYYYMMDD-XXXXX",
    "principalAmount": 100000,
    "interestAmount": 2000,
    "totalRepayable": 100000,
    "disbursementAmount": 98000,
    "status": "waiting_guarantor",
    "guarantors": [
      { "userId": "g1", "fullName": "G1", "status": "pending" },
      { "userId": "g2", "fullName": "G2", "status": "pending" },
      { "userId": "g3", "fullName": "G3", "status": "pending" },
      { "userId": "g4", "fullName": "G4", "status": "pending" }
    ]
  }
}
```

**Error Responses**:
- 400: "Four different guarantor referral codes are required."
- 400: "You must save consistently for at least N months and maintain a minimum net savings of ₦X."
- 400: "Requested amount exceeds borrowing limit of ₦X."
- 400: "You cannot select yourself as a guarantor."
- 400: "Guarantor X is already serving as an active guarantor on another loan."
- 400: "Guarantor X does not meet the minimum savings requirement of ₦70,000."
- 400: "Guarantor X's savings (₦X) must be at least 25% of the loan amount (₦X)."
- 403: "You must accept the Socket Monie Terms and Conditions and Privacy Policy before applying for a loan."

---

### POST /api/loans/:loanId/cancel
**Purpose**: Withdraw/cancel a loan application awaiting guarantors

**Authentication**: Borrower only

**Request Body**: `{ "reason": "Withdrawn by applicant" }`

**Required Conditions**: Loan status must be `waiting_guarantor`

**Successful Response**:
```json
{
  "success": true,
  "message": "Loan application withdrawn successfully.",
  "loan": { ... withdrawn loan object }
}
```

**Error Responses**:
- 400: "Only a loan application that is still awaiting guarantors can be withdrawn."
- 403: "You are not authorized to cancel this loan application."

---

## 2. Guarantor Endpoints

### GET /api/guarantor/details/:token
**Purpose**: Retrieve guarantor request details and loan information

**Authentication**: Public (token-based, no auth required)

**Response**:
```json
{
  "id": "guarantor_request_id",
  "fullName": "Guarantor Name",
  "email": "guarantor@example.com",
  "phone": "0805xxxxxxx",
  "referralCode": "SM12345",
  "loan": { "loanNumber": "LNP-...", "principalAmount": 100000, "status": "waiting_guarantor" },
  "guaranteedAmount": 100000,
  "minSavingsRequired": 25000, // 25% of principal
  "status": "pending",
  "tokenExpiresAt": "2024-12-31T23:59:59.999Z",
  "expired": false
}
```

**Error Responses**:
- 404: "Guarantor request not found."
- `expired: true` if token past expiry

---

### POST /api/guarantor/respond
**Purpose**: Guarantor accepts or rejects a guarantee request

**Authentication**: The guarantor themselves (their userId must match the token's guarantorUserId)

**Request Body**:
```json
{
  "token": "verification_token_string",
  "decision": "accept",   // or "reject"
  // KYC data if accepting:
  "address": "Street Address",
  "occupation": "Business Name",
  "employerName": "Employer",
  "idType": "NIN/NUMBER",
  "idNumber": "12345678901",
  "idCardUrl": "https://...",
  "proofOfAddressUrl": "https://...",
  "signatureUrl": "https://...",
  "rejectionReason": "Guarantor declined"  // only if decision: "reject"
}
```

**Required Conditions**:
- Token must be valid and not expired
- Request status must be `pending`
- Loan status must be `waiting_guarantor`
- GuarantorUserId from token must match authenticated user's `_id`

**Successful Response (accept)**:
```json
{
  "message": "Guarantee accepted. All four guarantors have accepted the loan. It is now awaiting admin review.",
  "guarantorRequest": { ... },
  "loan": {
    "id": "loan_id",
    "loanNumber": "LNP-...",
    "status": "pending_review",
    "allGuarantorsAccepted": true
  }
}
```

**Successful Response (reject)**:
```json
{
  "message": "Guarantee rejected. The borrower has been notified to select a replacement guarantor.",
  "guarantorRequest": { ... },
  "loan": {
    "id": "loan_id",
    "loanNumber": "LNP-...",
    "status": "waiting_guarantor"
  }
}
```

**Error Responses**:
- 400: "Invalid decision. Must be 'accept' or 'reject'."
- 404: "Guarantor request not found."
- 403: "You are not authorized to respond to this guarantor request."
- 400: "This request has already been accepted/rejected."
- 400: "Guarantor request has expired."

---

### POST /api/loans/:loanId/replace-guarantor
**Purpose**: Replace a rejected/expired guarantor with a new eligible guarantor

**Authentication**: Borrower only

**Request Body**:
```json
{
  "oldGuarantorUserId": "guarantor_to_replace_id",
  "newGuarantorReferralCode": "SM99999",
  "reason": "Replaced after rejection"
}
```

**Required Conditions**:
- Loan status must be `waiting_guarantor`
- Old guarantor must have status `rejected` or `expired` (not `accepted`)
- New guarantor referral code must be valid and found
- New guarantor must not already be on this loan (as active or replaced)
- New guarantor must meet 25% minimum savings of loan principal
- New guarantor must have consistent savings history
- New guarantor must not have active guarantee on another loan

**Successful Response**:
```json
{
  "success": true,
  "message": "Replacement guarantor assigned successfully. Guarantee invitation sent.",
  "loan": { ... updated loan object with 5 guarantor entries (4 active + 1 replaced) }
}
```

**Error Responses**:
- 400: "Guarantor replacement is only allowed while the loan is waiting for guarantors."
- 404: "Active guarantor to replace was not found on this loan."
- 400: "You can only replace a guarantor whose request was rejected or expired."
- 400: "New guarantor with referral code X was not found."
- 400: "You cannot select yourself as a guarantor."
- 400: "X is already selected as a guarantor for this loan."
- 400: "X does not meet the minimum savings requirement of ₦70,000."
- 400: "X's savings must be at least 25% of the loan amount (₦X)."
- 400: "X has not maintained consistent monthly savings."
- 400: "X is already serving as an active guarantor on another loan."

---

## 3. Admin Loan Endpoints

### GET /api/admin/loans
**Purpose**: Admin list of loans with filtering and search

**Authentication**: `super_admin` or `finance_manager` only

**Query Parameters**:
- `status`: filter by loan status (optional)
- `page`: page number (default: 1)
- `limit`: items per page (default: 20)
- `search`: search by name, loan ID, email, or referral code (optional)

**Successful Response**:
```json
{
  "success": true,
  "loans": [ ... loan summary objects ... ],
  "pagination": { "total": 123, "page": 1, "limit": 20, "totalPages": 7 }
}
```

**Loan Summary Object**:
```json
{
  "_id": "loan_id",
  "loanNumber": "LNP-...",
  "user": { "fullName": "Borrower Name", "email": "borrower@email.com" },
  "principalAmount": 100000,
  "interestAmount": 2000,
  "totalRepayable": 100000,
  "status": "waiting_guarantor",
  "durationMonths": 6,
  "createdAt": "2024-01-15T10:30:00Z"
}
```

**Error Responses**: 403 for unauthorized roles

---

### GET /api/admin/loans/:loanId
**Purpose**: Get full loan details for admin review

**Authentication**: `super_admin` or `finance_manager` only

**Successful Response**:
```json
{
  "success": true,
  "loan": { ... complete loan object with all fields, guarantors, installments, bankDetails, financial snapshots ... }
}
```

**Error Responses**: 404 if loan not found

---

### POST /api/admin/loans/:loanId/approve
**Purpose**: Admin approves loan and confirms manual disbursement

**Authentication**: `super_admin` or `finance_manager` only

**Successful Response**:
```json
{
  "success": true,
  "message": "Loan approved and manual disbursement confirmed successfully. Repayment schedule is now active.",
  "loan": { ... loan object with status active, payoutStatus completed, installments generated ... }
}
```

**Error Responses**:
- 400: Various validation errors (not all guarantors accepted, financial inconsistencies, bank details missing, etc.)
- 403: "You cannot approve your own loan application." / "You cannot approve a loan in which you are a guarantor."

---

### POST /api/admin/loans/:loanId/reject
**Purpose**: Admin rejects a loan application

**Authentication**: `super_admin` or `finance_manager` only

**Request Body**: `{ "reason": "Insufficient savings to cover guarantor minimum ratio..." }`

**Successful Response**:
```json
{
  "success": true,
  "message": "Loan rejected successfully.",
  "loan": { ... loan object with status rejected, rejectionReason recorded ... }
}
```

**Error Responses**:
- 400: "Please enter a rejection reason."
- 404: "Loan not found."

---

## 4. Repayment Endpoints

### POST /api/loans/repay/initialize
**Purpose**: Initialize a loan repayment Flutterwave checkout

**Authentication**: Member only

**Request Body**:
```json
{
  "loanId": "loan_id",
  "paymentAmount": 15000
}
```

**Successful Response**:
```json
{
  "success": true,
  "data": {
    "publicKey": "FLWPUBK-xxx",
    "public_key": "FLWPUBK-xxx",
    "reference": "LRP_1702867200_abcd12_user123",
    "tx_ref": "LRP_1702867200_abcd12_user123",
    "txRef": "LRP_1702867200_abcd12_user123",
    "amount": 15000,
    "currency": "NGN",
    "customer": {
      "email": "member@example.com",
      "name": "Member Name",
      "phone_number": "080512345678"
    },
    "customizations": {
      "title": "SocketMonnie Loan Repayment",
      "description": "Repayment for Loan LNP-XXXXX"
    },
    "meta": {
      "paymentType": "loan_repayment",
      "loanId": "loan_id",
      "userId": "member_id"
    },
    "metadata": {
      "paymentType": "loan_repayment",
      "loanId": "loan_id",
      "userId": "member_id"
    },
    "redirect_url": "https://app.socketmonnie.com/loan/payment/callback",
    "subaccount_id": "RS_xxx" // optional, for split payment
  }
}
```

**Error Responses**:
- 404: "No payable loan found."
- 400: "Invalid repayment amount."
- 400: Loan not in payable status

---

### POST /api/loans/repay/verify
**Purpose**: Verify and settle a loan repayment (webhook/redirect handler)

**Authentication**: Member only (but verified via Flutterwave meta)

**Request Body**:
```json
{
  "loanId": "loan_id",
  "reference": "LRP_1702867200_abcd12_user123",
  "tx_ref": "LRP_1702867200_abcd12_user123",
  "transactionId": "FLW_tx_id",
  "transaction_id": "FLW_tx_id"
}
```

**Successful Response**:
```json
{
  "success": true,
  "message": "Loan repayment verified successfully.",
  "loan": { ... updated loan object }
}
```

**Error Responses**:
- 400: "loanId and reference are required."
- 400: "Unable to verify payment."
- 400: "Currency mismatch."
- 404: "Loan not found."
- 403: "This transaction does not belong to this loan." / "This transaction does not belong to your account."

---

### POST /api/loans/:loanId/trigger-defaulter-check
**Purpose**: Manually trigger the loan defaulter escalation cron

**Authentication**: `super_admin` or `finance_manager` only

**Successful Response**:
```json
{
  "success": true,
  "message": "Loan defaulter escalation process executed successfully.",
  "data": {
    "warningCount": 0,
    "defaultedCount": 0,
    "guarantorNotifiedCount": 0,
    "recoveryCount": 0
  }
}
```

**Error Responses**:
- 403: "Unauthorized. Only authorized finance staff can execute defaulter checks."

---

## 5. Guarantor Recovery Endpoints (Infrastructure)

### POST /api/loans/:loanId/initiate-recovery
**Purpose**: Initiate guarantor recovery tracking at default_60_days

**Authentication**: `super_admin` or `finance_manager` only

**Successful Response**:
```json
{
  "success": true,
  "obligations": [ ... recovery obligation records ... ],
  "message": "Guarantor recovery tracking initiated. Collection attempts require guarantor mandate consent and provider integration."
}
```

**Error Responses**:
- 404: "Loan not found."
- 400: "Guarantor recovery can only be initiated when loan is in defaulted_60_days state."

---

### POST /api/RecoveryObligations/:obligationId/attempt-collection
**Purpose**: Record a guarantor collection attempt (infrastructure tracking)

**Authentication**: `super_admin` or `finance_manager` only

**Request Body**:
```json
{
  "amount": 10000,
  "mandates": { "providerReference": "COLL_REF_123" }
}
```

**Successful Response**:
```json
{
  "status": "tracked_infrastructure_only",
  "message": "Collection attempt tracked at infrastructure level. Mandate/consent provider integration required for actual execution."
}
```

**Error Responses**:
- 404: "Recovery obligation not found."

---

### POST /api/RecoveryObligations/:obligationId/complete-collection
**Purpose**: Complete a guarantor collection (record actual recovered amount)

**Authentication**: `super_admin` or `finance_manager` only

**Request Body**:
```json
{
  "amount": 10000,
  "providerRef": "COLL_REF_123"
}
```

**Successful Response**:
```json
{
  "status": "completed",
  "obligation": { ... updated obligation record }
}
```

**Error Responses**:
- 404: "Recovery obligation not found."

---

### POST /api/loans/:loanId/process-borrower-repayment
**Purpose**: Process borrower repayment and recalculate guarantor obligations

**Authentication**: `super_admin` or `finance_manager` only

**Request Body**:
```json
{
  "loanId": "loan_id",
  "paymentAmount": 15000
}
```

**Successful Response**:
```json
{
  "loan": { ... updated loan object },
  "totalRecoveredFromGuarantors": 5000,
  "message": "Borrower repayment of ₦15000 processed. Guarantor recovery obligations recalculated and reduced accordingly."
}
```

**Error Responses**:
- 404: "Loan not found."

---

## 6. Payment/Flutterwave Endpoints

### POST /api/webhook
**Purpose**: Flutterwave webhook endpoint (signature-verified)

**Authentication**: Requires valid `FLW_SECRET_HASH` signature header

**Body**: Flutterwave event data

**Routing**:
- References starting with `DEP_` → `handleDepositWebhook`
- References starting with `WTH_` → `handleWithdrawalWebhook`
- References starting with `LNP_` → `handleLoanPayoutWebhook`
- References starting with `LRP_` or `RPL_` → `handleRepaymentWebhook`
- References starting with `MEM_` → `handleMembershipFeeWebhook`
- References starting with `MIN_` → `handleMinuteWebhook`

**Error Responses**: 401 for invalid signature, 400 for missing fields

---

### GET /api/payments/status/:reference
**Purpose**: Check payment status by reference

**Authentication**: Member or authorized admin

**Successful Response**: Payment receipt object with status, amount, method, transactionId, etc.

**Error Responses**: 404 "Transaction not found for this account."

---