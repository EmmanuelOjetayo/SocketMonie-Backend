# Admin Dashboard Documentation

**Date:** 2026-11-14  
**Status:** Implementation/audit documentation based on repository inspection and partial stabilization work. Runtime behavior, live API contracts, and visual parity must be validated in a running environment.

## 1. Architecture Overview

The Admin Dashboard is a role-protected area of the SocketMonnie React (Vite) frontend that communicates with the Node/Express backend through a centralized API client. Admin functionality is primarily exposed under `/api/admin/*` (super-admin protected), with audit logs currently consumed from `/api/settings/audit-logs`.

### Key layers
- **Routing/guards:** `Frontend/src/routes/index.jsx` mounts admin pages under `/admin` inside `AdminLayout`, protected by `ProtectedRoute` with `ROLES.SUPER_ADMIN`.
- **Layout/shell:** `Frontend/src/layouts/AdminLayout.jsx` + `Frontend/src/components/navigation/AdminBottomNav.jsx` (mobile-first shell). `AdminSidebar.jsx` exists as a reusable desktop sidebar primitive but is not yet integrated.
- **Pages:** `Frontend/src/pages/admin/*` implement admin workflows (overview, members/KYC, loans, reports, withdrawals, score config, audit trail, settings).
- **Shared UI/primitives:** `Frontend/src/components/admin/*` (`AdminPageHeader`, `AdminStatCard`, `AdminStatusBadge`), common `components/ui/*` and `components/feedback/*`, and `TopHeader` for branded headers.
- **Data access:** `Frontend/src/services/adminService.js` wraps admin endpoints via `apiClient`; some pages (e.g. score config) call `apiClient` directly.
- **Backend:** `Backend/Routes/AdminRoutes.js` -> `Controllers/AdminController.js` -> `Services/AdminService.js` -> `Repositories/AdminRepository.js` (+ validators/middleware/models). Audit logs and an alternate settings surface live under `SystemSettingsRoutes`/`SystemSettingsController`.

## 2. Admin Routes (Frontend)

| Path | Page component | Purpose |
|---|---|---|
| `/admin` | `Dashboard` | High-level cooperative metrics overview |
| `/admin/members` | `AdminMembers` | Member directory, search/filter, detail drawer, KYC review, suspend/activate |
| `/admin/loans` | `AdminLoans` | Loan queue/detail/review and approve-reject actions |
| `/admin/reports` | `AdminReports` | Report/stat views by type/date with export actions (PDF/Excel currently unavailable on backend) |
| `/admin/withdraws` | `WithdrawalApprovals` | Pending withdrawal review/approval/rejection |
| `/admin/score-config` | `SocketScoreConfig` | SocketScore component weights/versioning and member recalculation |
| `/admin/audit` | `AdminAuditTrail` | Administrative/financial audit log browsing |
| `/admin/settings` | `AdminSettings` | System configuration (loan tiers/rates/eligibility/fees/referral settings) |

Source of truth for paths: `Frontend/src/constants/routes.js` and `Frontend/src/routes/index.jsx`.

## 3. Page Responsibilities

- **Dashboard:** Fetches overview report stats and renders summary metric cards/hero. Needs consistent admin states/header treatment and verified stat mapping.
- **Members:** Lists/searches/filters members; opens detail drawer with profile, balances, KYC docs/actions, and score breakdown/history; supports suspend/activate and KYC approve/reject with feedback/refetch.
- **Loans:** Lists and inspects loan applications, displays applicant/guarantor/repayment context, and supports approve/reject flows (complex UI; requires full contract and workflow QA).
- **Reports:** Loads report datasets/stats by type/month/year; provides export controls (backend export endpoints currently 501).
- **Withdrawal Approvals:** Lists pending withdrawals with pagination and supports approve/reject (confirmation + reason capture).
- **SocketScore Config:** Views/edits scoring component weights (versioned), displays history, and triggers audited member recalculation.
- **Audit Trail:** Filters and paginates audit events from settings audit-log endpoint.
- **Settings:** Loads and updates system settings including loan/interest/eligibility/fees/referral reward configuration.

## 4. Component Structure & Shared Design System

### Admin-specific primitives
- `AdminPageHeader`: standardized title/subtitle/eyebrow/actions block (underused; recommended for consistency).
- `AdminStatCard`: admin metric card aligned to member card language.
- `AdminStatusBadge`: maps domain statuses via shared badge conventions.

### Shared/member-aligned building blocks to reuse
- Layout/header: `TopHeader` (brand/page variants), consistent page containers and spacing.
- UI: `Card`, `Button`, `Input`, `Badge`, `Modal`/`BottomSheet`, `Table` patterns where applicable.
- Feedback: `LoadingState`, `EmptyState`, `ConfirmDialog`, skeletons/spinners, toast notifications.
- Utilities: `cn`, formatters (`formatNaira`, `formatDate`, `getScoreRating`), hooks (`useAsync`).

