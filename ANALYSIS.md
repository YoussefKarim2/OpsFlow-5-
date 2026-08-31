# OpsFlow — Existing System Analysis

Read-only inspection. **No files were modified.** This document answers the fourteen questions in
§34 of the spec and ends with the exact file list for Phase 1, pending your approval.

Codebase inspected: 18,477 lines across three workspace packages, 1,396-line Prisma schema,
75 API endpoints, 24 frontend routes.

---

## 1. Current architecture summary

An npm-workspaces monorepo with three packages and one hard rule that shapes everything else.

```
packages/shared/   @opsflow/shared — pure TypeScript, zero runtime dependencies.
                   Enums, DTOs, RBAC permission table, and the entire calculation
                   engine. Imported by BOTH the API and the web client.
packages/server/   Express 4 + Prisma 5 + PostgreSQL 16. REST under /api.
packages/web/      React 18 + Vite 5 + Tailwind 3 + TanStack Query 5 + Recharts.
```

**The rule: only facts are stored.** Status, progress %, shortages, alerts, projected completion
dates, costing — none of it is a column. All of it is computed at read time by `@opsflow/shared`,
which is why the API and the UI can never disagree about a number. `Order` carries three
`cached*` columns (`cachedProgressPct`, `cachedStatus`, `cachedStageKey`) used *only* for list
sorting; every read path recomputes the truth and ignores them.

Two consequences worth knowing before you change anything:

- Adding a "status" or "percent complete" column is almost always wrong here. The equivalent
  change is a new derivation in `packages/shared/src/calc/`.
- Every division goes through `safeDiv()`, which returns `null`, and every number reaches the
  screen through `<Num>`, which renders `null` as "Not calculated". Nothing renders `NaN`.

**Frontend ↔ backend.** `packages/web/src/lib/api.ts` is a single typed client — one `request()`
function that attaches the bearer token from `localStorage`, sets `X-Change-Reason` when a
privileged override needs a reason, and converts non-2xx responses into a typed `ApiError`
carrying the server's `code`. A 401 clears the token and redirects to `/login`. TanStack Query
wraps it and is configured **not** to retry 4xx, because a business-rule refusal will not succeed
on a second attempt and retrying hides the message.

**Error contract.** `packages/server/src/errors.ts` defines typed errors with stable codes
(`APPROVAL_REQUIRED`, `QUANTITY_RULE_VIOLATION`, `TASK_PREREQUISITE_UNMET`, `OVERRIDE_REQUIRED`).
One error handler in `app.ts` maps them to HTTP, and the human-readable message is passed
straight through to the UI verbatim. This is the mechanism new validation should reuse.

---

## 2. Current database structure

38 models, 22 enums, PostgreSQL via Prisma. Grouped:

| Group | Models |
|---|---|
| Identity | `Role`, `User` |
| Reference | `Client`, `Factory`, `RefColor`, `RefSize`, `RefValue` |
| Order core | `Order`, `OrderColor`, `OrderSize`, **`StageQuantity`**, `OrderNote` |
| Workflow | `OrderStage`, `TaskTemplate`, `Task`, `TaskComment` |
| Materials | `BomItem`, `MaterialIssue`, `StockRecord` |
| Cutting | `CuttingRecord`, `Marker`, `FabricRecord` |
| External | `ExternalOperation`, `Approval`, `CustomInstruction` |
| Production | `ProductionRecord` |
| Quality | `QualityAudit`, `QualityDefect` |
| Packing / shipping | `PackingList`, `Carton`, `Shipment` |
| Costing | `CostingRecord`, `CostLine` |
| Cross-cutting | `Attachment`, `ActivityLog`, `AuditTrail`, `Notification`, `ImportJob` |

