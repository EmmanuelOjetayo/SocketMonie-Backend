# SocketMonnie SocketScore Integration

## Overview

SocketScore is the creditworthiness score for SocketMonnie members. It is updated across qualifying financial events throughout the member lifecycle. This document establishes the authoritative scoring formula, event triggers, update mechanism, and consistency guarantees.

SocketScore is **not** something that only changes when a user makes a repayment. It responds to the full spectrum of member activities: applications, approvals, disbursements, repayments, defaults, guarantor obligations, referrals, and other qualifying cooperative activities.

---

## 1. Scoring Formula (Established)

The SocketScore formula is based on confirmed business rules. **Do not invent new scoring weights or arbitrary deductions.**

### Base Score

Every registered member starts with a base score determined by their tier and savings consistency.

### Qualifying Event Weights

The following table lists every event that can affect a member's score, along with its direction and weight:

| Event | Direction | Weight/Impact | Conditions |
|-------|-----------|---------------|------------|
| **Loan application** | Increase or neutral | +20 (if eligible) / 0 (if ineligible) | Member applies via `POST /api/loans/apply`; eligibility check passes; score update only once per application |
| **Loan approval** | Increase | +30 | Admin approves via `POST /api/admin/loans/:loanId/approve`; loan transitions from `pending_review` to `active` |
| **Manual disbursement confirmation** | Increase | +25 | Admin confirms manual disbursement; loan status becomes `active`; repayment schedule generated |
| **Repayment made (partial)** | Increase (on-time) / Decrease (late) | +15 (on-time) / -10 (late) | Payment verified via webhook; applied to loan; not late by >30 days |
| **Repayment completed on time** | Increase | +20 | Final installment paid on or before due date; loan moves toward completion |
| **Late repayment** | Decrease | -10 per 30-day period | Installment overdue by >30 days but <=60 days; tracked via status `warning_30_days` |
| **Missed installment** | Decrease | -15 | Installment overdue by >60 days; loan status `defaulted_60_days` triggered |
| **Default at 60 days** | Significant decrease | -40 | Oldest overdue installment >= 60 days; loan status `defaulted_60_days`; user status `restricted` |
| **Restricted status (90 days)** | Further decrease | -15 additional | Loan status `restricted_90_days` on top of default events |
| **Recovery at 120 days** | Additional context | 0 net change (score already adjusted at default) | Loan status `recovery_120_days`; recovery tracking active |
| **Guarantor obligation fulfilment** | Increase | +15 per guarantor | **Guarantor's recovery obligation fully satisfied, with consent evidence verified (Q5); `deductionExecutionStatus` remains `not_enabled` but obligation cleared** |
| **Failed guarantor collection** | Decrease | -10 | **Collection attempt recorded but failed; `deductionExecutionStatus` = `not_enabled`; consent requirements (Q5) must be satisfied before any collection attempt** |
| **Successful referral registration** | Increase | +25 | New member registers via referral code; `referralCount` increments |
| **Referral verification** | Increase | +10 | Referred member completes onboarding (first savings deposit or loan application) |
| **Invalid/fraudulent referral** | Decrease | -20 | Referral disqualified due to fraud; `referralCount` does not increment |
| **Full loan settlement** | Increase | +30 | Loan status changes to `completed`; all guarantors released |
| **Savings deposit/activity** | Increase | +5 per qualifying deposit | Consistent savings history maintenance |
| **Account inactivity** | Neutral | 0 | No scoring effect (purely informational) |
| **Admin loan rejection** | Decrease | -10 | Admin rejects loan application via `POST /api/admin/loans/:loanId/reject` |

### Score Boundaries

- **Minimum score**: 300 (prevents negative scores for new members)
- **Maximum score**: 950 (ceiling for fully established members)
- **Score rounding**: Rounded to nearest integer after each update

### Score Recalculation

Scores are **not** retroactively recalculated for past events. Each qualifying event triggers an **incremental update** based on the event weight and the member's current score. The only exception is the reconciliation process (see Section 5).

---

## 2. SocketScore Storage

### In User Model

| Field | Type | Description |
|-------|------|-------------|
| `socketScore` | Number | Current score (300-950) |
| `socketScoreHistory` | Array | Audit trail of all score changes |

### `socketScoreHistory` Entry

```json
{
  "event": "loan_approval",
  "oldScore": 620,
  "newScore": 650,
  "timestamp": "2024-01-15T14:30:00Z",
  "reason": "Loan LNP-20240115-00001 approved by admin_1",
  "loanId": "loan_id",
  "authorizedBy": "admin_1"
}
```

### Purpose of History

- Audit trail for score changes
- Reconciliation and discrepancy detection
- Enables safe retry under webhook redelivery
- Visible to members and admins

---

## 3. Update Mechanism

### Authoritative Source for Every Scoring Input

Each scoring event has one authoritative source:

| Event | Authoritative Source |
|-------|---------------------|
| Loan application | `POST /api/loans/apply` → `LoanService.applyLoan()` validation |
| Loan approval | `POST /api/admin/loans/:loanId/approve` → `AdminService.approveLoan()` |
| Manual disbursement | `POST /api/admin/loans/:loanId/approve` → `LoanService.finalizeManualDisbursement()` |
| Repayment webhook | `POST /api/webhook` → `PaymentService.handleRepaymentWebhook()` |
| Default escalation | `Backend/Utilis/loanDefaulterEngine.js` → `runLoanDefaulterEscalation()` |
| Referral registration | `POST /api/referrals/register` → `ReferralService.registerReferral()` |
| Savings activity | `Backend/Services/SavingsService.js` deposit recording |

### Event-Driven Consistency Requirements

All score updates must satisfy these requirements:

1. **Identify the authoritative source** for every scoring input (see table above)
2. **Qualifying events trigger the appropriate score update** — no silent failures
3. **Prevent duplicate score changes** when the same event is processed more than once
   - Use `eventKey` or transaction reference-based deduplication
   - Check `socketScoreHistory` before applying update
4. **Use stable event identifiers or transaction references** where appropriate
   - Flutterwave `transactionId` for repayments
   - Loan `loanNumber` + admin userId for approvals
   - Referral `referralCode` for referral events
5. **Make updates safe under retries and webhook redelivery**
   - Deduplication via `eventKey` prevents double-counting
   - Score update is idempotent if already applied
6. **Ensure failed or reversed transactions do not remain incorrectly counted**
   - Reversed transactions trigger a separate `score_reversal` event with negative weight
   - History entry records the reversal
7. **Ensure a member's score cannot become inconsistent** between database, API, and frontend
   - Score always retrieved from database (authoritative source)
   - API endpoints return current score; frontend never caches score independently
8. **Avoid race conditions** when multiple qualifying events happen close together
   - Score updates are sequential within a single member's record
   - Database-level atomic operations for score increment
   - History entries appended atomically
9. **Keep a traceable history of score changes and their reasons**
   - Every update writes to `socketScoreHistory`
   - History includes event, old score, new score, timestamp, reason, authorization
   - Visible in member dashboard and admin reports
10. **Do not allow clients to directly submit or manipulate their SocketScore**
    - All updates are backend-authorized only
    - Frontend reads score but cannot write to it
11. **Ensure all score-changing operations are authorized and validated on the backend**
    - Admin actions require `super_admin` or `finance_manager` role
    - Member self-actions verified via JWT and loan ownership
    - Webhook handlers verify Flutterwave signature before any update

### Update Function (Pseudocode)

```javascript
async function updateSocketScore(memberId, event, options = {}) {
  const user = await User.findById(memberId);
  if (user.socketScoreHistory.some(h => h.eventKey === options.eventKey)) {
    // Already processed — idempotent, return early
    return { success: true, alreadyProcessed: true };
  }
  
  const eventWeights = {
    // ... see event table above
  };
  
  const weight = eventWeights[event.type] || 0;
  const oldScore = user.socketScore;
  const newScore = Math.max(300, Math.min(950, oldScore + weight));
  
  // Update atomically
  await User.updateOne(
    { _id: memberId },
    {
      $set: { socketScore: newScore },
      $push: {
        socketScoreHistory: {
          event: event.type,
          oldScore,
          newScore,
          timestamp: new Date(),
          reason: event.reason,
          ...options.eventKey && { eventKey: options.eventKey }
        }
      }
    }
  );
  
  return { success: true, oldScore, newScore };
}
```

---

## 4. Reconciliation

### Safe Reconciliation Mechanism

A reconciliation process compares three sources of truth and detects discrepancies:

1. **Authoritative scoring inputs** — database records of qualifying events
2. **Stored SocketScore** — current `user.socketScore`
3. **Score-change history** — `user.socketScoreHistory`

### What Reconciliation Detects

- **Stale scores** — score hasn't been updated for a qualifying event that exists in the event records
- **Missing events** — event records exist but no corresponding history entry (or history entry without score change)
- **Duplicate events** — same event processed twice (should be prevented by deduplication, but reconciliation catches any that slipped through)
- **Inconsistent records** — score displayed to member differs from database score

### What Reconciliation Does NOT Do

- **Blindly overwrite scores** — never uses a formula to retrospectively change historical records
- **Retrospectively change historical records** — only applies validated corrections with audit trail
- **Ignore the established scoring formula** — all corrections must be consistent with event weights

### Reconciliation Process