### Design guidance (target state)
- Reuse member dashboard tokens/colors/typography/radii/shadows and component interaction states.
- Use one admin shell pattern (desktop sidebar + responsive mobile navigation), consistent page max-width/padding, and shared header/section/card/table styles.
- Avoid ad-hoc inline styling and duplicated hero/header implementations except where content requires admin-specific density.

## 5. API Integration Architecture

- **Client:** Centralized `apiClient` (`Frontend/src/services/apiClient.js`) should be the only transport for admin pages/services.
- **Service layer:** `adminService.js` groups member/KYC/loan/withdrawal/report/settings/audit calls and normalizes params; score-config page currently issues direct `apiClient` calls (candidate for consolidation).
- **Response normalization:** Several pages defensively handle multiple envelopes (`data`, `data.data`, `members/loans/logs`, pagination/meta variants). Long-term fix is to standardize backend envelopes and simplify frontend consumers together.
- **Known integration points:** report exports expect binary blobs but backend returns 501 JSON; audit logs are served from `/settings/audit-logs` (not `/admin/*`) with role/shape considerations.

See `ADMIN_API_REFERENCE.md` for endpoint inventory and contract notes.

## 6. Authentication and Authorization

- **Frontend:** Admin routes require authenticated `super_admin` via `ProtectedRoute`. Session/auth handling is shared with member app flows and must not be regressed.
- **Backend:** `/api/admin/*` enforces `protect` + `requireRole("super_admin")`. `/api/settings/audit-logs` permits `super_admin` and `finance_manager`; `/api/settings` update is super-admin only. Privileged actions must remain server-enforced regardless of UI state.

## 7. Admin Workflows (current/expected)

- **Members/KYC:** browse/search/filter -> inspect details -> approve/reject KYC with reason -> suspend/activate -> refetch and reflect persisted state.
- **Loans:** review queue/detail (eligibility, guarantors, repayment context) -> approve (including manual disbursement confirmation semantics where applicable) or reject with reason -> persist and refresh.
- **Withdrawals:** review pending requests -> approve payout or reject with reason -> persist and refresh.
- **Reports:** select type/period -> view stats/ledger -> export PDF/Excel when backend support is available.
- **Score config:** review active config/history -> adjust weights/notes -> save versioned config -> run audited member recalculation.
- **Audit trail:** filter by action/target -> paginate/review immutable log entries.
- **Settings:** load/update cooperative configuration values with validation and admin feedback.

> Each workflow requires end-to-end verification (UI action -> API -> DB mutation -> response -> UI update) in a live environment.

## 8. Important Dependencies

- **Frontend:** React, React Router, Vite, Tailwind/CSS utilities, `react-hot-toast`, `lucide-react`, shared app hooks/components/services, formatting utilities.
- **Backend:** Express routes/controllers/services/repositories, Mongoose models, auth/role/validation middleware, audit/notification/ledger/score/loan domain services.
- No new dependencies were added during this stabilization pass.

## 9. Environment Configuration Requirements

- Frontend API base URL must target the correct backend environment (`VITE_API_BASE_URL` / apiClient config). Local tracked env values may differ from production; configure deployment env appropriately.
- Admin actions depend on authenticated admin sessions/tokens/cookies as implemented by the shared auth system.
- Report exports, audit logs, and score operations require corresponding backend endpoints and permissions to be available.
- Render SPA deployments require rewrite `/* -> /index.html` (frontend routing concern; see `Frontend/README.md`).

## 10. Error-Handling Conventions

- **Target convention:** use `LoadingState`/skeletons during fetch, `EmptyState` for no data, inline/banner errors for load failures, and toast notifications for mutation success/failure with backend-provided messages when available.
- **Current state:** mixed; improved in touched admin pages (Members/Reports/Withdrawals) but not fully standardized across all admin screens.
- **Backend-aware UX:** when an endpoint is unavailable/not implemented (e.g. report exports 501), surface a truthful, actionable error instead of implying success.
- **Safety:** never fabricate data, never assume success without confirmed API response/persisted state, and preserve backend-enforced authorization/business rules.

## 11. Known Gaps / Follow-up

- Integrate desktop admin sidebar and finalize responsive shell/navigation.
- Complete member-dashboard-aligned redesign for all admin pages and shared primitives.
- Resolve report export implementation gap and settings/audit contract consolidation.
- Perform full runtime QA, accessibility/responsiveness verification, and member-dashboard regression testing.
- Clean remaining mojibake/encoding artifacts and remove genuinely unused admin code after reference checks.