The load-bearing one is **`StageQuantity`**: a single quantity ledger, one row per
`(order, colour, size, ledger)` with `ledger ∈ {ORDER, STOCK, CUT, IN_LINE, OUT_LINE, PACKED,
SHIPPED, SECOND_DEGREE}`, uniquely constrained. It replaces nine parallel colour×size grids.
Shortages are subtractions between ledgers, never stored.

Everything order-scoped carries `orderId` and cascades on delete, so an order is one unit.

**Status: no migration has ever been generated.** `packages/server/prisma/migrations/` does not
exist — the Prisma engine binaries could not be downloaded in the build sandbox, so
`prisma migrate` has never run. The first `npm run setup` on a real machine creates the initial
migration. Phase 1 will be the first migration this schema has ever seen.

---

## 3. Current authentication system

- `POST /api/auth/login` — argon2id verify, rate-limited to 10 attempts / 15 min. Performs the
  same work whether the email exists or not, so it does not confirm which emails are registered.
  Returns a JWT (`{sub, email}`, 12h) plus the user object.
- `GET /api/auth/me`, `POST /api/auth/change-password` (min 10 chars, requires current password).
- `authenticate` middleware verifies the token and then **re-loads role and permissions from the
  database on every request**. Permissions are deliberately not baked into the token, so a
  revocation takes effect immediately rather than in twelve hours. Inactive users are rejected.
- Token lives in `localStorage`; `AuthProvider` (`packages/web/src/lib/auth.tsx`) hydrates from
  `/auth/me` on mount.
- `requestContextMiddleware` puts the actor in `AsyncLocalStorage` so the audit middleware knows
  who made each change without threading an actor through every service signature.

Gaps: no refresh tokens (12h then re-login), no token revocation list, no login/logout entries in
the activity log, no lockout beyond the IP rate limit, no password-reset flow, no MFA.

---

## 4. Current user / permission system

RBAC by `resource:action` strings. Roles are **database rows, not an enum** — an admin can create
"Senior Coordinator" without a deploy. 36 permissions in
`packages/shared/src/permissions.ts`; 10 seeded roles: `ADMIN`, `COORDINATOR`, `FACTORY_MANAGER`,
`PRODUCTION_MANAGER`, `WAREHOUSE`, `QUALITY`, `EXTERNAL_OPS`, `PACKING`, `FOLLOW_UP`, `FINANCE`.
`Role.permissions` is a `String[]`; `User.department` is a separate enum used for task routing and
notification targeting.

Enforcement is server-side: `requirePermission('order:edit')` / `requireAnyPermission(...)` on
each route. The frontend does not currently hide nav items by permission, so a coordinator sees
menu entries that return 403 when used — cosmetic, not a security hole.

**What already matches the new spec:** coordinators genuinely cannot create users or change roles
(`user:manage` and `role:manage` are ADMIN-only), and self-elevation is impossible because
permissions come from the DB role on every request, never from the client.

**What does not:**

- No Super Admin tier. `ADMIN` is a plain role; there is no allowlist restricting who may hold it,
  and nothing stops one admin from creating another.
- `POST /api/users` is the *only* user-management endpoint. No disable, enable, reset password, or
  change role.
- `GET /api/users` is gated on `order:read` — i.e. every authenticated user can list every account
  with email and last-login time. **This is the one real security finding in the current code.**
- No user-management UI at all. `SettingsPage` renders a read-only table.

---

## 5. Current order system

`Order` is genuinely the central object: PO number (unique), name, season, style, fit, block
pattern, up to three fabrics, shipping method, unit price, cut and accessory percentages, five
date fields, external reference and work type, snapshotted shipping/billing addresses, priority,
cancellation, client, factory, external factory, coordinator, outside-work manager.

Endpoints: list (paginated + filtered), search, get, create, patch, matrix get/put,
generate-cut, tasks, activity, audit-trail, attachments.

