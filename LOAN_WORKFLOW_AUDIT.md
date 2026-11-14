# SocketMonnie Loan Workflow Audit — Progress Checklist

_Started: 2026-11-09. No commits/pushes/deployments unless explicitly instructed._

## Phase 1 — Map architecture
- [x] Frontend loan pages + API clients + auth deps
- [x] Backend routes/controllers/services/models + cron + score
- [x] Flutterwave webhooks/callbacks
- [x] Deliverable: architecture map + disconnected/duplicate findings

## Phase 2 — Member journey
- [x] W1–W12 traced (verified in code)
## Phase 3 — DB/financial integrity
- [x] Traced — see defect register
## Phase 4 — SocketScore/Savings/Notifications
- [x] Traced — see defect register
## Phase 5 — Frontend QA
- [x] Ledgered — see defect register
## Phase 6 — Security
- [x] Pre-check passed — see defect register

## Phase 7 — Defect register (P0–P3)
- [ ] D-### entries with reproduction/expected/actual/root cause/fix/verification

## Phase 8 — Fixes
- [ ] P0 → P1 → P2 → P3 (smallest complete corrections, regression tests)

## Phase 9 — E2E testing
- [ ] 30 controlled scenarios; suites; lint; build; console/log check

## Phase 10 — Final report
- [ ] A. User journey / B. Defect register / C. Financial integrity / D. Security / E. Files / F. Tests / G. Verdict
