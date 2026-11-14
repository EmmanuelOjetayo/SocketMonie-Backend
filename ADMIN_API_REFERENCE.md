# Admin API Reference

**Date:** 2026-11-14  
**Basis:** Static inspection of frontend `Frontend/src/services/adminService.js` and backend `Backend/Routes/AdminRoutes.js`, `Backend/Controllers/AdminController.js`, `Backend/Services/AdminService.js`, `Backend/Middleware/AdminValidate.js`, plus `Backend/Routes/SystemSettingsRoutes.js` / `Backend/Controllers/SystemSettingsController.js` for audit logs and alternate settings endpoints. **Not live-verified in this environment.**

> All paths below are relative to the API base URL configured in the frontend API client (typically `/api`). Response shapes are described from code inspection and may vary in edge/error cases.

## Authentication & Authorization

- **Admin routes (`/admin/*`)**: `protect` + `requireRole("super_admin")` (see `Backend/Routes/AdminRoutes.js`).
- **Settings/audit routes (`/settings/*`)**: `protect` required; update settings restricted to `super_admin`; `GET /settings/audit-logs` allows `super_admin` and `finance_manager` (see `Backend/Routes/SystemSettingsRoutes.js`).

## Members & KYC

| Method | Path | Frontend caller | Request | Response (observed) | Notes |
|---|---|---|---|---|---|
| GET | `/admin/members` | `getMembers({status,search,page,limit})` | Query: `status?`, `search?`, `page`, `limit` | `{ success: true, members: [...], pagination: { total, page, limit, pages } }` | Search matches name/email/phone (backend regex). |
| GET | `/admin/members/:userId` | `getMemberById(memberId)` | Path: `userId` | `{ success: true, data: { member, stats, scoreHistory } }` (controller wraps service result) | Frontend also tolerates `res.data`/direct payload. |
| PATCH | `/admin/members/:userId/suspend` | `suspendMember(memberId, reason)` | Body: `{ reason? }` | `{ success: true, message, member }` (typical) | Reason optional in current route wiring. |
| PATCH | `/admin/members/:userId/activate` | `activateMember(memberId)` | — | `{ success: true, message, member }` (typical) | |
| PATCH | `/admin/members/:userId/kyc/approve` | `approveKYC(userId)` | — | `{ success: true, message, user }` (typical) | |
| PATCH | `/admin/members/:userId/kyc/reject` | `rejectKYC(userId, reason)` | Body: `{ reason }` (validated) | `{ success: true, message, user }` (typical) | `AdminValidate.validateReason` enforces reason. |

## Loans

| Method | Path | Frontend caller | Request | Response (observed) | Notes |
|---|---|---|---|---|---|
| GET | `/admin/loans` | `getLoans({status,page,limit})` | Query: `status?`, `page`, `limit` | `{ success: true, loans: [...], pagination: {...} }` | Populates user/guarantor fields (see AdminService). |
| GET | `/admin/loans/:loanId` | `getLoanById(loanId)` | Path: `loanId` | `{ success: true, data: loan }` (controller wraps) | Frontend normalizes nested shapes. |
| PATCH | `/admin/loans/:loanId/approve` | `approveLoan(loanId, notes?)` | Body: `{ notes? }` | Success payload/message per controller/service | Manual disbursement/activation semantics depend on backend business logic. |
| PATCH | `/admin/loans/:loanId/reject` | `rejectLoan(loanId, reason)` | Body: `{ reason }` (validated) | Success payload/message | Reason required. |

## Withdrawals

| Method | Path | Frontend caller | Request | Response (observed) | Notes |
|---|---|---|---|---|---|
| GET | `/admin/withdrawals/pending` | `getPendingWithdrawals({page,limit})` | Query: `page`, `limit` | Pending withdrawals list + pagination (frontend expects `data` and `pagination`) | Exact envelope should be confirmed at runtime. |
| POST | `/admin/withdrawals/:id/approve` | `approveWithdrawal(withdrawalId)` | Path: `id` | Success message/payload | Initiates payout/approval flow per backend. |
| POST | `/admin/withdrawals/:id/reject` | `rejectWithdrawal(withdrawalId, reason)` | Body: `{ reason }` (validated) | Success message/payload | Reason required. |

## Reports

| Method | Path | Frontend caller | Request | Response | Notes |
|---|---|---|---|---|---|
| GET | `/admin/reports` | `getAdminReports({type,month,year})` | Query: `type` (`overview` default), `month?`, `year?` | Report payload with `stats` and/or `data/reports` depending on type (frontend normalizes) | Overview and typed reports supported per AdminService logic. |
| GET | `/admin/reports/pdf` | `downloadReportPdf(params)` | Query: `type,month,year`; expects blob | **501** `{ success:false, message: "PDF export not yet implemented..." }` | **Not implemented** in backend. |
| GET | `/admin/reports/excel` | `downloadReportExcel(params)` | Query: `type,month,year`; expects blob | **501** `{ success:false, message: "Excel export not yet implemented..." }` | **Not implemented** in backend. |

## System Settings (Admin-scoped)

| Method | Path | Frontend caller | Request | Response (observed) | Notes |
|---|---|---|---|---|---|
| GET | `/admin/settings` | `getSystemSettings()` | — | `{ success: true, settings }` | Backed by `AdminService.getSettings()`. |
| PUT | `/admin/settings` | `updateSystemSettings(settings)` | Body: settings object (validated by `AdminValidate.validateSystemSettings`) | `{ success: true, message, changedFields, settings }` | Broadcast/audit behavior depends on service implementation. |

## SocketScore Configuration (Admin)

| Method | Path | Frontend caller | Request | Response | Notes |
|---|---|---|---|---|---|
| GET | `/admin/score/config` | direct `apiClient.get` in page | — | Active config (wrapped by controller/service) | Frontend reads `data`/direct payload. |
| GET | `/admin/score/config/history` | direct `apiClient.get` | — | Config version history | |
| PUT | `/admin/score/config` | direct `apiClient.put` | Body: `{ components: [...], changeNotes }` | Updated/new config version | Requires total weight validation per UI/business rules. |
| POST | `/admin/score/members/:userId/recalculate` | direct `apiClient.post` | Body: `{ year?, month?, force?, reason? }` | Recalculation result | Path params: `userId`. |
| POST | `/admin/score/members/:userId/finalize` | (route exists; UI not observed calling) | — | — | Exposed in routes; verify intended use. |

## Audit Logs (Settings route, consumed by Admin UI)

| Method | Path | Frontend caller | Request | Response (expected by UI) | Notes |
|---|---|---|---|---|---|
| GET | `/settings/audit-logs` | `getAuditLogs({action,targetType,actorId,page,limit})` | Query params as provided | UI expects logs in `data.data`/`data.logs`/`data` and pagination/meta in `meta`/`data.meta` | Implemented in `SystemSettingsController` under `SystemSettingsRoutes` with role `super_admin|finance_manager`. **Contract/shape should be verified against actual controller response.** |

## Alternate/Related Endpoints (not primary admin UI path)

| Method | Path | Notes |
|---|---|---|
| GET | `/settings` | Global settings for authenticated members (separate controller/model semantics possible). |
| PUT | `/settings` | Super-admin settings update with different validation schema than `/admin/settings`. |

## Known Gaps

- Report export (PDF/Excel) endpoints are **501**.
- Mixed response envelopes and dual settings surfaces require consolidation/verification.
- No live contract tests were executed in this pass; all shapes above are inspection-based.