The **Order Workspace** (`packages/web/src/pages/OrderWorkspace.tsx`) is a 15-tab workspace —
Overview, Order Details, Quantity, Workflow, Cutting & Marker, BOM, External Ops, Approvals,
Production, Quality, Packing, Shipping, Costing, Documents, Activity — with a header carrying
status, health, priority, progress and a stage timeline. Tab badges show live counts (overdue
tasks, short BOM lines, pending approvals).

Order list filters: client, coordinator, season, status, stage, factory, shipping method,
priority. Global search matches PO, order name, style, client, coordinator, factory and external
reference.

**Gap: there is no "New Order" UI.** `api.orders.create` exists and is never called from the
frontend. Today an order enters the system only through the Excel import or a direct API call.

---

## 6. Current production system

Strong — this is the deepest part of the app.

`ProductionRecord` = `{date, operation, qty, line, team, notes, recordedById}` with
`operation ∈ {CUTTING, SEWING, PRINTING, EMBROIDERY, WASHING, FINISHING, PACKING}`. **Full history
is kept; totals are summed from records.** Nothing is a manually-entered percentage.

`computeProductionAnalytics()` in `packages/shared/src/calc/production.ts` derives: produced,
remaining, produced %, trailing 7-day daily rate, peak daily rate, **required daily rate to hit
the date**, days to complete, **projected completion date**, days until required, **slip days**,
`isBehindSchedule`, and a per-day cumulative series for the chart. Sewing is the throughput
constraint and is what counts as "produced"; cutting lives in its own ledger so it is not
double-counted.

On write, `POST /api/production/:orderId` validates the quantity, refuses an implausible sewing
total against order and cut quantities, logs the activity, and — the good bit — **notifies the
coordinator and managers at the exact moment the order crosses into behind-schedule**, rather
than at the next review.

Missing vs. the new spec: no production **targets** model (so no achievement %), and no
factory-wide production dashboard page. The main dashboard has a 14-day sewing trend; the
per-stage totals, daily target vs. actual, and by-order breakdown do not exist yet.

---

## 7. Current quality system

`QualityAudit` — inspection date, factory, audit type (`FINAL_AUDIT`, `BEFORE_IRON`,
`BEFORE_PACKING`, `IN_PACKING`, `INLINE`), available qty, sample size, accepted, rejected,
result (`PENDING`/`PASS`/`FAIL`), `overridden`, remarks, corrective action + closed flag,
re-inspection links, auditor, colours and sizes inspected.

`QualityDefect` — category + qty + comment + `isReinspection`. Categories:
`COLOR_COMBINATION`, `FABRIC_DEFECT`, `CONSTRUCTION_STITCHING`, `TRIMMING`, `PRINT_EMBROIDERY`,
`CLEANLINESS`, `PACKING`, `MEASUREMENTS`.

The AQL sampling table is encoded in `@opsflow/shared`; sample size defaults from it and the
verdict is computed, with manual overrides recorded rather than silent. A FAIL auto-creates a
corrective-action task and blocks the order until the action is closed.

Against your §19 list, the mapping is: Stitching → `CONSTRUCTION_STITCHING`, Fabric →
`FABRIC_DEFECT`, Size → `MEASUREMENTS`, Color → `COLOR_COMBINATION`, Packaging → `PACKING`.
Printing and Embroidery are currently **one** category, and there is no `OTHER`. Defect *rate* is
computed per audit but not aggregated per order.

---

## 8. Current packing system

`PackingList` (reference, coordinator approval + approver + timestamp) → `Carton` (number, size,
colour, size, qty, gross/net weight). Endpoints: list, create, add carton, approve.
`PackingTab.tsx` (407 lines) covers packing and shipping in one tab.

Missing vs. §20: carton **dimensions**, and per-carton destination. Packed quantity flows through
the `PACKED` ledger, so totals and remaining already work.