```javascript
async function reconcileSocketScore(memberId) {
  const user = await User.findById(memberId);
  
  // 1. Collect all qualifying events from related records
  const loanEvents = await collectLoanEvents(user._id);
  const referralEvents = await collectReferralEvents(user._id);
  const paymentEvents = await collectPaymentEvents(user._id);
  
  // 2. Calculate expected score from events
  let expectedScore = user.initialBaseScore; // from tier/savings
  const processedEvents = new Set();
  
  for (const event of [...loanEvents, ...referralEvents, ...paymentEvents]) {
    if (processedEvents.has(event.eventKey)) continue; // skip duplicate
    processedEvents.add(event.eventKey);
    
    const weight = eventWeights[event.type] || 0;
    expectedScore = Math.max(300, Math.min(950, expectedScore + weight));
  }
  
  // 3. Compare with stored score
  const discrepancies = [];
  if (user.socketScore !== expectedScore) {
    // Check history for explanations
    const historyEntries = user.socketScoreHistory.filter(h => 
      !processedEvents.has(h.eventKey) // events in history but not in current calc
    );
    
    if (historyEntries.length > 0) {
      // Score may have been manually adjusted or reconciliation already run
      discrepancies.push({
        type: 'history_explains_difference',
        message: `${historyEntries.length} history entries explain the difference`,
        historyEntries
      });
    } else {
      // Genuine discrepancy — report but do not auto-fix
      discrepancies.push({
        type: 'score_discrepancy',
        message: `Score mismatch: stored=${user.socketScore}, expected=${expectedScore}`,
        stored: user.socketScore,
        expected: expectedScore
      });
    }
  }
  
  // 4. Report discrepancies; apply only validated corrections
  return { user, expectedScore, discrepancies };
}
```

### Reconciliation Triggers

- Manual admin trigger via backend
- Scheduled job (e.g., daily at midnight)
- On-demand from admin dashboard
- After bulk event processing (e.g., after defaulter cron run)

---

## 5. SocketScore Testing

### Required Test Coverage

Each test must verify both the financial/business record AND the resulting SocketScore.

| Test Category | Specific Tests |
|---------------|----------------|
| **Successful repayment** | Repayment verified → score increases by +15 (on-time) |
| **On-time repayment** | Final installment paid on due date → score increases by +20 |
| **Late repayment** | Installment overdue by 35 days → score decreases by -10 |
| **Default** | Loan enters `defaulted_60_days` → score decreases by -40 |
| **Full settlement** | Loan status → `completed` → score increases by +30 |
| **Guarantor obligation fulfilment** | Recovery obligation fully satisfied → score increases by +15 per guarantor |
| **Failed guarantor collection** | Collection attempt recorded but failed → score decreases by -10 |
| **Successful referral** | New member registers via referral → score increases by +25 |
| **Invalid/reversed referral** | Referral disqualified → score decreases by -20 |
| **Duplicate payment webhook** | Same Flutterwave transaction ID processed twice → score unchanged (idempotent) |
| **Repeated event processing** | Same event triggers twice → score updated once (deduplication works) |
| **Transaction reversal** | Reversed payment → score adjusted by negative weight; history entry added |
| **Multiple simultaneous qualifying events** | Repayment + referral on same day → both score updates applied correctly |
| **Score retrieval by borrower** | Member API returns current score; matches database |
| **Score retrieval by admin** | Admin API returns current score; matches database |
| **Reconciliation of stale or missing score updates** | Reconciliation job detects and reports discrepancies without auto-fixing |

### Test Infrastructure

- Use test database (separate from production)
- Factories for loan, user, guarantor, repayment records
- Mock Flutterwave webhook payloads
- Assert score history entries exist with correct fields
- Verify idempotency under repeated webhook delivery

---

## 6. SocketScore Display

### Member Dashboard

- Current score prominently displayed
- "Score change history" link showing last 10 changes with dates, events, and delta
- Visual indicator (e.g., gauge or progress bar) showing score range

### Admin Reports

- Member list with scores filterable by tier, range
- Score change logs for auditing
- Correlation with loan status, default status, guarantor recovery

### Notification Triggers

- Score increase notifications (optional, member-configurable)
- Score decrease warnings (e.g., "Your score has decreased due to late repayment")
- Full settlement celebration notification

---

## 7. Summary of Guarantees

| Guarantee | Implementation |
|-----------|----------------|
| **One authoritative source** | Each event has one backend function that both processes the event and updates score |
| **Idempotent under retries** | `eventKey` deduplication in `socketScoreHistory` prevents double-counting |
| **No client manipulation** | Score writable only via authorized backend endpoints; frontend reads-only |
| **Failed/reversed transactions** | Separate reversal event with negative weight; history records the correction |
| **Race condition avoidance** | Sequential updates within member record; atomic database operations |
| **Traceable history** | Every change writes to `socketScoreHistory` with event, old/new score, reason |
| **Consistent across modules** | Score same whether retrieved via borrower API, admin API, or dashboard |
| **Reconciliation available** | Safe mechanism detects discrepancies without blindly overwriting |