**Shipping** (§21) is better than expected: `Shipment` already has method, status
(`NOT_READY`→`READY`→`BOOKED`→`SHIPPED`→`DELIVERED`), qty, promised/required/actual/delivered
dates, tracking number, carrier, AWB, container seal, vessel/voyage, final destination, and an
admin `overrideApproved` + reason for shipping more than was produced. The UI is thin, not the
model.

---

## 9. Current document / file system

A proper storage abstraction exists: `StorageDriver` interface (`put`/`get`/`delete`/`exists`/
`url`) with `LocalDiskDriver` working and `S3Driver` a **typed stub — five unimplemented
methods**. `Attachment.storageKey` is deliberately driver-agnostic, never a filesystem path, so
swapping drivers is a config change and not a migration. `DocumentType` has 15 values including
`CUSTOMER_PO`, `TECH_PACK`, `ARTWORK`, `PACKING_LIST`, `QUALITY_REPORT`, `INVOICE`,
`SHIPPING_DOC`. Attachments can hang off an order, stage, task, approval, external op, quality
audit, shipment or custom instruction.

**But there is no upload endpoint for attachments.** The only routes are
`GET /api/orders/:orderId/attachments` (list) and `GET /api/files/:key` (stream). No POST, no
DELETE, no upload widget. Multer is installed and used, but only by the Excel importer. So
§15 is roughly 60% built: model, storage layer, list UI and download all exist; the actual
upload does not.

Also: `GET /api/files/:key` authenticates the user but does **not** check that the user may see
that particular attachment's order. Worth closing.

---

## 10. Current frontend page structure

```
/login                 LoginPage
/                      DashboardPage        — cards, attention list, my tasks, trend, activity
/orders                OrdersPage           — filters, search, sortable table
/orders/:id            OrderWorkspacePage   — the 15 tabs above
/my-tasks              MyTasksPage
/follow-up             FollowUpPage         — every open action in the factory, ranked
/notifications         NotificationsPage
/production /materials /external /quality /packing /shipping /costing
                       ModuleListPage       — the same order book, filtered per department
/clients /factories    read-only tables
/reports               ReportsPage          — 9 report kinds
/import                ImportPage           — Excel upload → preview → commit
/settings              SettingsPage         — read-only account + user table
```

Design system: Tailwind with an `ink`/`accent` palette, `.input` / `.th` / `.td` / `.label`
utility classes in `index.css`, and a shared component library in `components/ui.tsx` —
`Num`, `FreeText` (sets `dir="rtl"` from content, for the Arabic workflow text), `StatusBadge`,
`HealthBadge`, `PriorityBadge`, `SeverityDot`, `StageDot`, `ProgressBar`, `Card`, `CardHeader`,
`StatTile`, `EmptyState`, `Spinner`, `ErrorNote`, `Modal`, `Field`, `TabStrip`, `Avatar`,
`useDebounced`. **Reuse these.** Notably absent and needed for the new work: a confirm dialog and
a toast/success notification.

---

## 11. What already exists from the new requirements

| Spec § | Requirement | State |
|---|---|---|
| 2 | Backend authorization, no frontend-only gating | ✅ done properly |
| 2 | Coordinators cannot create users / self-elevate | ✅ already impossible |
| 6 | Order workspace as source of truth | ✅ 15 tabs |
| 7 | Production stages, date/user/qty/notes | ✅ 7 operations |
| 8 | Full production history, totals from records | ✅ |
| 11 | Automatic delay detection | ✅ required rate, projection, slip days |
| 12 | Orders at risk | ⚠️ exists as "requiring attention" + health, not a named page |
| 13 | Main dashboard | ✅ mostly |
| 14 | Order timeline | ✅ `ActivityLog` + Activity tab |
| 16 | Comments | ⚠️ **tasks only**, not orders |
| 18 | Notifications | ⚠️ stored, listed, read; no mentions, no transport |
| 19 | Quality tracking | ✅ deeper than asked (AQL, corrective actions) |
| 20 | Packing | ⚠️ no dimensions/destination |
| 21 | Shipping | ✅ model complete, UI thin |
| 27 | Audit log | ⚠️ updates only, per-order only, no admin viewer |
| 28 | Hashing, JWT, route protection, validation | ✅ argon2id, Zod on every write |
| 29/30 | Search + filters | ✅ global search, 8 order filters |
| 31 | Data validation | ✅ `services/rules.ts` — typed, enforced, human messages |
| 4/5 | PO upload → review → confirm | ⚠️ **Excel only**, one layout profile |

---

## 12. What is missing

Ordered by how much work each is.

1. **Super Admin tier** — the role, the three-email allowlist, and the guard preventing anyone
   else from managing users. (§2)
2. **User management** — disable, enable, reset password, change role; the admin UI; confirmation
   dialogs. (§3)
3. **PDF PO extraction** — no PDF parsing at all. The importer is `.xlsx`/`.xlsm` only, and its
   one profile (`age-order-v1`) locates fields by anchor text for *that* workbook shape. §4's
   "handle different PO layouts, do not assume every customer uses the same format" is a
   genuinely new subsystem: PDF text extraction, table detection, and a layout-agnostic field
   resolver. **This is the largest single item in the spec.** (§4)
4. **Attachment upload/delete** — endpoints and widget. (§15)
5. **Order-level comments + @mentions + mention notifications.** (§16, §17)
6. **Production targets** and the achievement calculation. (§10)
7. **Factory-wide production dashboard** — today's production, by stage, by order, targets vs.
   actual. (§9)
8. **Daily production report.** (§24)
9. **Admin audit-log viewer**, plus extending the audit middleware to creates and deletes and
   logging login events. (§27)
10. **"What needs my attention?"** personalised per user — the pieces exist in Follow-Up but are
    not user-scoped or on the homepage. (§25)
11. **Admin dashboard** — coordinator activity, efficiency, rejection rates. (§26)
12. **Client portal groundwork** — a `CLIENT` role, client-scoped auth, and DTO filtering so
    internal comments/costs/notes never leave the building. (§22)
13. **AI assistant.** (§23)
14. Smaller: New Order form, defect categories (split print/embroidery, add Other), carton
    dimensions/destination, filters by production/quality/packing/shipment status, `S3Driver`.

Plus three security items found during inspection, all cheap to fix:

- `GET /api/users` readable by every authenticated user → move behind `user:manage`.
- `GET /api/files/:key` does not verify the caller may see that attachment's order.
- Upload validation is by file extension only; no MIME/magic-byte check, and no explicit
  dangerous-type denylist.

---

## 13. Recommended implementation order

Your phase plan is sound. Two changes I'd argue for:

**Phase 1 — Users, permissions, audit** (as you have it). It gates everything else, and it is the
phase most likely to need a schema migration, which is best done before other work is in flight.

**Phase 2 — split in two.** Do **2a: attachment upload + document management** first (§15). It is
small, it unblocks storing the original PO with the order, and §5 explicitly requires that. Then
**2b: PO extraction** (§4/§5), which is the big one. Suggested shape: keep the existing
`ImportJob` → preview → commit pipeline exactly as it is and add extractors behind it — a PDF
extractor and a generic-Excel extractor alongside the current profile-based one — so the review
screen you already have serves all three. Field resolution becomes a scoring problem (label
synonyms, proximity, type plausibility) rather than a per-customer profile.

**Phases 3–6** as written. **Phase 7 (AI) and 8 (client portal)** last, and both are much safer
once the permission model from Phase 1 is in place — the AI assistant must query through the same
authorization layer as a human user, not around it.

One sequencing note: production targets (§10) should land in Phase 4 *before* the production
dashboard (§9), since achievement % depends on them.

---

## 14. Exact files for Phase 1

### Architectural decisions I want to confirm first

**A. Super Admin = database flag, seeded and permitted by an env allowlist.**
`SUPER_ADMIN_EMAILS` in `.env` (the two CEO addresses now, the third added later without a
deploy) determines who *may* be granted the flag; `User.isSuperAdmin` in the database is what the
API actually enforces. Env alone would break if someone edits the DB; a DB flag alone would let
any admin mint another super admin. Together: an account can only become super admin if its email
is on the allowlist *and* an existing super admin grants it.

**B. Keep the ten existing roles; add `SUPER_ADMIN` as an eleventh.** Your spec describes two
roles, but the app already routes tasks, notifications and permissions through ten, and
collapsing them would delete working functionality (your rule 8). "Coordinator" in your spec maps
to the existing `COORDINATOR` role unchanged. The other eight remain available for the factory
floor.

**C. Extend the existing audit middleware rather than adding logging calls to routes.** It
currently fires on `update` only; I'd add `create` and `delete` for `User` and `Role`. A route
that forgets to log leaves a permanent hole, which is exactly why it was built as middleware.

**D. Nav gating is cosmetic, permissions are enforced server-side.** I'll add permission-aware nav
so coordinators stop seeing buttons that 403, but every new admin route is gated with a
`requireSuperAdmin` middleware independently of what the UI shows.

### Files to create

```
packages/server/src/routes/admin.ts              user management + audit-log endpoints
packages/server/src/services/user-service.ts     create/disable/enable/reset/role-change + guards
packages/web/src/pages/admin/UsersPage.tsx       the management table and dialogs
packages/web/src/pages/admin/AuditLogPage.tsx    filterable audit viewer
packages/server/prisma/migrations/…              first migration (auto-generated)
```

### Files to modify

```
packages/shared/src/permissions.ts        + SUPER_ADMIN role, + user:create, user:disable,
                                            user:reset-password, role:assign, audit:read,
                                            settings:manage
packages/server/prisma/schema.prisma      User: + isSuperAdmin, disabledAt, disabledById,
                                            mustChangePassword, failedLoginCount, lockedUntil
packages/server/src/config.ts             + SUPER_ADMIN_EMAILS
packages/server/src/middleware/auth.ts    + requireSuperAdmin; reject disabled accounts by name
packages/server/src/middleware/audit-middleware.ts   audit create/delete for User and Role
packages/server/src/routes/auth.ts        log LOGIN / LOGIN_FAILED; honour mustChangePassword
packages/server/src/routes/reference.ts   move POST /users into admin.ts; put GET /users behind
                                            user:manage  ← security fix
packages/server/src/app.ts                mount adminRouter
packages/server/prisma/seed.ts            seed SUPER_ADMIN role + the two CEO accounts
packages/web/src/lib/api.ts               + api.admin namespace
packages/web/src/lib/auth.tsx             + can(permission) helper
packages/web/src/App.tsx                  /admin/users, /admin/audit routes
packages/web/src/components/AppShell.tsx  permission-aware nav + Administration group
packages/web/src/components/ui.tsx        + ConfirmDialog, + Toast
packages/web/src/pages/Misc.tsx           SettingsPage: link to the new admin area
.env.example                              + SUPER_ADMIN_EMAILS (no real secrets committed)
```

### Verification for Phase 1

`npm run build -w @opsflow/shared` → `prisma migrate dev` → `npm run db:seed` → `npm test`
(44 engine tests must stay green) → `npm run typecheck` across all three packages →
`npm run build -w @opsflow/web` → manual API checks that a coordinator token gets 403 on every
`/api/admin/*` route and that a disabled user's existing token stops working on the next request.

**One caveat, stated plainly:** because Prisma's engine binaries could not be downloaded in the
build sandbox, no migration has ever been generated and the seed has never run end to end. Phase 1
includes the first real `prisma migrate dev`. If it surfaces a schema problem, that is where it
will appear — and it is better to find it now, in the phase that is already touching the schema.

---

**Awaiting your approval before implementing Phase 1.**
