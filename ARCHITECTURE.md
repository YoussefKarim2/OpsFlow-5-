# OpsFlow — Architecture & Design Decisions

**Garment Order Control Centre** — replaces the `PO No. 85 – A302059B Florida T Shirt Summer 2026.xlsx` workbook
and every workbook like it with one relational system.

Version 0.1 · Target order: **PO A302059B / Florida T shirt / ProTime / Summer 26**

---

## 1. What the Excel actually is

Before designing anything I read all 17 sheets, both values and formulas. The workbook is not a
document — it is an **undeclared application**. Three findings drove the entire design:

### Finding 1 — `Progress Status` is a workflow engine written in Arabic

Rows 8–34 are a 27-row responsibility matrix. Each row is `(tab, role, estimated duration, required data, sequence)`.
This is not documentation; it is the process definition. It is the single most valuable sheet in the file
and it is the thing an HTML mockup would have thrown away.

| Seq | Stage | Role (Arabic) | Role | Est. | Required work |
|----|-------|---------------|------|------|---------------|
| 1 | Customer Order Ref | مدير المصنع | Factory Manager | 5m | Attach the customer order image sent by the CEO after approval |
| 1 | Order Details | مدير المصنع | Factory Manager | 10m | Assign the coordinator, add core order details/instructions and unit price |
| 1 | Main Order | مدير المصنع | Factory Manager | 10m | Add sizes and quantities |
| 1 | Custom Instructions | مدير المصنع | Factory Manager | 10m | Add shirt numbering or special instructions if any |
| 2 | Customer Order Ref | منسق الأوردر | Coordinator | 5m | Review the order |
| 2 | Main Order | منسق الأوردر | Coordinator | 10m | Review the order |
| 2 | Order Details | منسق الأوردر | Coordinator | 10m | Set the cut %, confirm shipping address, record customer comments |
| 2 | Stock | منسق الأوردر | Coordinator | 10m | Record finished-goods stock, if any |
| 2 | Cut Order | منسق الأوردر | Coordinator | 5m | Verify order detail after stock deduction |
| 3 | Laying Fabric Instructions | قسم القص والماركر | Cutting & Marker | 35m | Set cut ratios and real consumption per marker |
| 3 | Bill Of Material | قسم القص والماركر | Cutting & Marker | 20m | Add real fabric consumption for warehouse issue |
| 3 | Bill Of Material | منسق الأوردر | Coordinator | 30m | Add accessories, specs, quantities; raise POs for shortfalls |
| 4 | Order Details | التشغيل الخارجي | External Ops | 15m | Add external work instructions, reference, external prices |
| 4 | Laying Fabric Instructions | قسم القص والماركر | Cutting & Marker | 35m | Produce the real markers per spread/cut instructions |
| 5 | External Order | التشغيل الخارجي | External Ops | 15m | Verify and send the print/embroidery order |
| 5 | Custom Instructions | التشغيل الخارجي | External Ops | 20m | Extract special details and send with the external order |
| 6 | External Order | منسق الأوردر | Coordinator | 15m | Verify order detail |
| 7 | Bill Of Material | المخزن | Warehouse | 30m | Record issues, set issuer/receiver, reserve accessories |
| 8 | Follow Up | مسئول المتابعة | Follow-up Officer | 35m | Enter daily order detail |
| 8 | Production Follow Up | مدير الإنتاج | Production Manager | 5m | Daily production entry |
| 9 | Follow Up | منسق الأوردر | Coordinator | 20m | Track status; escalate any deviation to the factory manager |
| 10 | Packing | قسم التعبئة | Packing | 35m | Build the packing list |
| 11 | Packing | منسق الأوردر | Coordinator | 15m | Review the packing list |
| 12 | Audit | مدير الجودة | Quality Manager | 10m | Final inspection |
| 13 | Actual Costing | المخزن | Warehouse | 20m | Record materials actually issued and their prices |
| 13 | Actual Costing | منسق الأوردر | Coordinator | 10m | Record production days |
| 14 | Progress Status | جميع القائمين | All participants | 2m | Log the time each task was performed |

**Decision:** these 27 rows are seeded as `TaskTemplate` records. Every new order materialises them into
real `Task` rows with owners and due dates. Progress is *never* a typed-in percentage — it is
`completed tasks / total tasks`, weighted by stage. The sequence column becomes the dependency graph:
a stage's tasks unblock when all lower-sequence tasks in its dependency set are done.

### Finding 2 — `Follow up` is nine parallel color × size matrices

Sheet 12 is 146 columns wide. It is the same 11-size × 4-colour grid repeated nine times:

```
Main Order → Cut → Control (In Line) → Shortage(Cut−InLine)
           → Control (Out Line) → Shortage(InLine−OutLine)
           → Packing → Shortage(Packing−MainOrder) → Second Degree
```

Three of those nine are pure arithmetic on the others. A naive port creates nine tables.

**Decision — the single most important schema call in this project:** one table.

```prisma
model StageQuantity {
  orderId  String
  colorId  String
  sizeId   String
  ledger   QtyLedger   // ORDER | STOCK | CUT | IN_LINE | OUT_LINE | PACKED | SHIPPED | SECOND_DEGREE
  qty      Int
  @@unique([orderId, colorId, sizeId, ledger])
}
```

Shortages are **derived, never stored**. A stored shortage is a shortage that can disagree with its inputs.
Every "Shortage" block in the Excel becomes a subtraction in `packages/shared/src/calc/quantities.ts`.
Question 10–15 from the brief ("what qty was cut / produced / passed / packed / shipped") is then a
single indexed query, not fifteen.

### Finding 3 — the formulas are the business rules

Extracted and reimplemented exactly:

| Excel | Location | Rule |
|---|---|---|
| `ROUNDUP((MainOrder − Stock) × (1 + cutPct))` | `Cut Order!D21` | Cut qty per cell. Verified: 20→21, 50→53, 138→145, 141→149 at 5%. |
| `=K17-I17` | `BOM!L17` | Shortage = issued − required (negative = short) |
| `=SUM(D23:R23)` / `=SUM(D23:D45)` | `Main Order` | Row/column/grand totals |
| `=D22/D14` | `Costing!D17` | Work days = machine-days used ÷ machine count |
| `=J12/D17` | `Costing!D18` | Productivity rate = cut qty ÷ work days |
| `=N37/L11` | `Costing!D24` | Unit cost = total cost ÷ shipped qty → **`#DIV/0!` in the live file** |
| `=IF(D26<=0, D24*1.2, "Perfect")` | `Costing!D28` | Target price when unprofitable |
| `=D17*D13` | `Costing!N36` | CM cost = work days × daily cost |
| `ROUNDUP(defects >= rejectCount)` | `Audit!C11:L16` | AQL verdict from the sampling table |

The workbook currently displays `#VALUE!` on four sheets and `#DIV/0!` on five costing cells. That is the
strongest argument for this project: **the file is already lying to the coordinator.** Hence the hard rule
in `calc/num.ts` — every division goes through `safeDiv()` which returns `null`, and every UI number goes
through a formatter that renders `null` as "Not calculated". `NaN` and `Infinity` cannot reach a screen.

### Finding 3b — the one formula that is NOT a formula

`Laying!X` ("Total / Length") looks like `layers × markerLength`. It is not:

| Lay | layers × marker | Sheet column X |
|----|-----------------|----------------|
| 1 | 140 × 2.61 = 365.4 | **391** |
| 2 | 177 × 2.41 = 426.6 | **457** |
| 3 | 44 × 4.15 = 182.6 | **196** |
| 4 | 30 × 3.20 = 96.0 | **103** |
| 5 | 12 × 2.40 = 28.8 | **31** |
| 6 | 5 × 2.90 = 14.5 | **16** |
| | **1,113.9** | **1,194** |

The gap is a consistent ~7% — end loss and splice allowance on every lay. Deriving this column instead of
storing it would under-state the order's fabric requirement by **80 metres**, which is how a cutting floor
runs out mid-lay. So `Marker.totalLengthM` is stored as a fact, `layers × markerLength` is computed
alongside it, and `allowancePct` reports the difference on screen rather than burying it.

This is the counterexample to the "derive everything" rule, and it is worth stating explicitly: derive what
is arithmetic, store what is measured. A number that looks like a product is not necessarily one.

---

## 2. Architecture

```
opsflow/
├── packages/shared/   @opsflow/shared — pure TypeScript. Zero dependencies.
│                      Enums, DTO types, and the whole calculation engine.
├── packages/server/   Express + Prisma + PostgreSQL. REST API, RBAC, business rules.
└── packages/web/      React 18 + TypeScript + Vite + Tailwind + TanStack Query.
```

**Decision: a shared calculation package, not calculations in the API.**
The dashboard recomputes progress and alerts on every render; the API recomputes them for every list
query. If those two implementations drift, the coordinator sees 68% on the list and 72% on the order —
which is precisely the class of bug the Excel has today. One implementation, imported by both. It is
pure, dependency-free and unit-tested against the real workbook values.

**Decision: derived state is computed, not stored.**
`Order.status`, `Order.progressPct`, `Order.currentStage`, every shortage, every alert. Only *facts* are
stored (a task completed, 450 pcs sewn, 500 poly bags issued). Storing derived state means every write
path must remember to update it, and one that forgets creates a permanently wrong order. The cost is
computation; the benefit is that the order cannot be internally inconsistent. If profiling later demands
it, the escape hatch is a materialised `order_rollup` table refreshed by the same pure functions.

**Decision: REST over GraphQL.** The consumer is one first-party client with a fixed screen set, and the
team maintaining this is coming from Excel. REST with typed DTOs is the lower-ceremony choice.

**Decision: storage abstraction from day one.** `StorageDriver` interface with a `LocalDiskDriver`
shipped and an `S3Driver` stub. `Attachment` rows store a driver-agnostic key, never a path.

---

## 3. Data model (30 entities)

**Identity & reference:** `User`, `Role`, `Permission`, `Client`, `Factory`, `RefColor`, `RefSize`,
`RefFabric`, `RefItemType`, `RefPosition`, `RefUnit`, `RefExternalWorkType` — the last seven seeded from
the workbook's `Data-Base` sheet, which is already a reference-data table (95 fabrics, 90 colours,
30 item types, 24 external work types, 37 positions). It maps to lookup tables with no transformation.

**Order core:** `Order` → `OrderColor`, `OrderSize` (junctions defining the matrix axes) → `StageQuantity`
(the ledger). `OrderNote` holds the five free-text blocks (general, spread, cut, packing, external) that
sheets 1–10 copy between each other by formula. In the workbook the coordinator's spread note is
referenced by three sheets; here it is one row read by three screens.

**Workflow:** `WorkflowStage` (17 per order, from the brief's stage list) → `Task` (materialised from
`TaskTemplate`) → `TaskComment`. `Task.blockedByTaskId` carries the sequence dependency.

**Materials:** `BomItem` (category/position/consumption/required/issued, shortage derived),
`MaterialIssue` (issuer, receiver, qty, date — the warehouse's row 25 duty), `StockRecord`.
A302059B carries 23 BOM lines and every one of them has the `Material issued` column blank in the live
file, so the seeded order opens with a total material shortage. That is not a contrivance for the demo —
it is the order's real state.

**Cutting & fabric:** `CuttingRecord`, `Marker`, `LayRow` — `LayRow` models
`Laying!C15:AC20` exactly: fabric, colour, panel, size-ratio string `(YXS1),(YS1),(YM1),(YL1),(M1)`,
per-size output, layers, marker length, total length, nest, efficiency %. The `(+/-)` variance row
(`Laying!G39`) is derived: lay output − cut requirement, which for this order is `−6` overall
(lay produces 2090, cut needs 2084) with per-size drift of −2 on 2YXS and +1 on YXS.

**External:** `ExternalOperation` + `Approval`. The Arabic note in `External Order!M15` reads
*"برجاء عدم البدء ف طباعه الاوردر الا بعد موافقه العميل"* — do not start printing before customer approval.
In Excel that is a sentence nobody is bound by. Here it is `ExternalOperation.requiresApproval`, enforced
server-side: the `START` transition throws `ApprovalRequiredError` if no `Approval` with
`status = APPROVED` exists. **This is the difference between a spreadsheet and a system.**

**Production:** `ProductionRecord` (date, operation, line, team, qty) — the workbook's four-column
`ITEM/DAY/DATE/QTY` grid, widened. Rate, remaining, and ETA are derived.

**Quality:** `QualityAudit` + `QualityDefect`, modelling the R02 report including its AQL sampling table
(`Audit!C11:L16` — 16–25→sample 5 accept 0/1, … 1200–3200→sample 125 accept 7/8). A `FAIL` verdict
auto-creates a corrective-action `Task` and sets the order to blocked.

**Packing & shipping:** `PackingList` → `Carton`; `Shipment`.

**Costing:** `CostingRecord` + `CostLine`, with `dollarRate` (48.5 in the file) since accessory prices are
quoted in EGP and divided by the rate — `=1/$D$12`, `=0.4/$D$12` etc.

**Cross-cutting:** `Attachment`, `Notification`, `ActivityLog`, `AuditTrail`. `AuditTrail` stores
`(entity, entityId, field, oldValue, newValue, userId, at)` — written by a Prisma middleware, not by
each route, so no future endpoint can forget to log.

---

## 4. RBAC

Permissions are `resource:action` strings checked by `requirePermission()` middleware. Roles are rows,
not an enum, so an admin can create "Senior Coordinator" without a deploy.

| | Admin | Coordinator | Factory Mgr | Prod Mgr | Warehouse | Quality | External Ops | Packing |
|---|---|---|---|---|---|---|---|---|
| order:create | ✓ | ✓ | ✓ | | | | | |
| order:edit | ✓ | ✓ | ✓ | | | | | |
| task:assign | ✓ | ✓ | ✓ | | | | | |
| production:write | ✓ | | ✓ | ✓ | | | | |
| material:issue | ✓ | | | | ✓ | | | |
| quality:audit | ✓ | | | | | ✓ | | |
| external:write | ✓ | | | | | | ✓ | |
| packing:write | ✓ | ✓ | | | | | | ✓ |
| costing:read | ✓ | ✓ | ✓ | | | | | |
| costing:write | ✓ | ✓ | | | ✓ | | | |
| shipment:override | ✓ | | | | | | | |

`shipment:override` exists for one rule: shipped qty may not exceed produced qty **unless an admin
overrides**, per the brief. The override is recorded in `AuditTrail` with a mandatory reason.

---

## 5. Derived status

`deriveOrderStatus()` in `calc/progress.ts`, evaluated top-down — first match wins:

1. `CANCELLED` if flagged
2. `QUALITY_BLOCKED` if any audit `FAIL` has an open corrective action
3. `SHIPPED` / `COMPLETED` from shipment state
4. `READY_TO_SHIP` when packed ≥ produced and packing approved
5. `PACKING` when packed > 0
6. `QUALITY_CHECK` when produced ≥ order qty and no audit passed
7. `PRODUCTION_DELAYED` when `projectedCompletion > requiredDeliveryDate`
8. `IN_PRODUCTION` when produced > 0
9. `READY_FOR_PRODUCTION` when materials issued and approvals cleared
10. `WAITING_APPROVAL` when a blocking approval is pending
11. `DRAFT`

The delay test at step 7 is the one that matters. `projectedCompletion = today + ceil(remaining / rate)`
where `rate` is the 7-day trailing average from `ProductionRecord`. Comparing it to
`requiredDeliveryDate` is how the coordinator learns about a slip in August instead of September.

---

## 6. Alert engine

`evaluateAlerts(order)` returns typed alerts, `CRITICAL | WARNING | ATTENTION`, each with a
`nextAction` and a deep link. The dashboard, the order overview and the Follow-Up centre all render
the same array — one implementation, three surfaces. Rules: order overdue, task overdue, production
behind schedule, material shortage, approval pending, external op late, quality fail, packing
incomplete, ship date approaching (≤7d), delivery date approaching.

For A302059B today the engine returns four alerts: `CRITICAL` customer print approval outstanding,
`CRITICAL` external printing blocked behind it, `CRITICAL` material shortage on all 23 BOM lines
(including 2,084 poly bags and 1,194 m of Rosetta), and `WARNING` four overdue tasks.

Two details in that list are deliberate. The print order covers four colours; grouping them by operation
type turns what would be four identical alerts into one line that says "4 operations affected". And the
`nextAction` on each alert exists because "there is a problem" is not actionable — the coordinator needs
"chase the customer for print artwork approval".

The **Next Action** panel picks the outstanding task with the lowest *process sequence*, and a blocked
stage outranks everything. Ordering by the stage's display position instead would answer "what's next?"
with "log your time" — Progress Status sits fourth on the sidebar but its single task is sequence 14.

---

## 7. Excel import

Not a one-shot parser — a five-step pipeline, because the brief is right that real files are messy.

1. **Upload** → temp storage, `ImportJob` row
2. **Detect** — fingerprint sheet names against known profiles. The 17 sheets here match the
   `age-order-v1` profile at 100%; unknown files fall through to manual mapping.
3. **Extract** — a profile is a declarative anchor map, not hard-coded cell refs:
   `{ field: 'poNumber', sheet: 'Order Details_Coordinator', anchor: 'Po No', offset: [0, 1] }`.
   Anchor-relative addressing survives inserted rows, which hard-coded `D7` does not.
4. **Validate** — required fields, date sanity, non-negative quantities, matrix totals reconciling
   against the sheet's own `SUM` results. Errors block; warnings do not.
5. **Preview → Commit** — a diff table, then one Prisma transaction creating the order and every
   related record. All-or-nothing.

The matrix reader deserves a note: it locates the header row by finding a cell equal to `"Color"`,
reads size labels rightward until blank, then reads down until a row whose first cell is `"Totals"`.
That is how it handles the 20 empty spare rows the workbook keeps between the data and the totals.

---

## 8. What was deliberately not copied

- **The navigation column.** Every sheet carries an identical 18-row `HYPERLINK` menu in column A.
  That is a sidebar, and it is now a sidebar.
- **Formula-mirrored headers.** Twelve sheets restate PO/date/client/style via `='Order Details'!D7`.
  That is a join. Header data lives on `Order` and is read once.
- **The `Data-Base` sheet as a sheet.** It is reference data and becomes lookup tables.
- **Empty spare rows.** The workbook pre-allocates ~20 blank rows per matrix because a spreadsheet
  cannot grow. Rows are inserted on demand.

---

## 9. What the tests actually assert

`packages/shared/src/calc/engine.test.ts` — 44 tests, all asserted against numbers read out of the
workbook rather than against fixtures invented to pass:

- Main Order totals: 1,972 grand; 579 / 464 / 385 / 544 per colour; the full `D46:M46` column row.
- Cut formula per cell at 5%: 20→21, 50→53, 138→145, 141→149, 90→95, 70→74 — and 2,084 in total,
  with per-colour 612 / 490 / 407 / 575 matching `Cut Order!S21:S24`.
- Marker plan: 2,090 planned against 2,084 required, 408 layers, 1,194 m, and the per-size `(+/−)` row.
- Size-ratio parsing: `(2YXS1)` is one 2YXS, not twenty-one YXS.
- Costing: `49.1315789` machine cost/day, `3.4210526` work days, `609.1692308` productivity — and
  `null` unit cost rendering as "Not calculated" where the sheet shows `#DIV/0!`.
- AQL: sample 125 and reject-at-8 for a 2,084-piece lot, straight from `Audit!C11:L16`.
- Every formatter, given `null`, `NaN`, `Infinity` or `-Infinity`, returns "Not calculated" and never
  leaks `NaN`, `Infinity`, `#DIV/0!` or `#VALUE!`.

Three defects were found and fixed by writing these: the lay-length allowance above; a BOM count of 22
that is actually 23; and a proportional allocation that lost 19 pieces to rounding, which made the
funnel disagree with the production log — the exact class of discrepancy this project exists to remove.

---

## 10. Phase 1 — the Super Admin tier

The brief asks that "only three people are allowed to create/manage user accounts", with two named
addresses and a third to be decided later. Four decisions came out of that.

### 10.1 Two independent gates, not one

Super-admin power requires **both** a database flag (`User.isSuperAdmin`) **and** the account's
address being present in the `SUPER_ADMIN_EMAILS` environment allowlist. Each alone fails in a
different direction:

- The allowlist alone cannot survive someone editing the database directly.
- The flag alone lets any administrator mint another administrator, which is precisely the thing
  the brief is asking to prevent.

Together, an account becomes a super admin only if an existing super admin grants it *and* the
address is configured. Both are re-checked on every request in `authenticate`, so removing an
address from the environment revokes the power at the next API call rather than the next deploy.
The third address is added by editing `.env` — no code change, no deploy.

The account-mutating routes carry a third, independent gate: `requireSuperAdmin` does not consult
the permission table at all, so a role misconfiguration cannot open them.

### 10.2 Eleven roles, not two

The brief describes two roles. The application already routes tasks, notifications and permissions
through ten, and collapsing them would have deleted working behaviour. `SUPER_ADMIN` was added as an
eleventh; the brief's "Coordinator" is the existing `COORDINATOR`, unchanged.

`ADMIN` keeps every operational permission — including `shipment:override` and `order:delete` — plus
`user:manage` and `audit:read` so an administrator can *see* the account list and the audit log. It
loses only `user:create`, `user:disable`, `user:reset-password`, `role:assign` and `settings:manage`.
An administrator runs the factory; three named people run the user list.
`packages/shared/src/permissions.test.ts` asserts exactly this split, so a later "just add one more
permission to ADMIN" cannot pass unnoticed.

### 10.3 The flag and the role must agree

A flag without a role that grants `user:create` produces something that passes the super-admin gate
and fails every permission behind it. Three places now prevent that state rather than allowing it:

- `createUser` refuses the combination and names the fix.
- `setSuperAdmin` refuses to grant the flag to a role that cannot act on it.
- `changeRole` **clears** the flag when moving to a role that cannot manage accounts. Demotion has
  to mean the same thing as revocation, or it becomes the way around it.

This also fixes what the last-super-admin guard counts. It counts *effective* super admins — flag,
allowlist and role together — so a demoted account cannot serve as phantom cover for removing the
last person who can really let anyone back in. That guard runs inside a `Serializable` transaction:
at READ COMMITTED, A disabling B while B disables A would leave nobody able to manage accounts, with
no way back except editing the database by hand.

### 10.4 Credentials nobody else keeps

Every account created or reset gets a single-use password and `mustChangePassword`. Until it is
changed, `enforcePasswordChange` refuses every endpoint except `/auth/me` and
`/auth/change-password`, with its own error code so the client can tell "set a new password" apart
from "you may not do this". A generated password is returned exactly once, in the response that
created it, and is stored only as an argon2 hash — losing it means another reset, not a lookup.

Sign-in throttling is per account as well as per IP: the IP limit stops one machine trying many
accounts, the account limit stops many machines trying one. `computeLockout()` in `@opsflow/shared`
is a pure function so it could be tested without a database, and it holds two properties that are
easy to get wrong — the failure counter is never reset by a lockout (only by a successful sign-in or
an administrator), and each successive lockout doubles, to a ceiling of a day. Resetting the counter
at the lock would hand an attacker a fresh allowance every window, forever, and show an
administrator a count of zero on an account under attack.

### 10.5 What the audit trail now covers

`Role` joined the watched set: editing a role's permission list is the most security-relevant change
the system permits, and it was previously invisible. Creates and deletes of `User` and `Role` are
recorded alongside updates; `passwordHash` is logged as an event with the value redacted; and
`lastLoginAt`, `failedLoginCount` and `lockedUntil` are ignored so routine sign-in bookkeeping does
not drown the log.

Two limitations, stated rather than hidden. Audit rows are written on the base Prisma client, so an
operation rolled back by an enclosing `$transaction` leaves its rows behind — Prisma's `$use`
middleware is not handed the transaction client, and closing this properly means moving to a
`$extends` query extension across all nine transactional call sites. And `updateMany`/`deleteMany`
bypass the middleware entirely; the one place Phase 1 uses it (the seed's bulk revocation of
de-allowlisted super admins) writes its own activity records to compensate.

### 10.6 Three security fixes found while reading

- `GET /api/users` was gated on `order:read`, so every signed-in user could read every colleague's
  email address and last sign-in time. It is now behind `user:manage`. The directory an ordinary
  user actually needs — names and departments, for assigning a task — is `/lookups`, and email
  addresses were removed from it.
- `GET /api/files/:key` authenticated the caller but never checked that the key belonged to a known
  attachment, so any signed-in user could read any stored file by knowing or guessing its key,
  including import uploads that have no attachment row at all.
- Uploads were validated by file extension only. They are now checked for path separators in the
  name, an acceptable MIME type, and the `PK\x03\x04` zip signature that every real `.xlsx` begins
  with — the extension and the MIME type are both claims made by the client; the first four bytes
  are not.

A fourth, found by review after the code was written: `trust proxy` was never set, so the login rate
limiter keyed on the *proxy's* address behind any real deployment. Ten bad passwords from one host
would have locked the entire company out of sign-in for fifteen minutes. It is now configured by
`TRUST_PROXY`, and the logged client address comes from Express's resolution of it rather than from
the client-supplied `X-Forwarded-For` header, which would have put attacker-chosen text into the
security log.

---

## 11. Phase 2 — inventory, the universal importer, and blockers

Phase 2 adds three things the workbook never had: the factory's own stock, an
importer that does not depend on one Excel layout, and a system that can say
*why* an order is stopped. Six decisions shaped them.

### 11.1 Stock has four states, and only one of them is stored

A factory that tracks a single "quantity" cannot answer the question that
matters at eight in the morning — *can I cut this order today?* — because the
metres on the shelf may already be spoken for by an order that starts tomorrow.

    physical    what is on the shelf
    reserved    committed to confirmed orders, still on the shelf
    available   physical − reserved: what a new order may actually take
    consumed    issued to production and gone

`reserved`, `available` and every shortage are computed at read time from the
reservation rows, exactly like status and progress in Phase 1. The one stored
figure is `MaterialStock.physicalQty`, and it is stored only as a running
balance behind an append-only ledger.

**A reservation is not a withdrawal.** It moves nothing. Recording one as a
movement is the classic double-count — the metres leave the balance at
reservation and again at issue, and the shelf reads empty while the fabric is
still on it. `MOVEMENT_SIGN` has no entry for a reservation because a
reservation is not a movement.

### 11.2 The ledger is the truth; the balance is a shortcut that can be checked

`MaterialMovement` is append-only: a correction is another movement, never an
edit. `MaterialStock.physicalQty` exists because replaying a few thousand
movements on every read does not scale, and it is written in the same
transaction as the movement that changes it, so there is no window where one
exists without the other.

Any shortcut around a source of truth needs a way to be checked against it.
`reconcileStock()` re-derives every balance from the ledger and reports the
difference; the Materials screen has a button for it. A non-empty result is a
bug, not a routine finding — which is why the seed throws if its own movements
do not add up to the balance it claims.

### 11.3 Quantities are integers in disguise

Fabric is measured in metres to three decimals, and `0.1 + 0.2 !== 0.3`. Left
alone, a balance drifts by a fraction of a millimetre per movement until a zero
balance compares as `-0.0000000001`, which reads as a shortage that is not real.

Everything that adds, subtracts or compares a stock quantity goes through
`qtyAdd`/`qtySub`/`qtyCmp`, which work in integer space at four decimal places,
and the column is `Decimal(18,4)` to match. `inventory-lifecycle.test.ts`
issues one metre a hundred times and asserts the balance is exactly zero.

Unit conversion is explicit and refusable. `convertQty` knows that "Met.",
"MTR" and "metres" are all metres — a spelling problem, not a conversion — but
returns `null` between dimensions. Silently treating 100 pieces as 100 kilos
because both are "a number" is the kind of error that reaches the cutting floor.

### 11.4 Two kinds of shortage, because they have two different remedies

The alert engine deliberately distinguishes them:

* **Short** — the stock does not exist. A purchase request and a phone call.
* **Reservable** — the stock is on the shelf but is not committed to this order.
  One click.

Collapsing them into one "shortage" is how a coordinator learns to ignore the
shortage alert. A third state, **Unlinked**, is reported honestly rather than
assumed covered: a BOM line naming no catalogue material cannot be checked
against stock, and saying so is better than a reassurance the cutting floor
later disproves.

### 11.5 Blockers are derived, and every stage is evaluated

There is no `WorkflowBlocker` table. A stored blocker is one that can be wrong —
the fabric arrives, the row stays, and the coordinator spends a morning chasing
a shortage that was resolved on Tuesday. `STAGE_GATES` is a declarative table of
requirements with predicates over one context object, evaluated on the request
that renders them.

Every gated stage is evaluated, not only the current one. A coordinator who can
see that cutting will be blocked in three days — because the fabric is not there
— can do something about it today. Only showing the current stage's problems is
how a factory discovers a shortage on the morning it needs the fabric. A
completed stage's gates are skipped, so nobody is told that finished work is
blocked.

### 11.6 The universal importer is a second reader behind one pipeline

The Phase 1 extractor reads one workbook shape very well by finding labelled
anchors on named sheets. That is the right tool for a file the factory controls
and the wrong tool for a file a customer emails, because the customer's file has
whatever headers the customer felt like typing.

`tabular-extractor.ts` reads the other kind and emits **the same
`ExtractionResult`**, so the preview, the validation and the transactional
commit are all unchanged. A recognised profile still wins, because it also reads
the BOM, the lay plan and the costing, which no flat table carries.

Recognising a column is a scoring problem, not a lookup — exact synonym, phrase
containment, edit distance — and the data is allowed to argue with the header: a
column headed "Qty" holding words loses confidence and gets asked about instead
of assumed. Two layouts are handled, detected from the data rather than the
sheet name: one row per colour/size/quantity, and the size grid with one column
per size. Anything below the confidence threshold is flagged for a human rather
than quietly applied, and a mapping a coordinator corrects is saved against the
client by a fingerprint of the header row, so the importer stops asking the same
question every month.

`tabular-extractor.test.ts` builds real .xlsx files in memory — a clean table,
the same order under a different customer's vocabulary, a size grid, a file with
a title block, one with a totals row, one with nothing usable — and asserts that
the first three produce identical matrices and the last fails with an
explanation rather than a wrong import.

### 11.7 What Phase 2 found while building it

Three bugs, all caught by tests written against real files rather than fixtures:

* A two-column label block (`Purchase Order | PO-99001` over
  `Delivery Date | 2026-09-15`) parses exactly like a header row followed by
  data, so the importer read the title block as the table. Fixed by requiring
  three columns — an order needs a colour, a size and a quantity, so a genuine
  two-column order table cannot exist — and by scoring every candidate header
  row instead of taking the first.
* The seed was never typechecked at all: `rootDir: src` excludes `prisma/`.
  It is the most runtime-fragile file in the repo and it runs on someone else's
  machine. `tsconfig.seed.json` now covers it.
* Issuing without a BOM line drew against every reservation the order held for
  that material, including ones belonging to other BOM lines — leaving the
  second line looking covered when its material had already gone.

---

## 12. Phase 3 — the factory's own routine, made walkable

### 12.1 The workbook declares its own workflow, and it was already in the file

Cells **A4:A21 of every sheet** in `PO No. 85 13506 Florida T Shirt` are a
hyperlink menu:

```
🖼 Customer Reference → 📋 Order Details → 🧾 Main Order → 🧾 Proforma Invoice
→ 🌐 External Order → 🕒 Progress Status → ✂ Cut Order → 📐 Laying Fabric
→ 🧵 Bill of Material → ✍ Custom Instructions → 📦 Packing → 📦 Stock
→ 📈 Follow-up → 🏭 Production Follow-up → ✅ Audit → 💰 Actual Costing → 🧾 Invoice
```

That menu is not navigation. It is the factory's standard operating procedure,
written by the factory, in the order the factory works, repeated on all
seventeen sheets so that whichever one you are on you can see where you are.

So Phase 3 did not design a workflow. `packages/shared/src/order-steps.ts`
reproduces that menu as eighteen ordered steps (the seventeen sheets plus a
terminal "Complete"), and `order-steps.test.ts` asserts the sequence against the
menu cell by cell. If somebody reorders the steps, the test says which cell they
now disagree with.

The second thing the file declares: **every sheet's header block is formula-fed
from `Order Details_Coordinator`.** `='Order Details_Coordinator'!D8` appears on
sheet after sheet. The workbook already believed the order is entered once and
read everywhere — which is exactly how OpsFlow stores it. Nothing had to change
for that; it is worth writing down because it is the strongest evidence that the
relational model matches how the factory actually thinks.

### 12.2 A step is a place to do work, not a tab

Each step carries who normally does it, what they type, and how the system knows
it is finished — as data, on the step definition, not as prose in a screen:

```ts
{
  key: StageKey.LAYING_FABRIC, order: 8, sheetName: 'Laying fabric instructions_Patr',
  label: 'Laying Fabric', department: Department.CUTTING_MARKER,
  whatYouEnter: ['One lay per fabric and colour', 'Layers, marker length, size ratio'],
  isDoneWhen: (c) => c.markerCount > 0 && c.markerCoversRequirement,
  missing: (c) => ...,
}
```

The order workspace was sixteen equal tabs. Sixteen equal doors is a filing
cabinet, not a workflow: it assumes the person opening it already knows the
process, which is precisely what a new coordinator does not. The rail replaces
it, with exactly one step lit, the next one named, and a sentence on every
outstanding step saying what it still wants.

### 12.3 "Not required" is an answer, not an omission

The workbook is full of blank cells that might mean "does not apply" and might
mean "nobody did it". A system that cannot tell those apart teaches people to
tick boxes.

Three consequences, all enforced:

* A step declares when it **applies** (`appliesWhen`). An order with no printing
  has no external operation, and that step is marked Not Required automatically,
  with the reason shown.
* A person can mark any step not required, and **the API refuses a blank
  reason** — six weeks later, "why did this order skip printing?" has an answer.
* Steps that are not required are excluded from the progress denominator.
  Otherwise an order with no external work could never reach 100%.

`StageStatus` gained `NOT_REQUIRED` in both the Prisma enum and
`@opsflow/shared`, and `StageDot` renders it grey and dashed — never a tick.

### 12.4 A person's decision beats the system's guess

`OrderStage` gained `statusOverride`, `notRequiredReason` and `completedById`.
The precedence in `deriveOrderSteps()` is fixed and tested:

```
1. a person said "not required"      → NOT_REQUIRED
2. the step does not apply           → NOT_REQUIRED
3. a person completed it, or the data says it is done  → COMPLETED
4. a person set waiting or blocked   → that state
5. something is entered, unfinished  → IN_PROGRESS
6. otherwise                         → NOT_STARTED
```

Two steps carry `manualCompletion: true` — Custom Instructions and Stock. "No
special instructions" and "we checked and there is none" are *decisions
somebody makes*, and an empty table cannot tell them apart from "nobody looked".
Those steps never complete themselves, whatever the data says.

Reopening clears the override rather than storing a new one, so the derivation
answers honestly again instead of a second guess being stored over the top.

### 12.5 What is auto-filled, and what is deliberately not

Auto-filled: the customer reference, every field on Order Details, and Main
Order carried from it — the things the import genuinely knows. Everything else
is entered by a person.

Nothing in this phase claims that production happened, material was consumed,
quality passed or anything was shipped. Marking a step done records *the
coordinator's decision*, and the UI says so in the panel under the button. The
one suggestion allowed anywhere is the proforma invoice's first draft, seeded
from the order's own client and quantity — facts already recorded, which is the
"don't type it twice" rule, not a guess. Vessel, container and shipping date are
left blank, because putting a guessed container number on a customer's document
is not a convenience.

`ProformaInvoice` stores no totals. `H15:H30` and `H31` are formulas on the
sheet and derived here, for the reason in §1: a stored total is a total that can
disagree with its own lines. A line with no quantity or no price shows "Not
calculated" — the workbook printed `#VALUE!` in the same situation, and a
confident `0.00` on a customer's quotation is worse than either.

### 12.6 The upload control, at last

`Attachment` has had a model, routes and a list UI since Phase 1 and no way to
put a file in — which made step 1, the customer's own paperwork, the only step
nobody could ever finish. `POST /api/orders/:id/attachments` closes it, with the
validation the brief's §28 asks for: an allowlist of extensions, the declared
MIME type checked against the extension, path separators rejected in the file
name, and the **first bytes checked against the format** — a `.pdf` that does
not begin `%PDF-` is something else wearing the name. Re-uploading the same name
and type is a new version; an identical file is refused rather than silently
duplicated.

Custom instruction bodies are rich text written by one member of staff and read
by another with different permissions, so `sanitiseHtml` strips every tag but a
short allowlist and **all** attributes — `onerror=`, `href="javascript:"` and
`style=` all live there. It is dependency-free and in its own file so it is
tested without a database.

### 12.7 What the real workbook found

Running `PO No. 85 13506 Florida T Shirt Summer order 2026.xlsx` through the
importer — a different customer's file from the one this project was built
against — found three defects that no fixture had. All three shared a shape:
**the import succeeded and the data was wrong.**

* **A blank cell borrowed the label beside it.** "Fit" sits at C10 with D10
  empty, and F9:F12 is a merged cell holding "Billing Adress". ExcelJS reports a
  merged value in every cell of its range, so the rightward rescan reached F10,
  found text, and imported the order with a *fit* of "Billing Adress" — and a
  block pattern of the same. No rule was broken; a string went into a string
  column. Now a merged cell whose master is on another row is skipped, and any
  candidate matching another field's anchor is rejected as a heading.
* **A formula with no cached result stringified.** The Stock sheet takes its
  entire size header by formula from Main Order. Saved by something other than
  Excel, those cells carry no cached result, and the `String(value)` fallback
  produced four size columns named `[object Object]` — headings that look like
  data. `cellText` now returns empty for any object shape it does not recognise.
* **Neither was reported.** The extractor emitted `issues: []` both times.
  Empty fields are now unresolved mappings the coordinator sees.

`extractor.test.ts` reconstructs both traps in memory — the merged label at
F9:F12, the result-less shared formula — with PO 13506's real values (1,972
pieces over four colours, $7.25, style 3091), because the file itself is 2 MB of
customer artwork and does not belong in the repository.

### 12.8 Where the numbers come from

`buildStepContext` is split into `step-context.ts` with no runtime dependency
but `@opsflow/shared`, so it is tested by value without a database. That split
is not tidiness: it is the layer where a mistyped column name is *invisible* —
the step simply reads "Not started" for ever — and three of its fields
(`ProductionRecord.qty`, `Carton.qty`, `Shipment.actualShippingDate`) were
misnamed in the first draft. Each now has a test asserting the value, not the
type.

`markerCoversRequirement` and `materialShortCount` are passed in from
`deriveOrder` rather than recomputed, so the step rail and the Materials tab can
never disagree about whether the fabric is short.

---

## 13. Phase 4 — change tracking, notifications and real Outlook email

### 13.1 The audit middleware was already the chokepoint

OpsFlow has had a Prisma `$use` middleware since Phase 1 that intercepts every
update to a watched model, reads the row before the write, diffs it, and records
one `AuditTrail` row per changed field with the actor taken from
`AsyncLocalStorage`. It cannot be forgotten, because no route handler calls it.

That is exactly where a notification system belongs, and it is why this phase
added no notification code to any route handler. The middleware gained a second
job: as well as writing its audit rows it now registers each change on the
request's own collector, and once the response has gone out the change service
turns the whole collection into one announcement.

```
audit middleware  →  ctx.changes.push(draft)     (cannot fail — it is an array)
        ↓
res.on('finish'), status < 400, not a GET
        ↓
one ChangeEvent per record touched
        ↓
Notification per active user   +   EmailDelivery row
        ↓
queue worker → Microsoft Graph → real Outlook inboxes
```

### 13.2 Grouping by request is what makes one action one email

The brief's §7 asks that changing quantity, delivery date and coordinator in one
action produce one message rather than three. Grouping by **request** rather
than by field gives that for free: the drafts are collected on the request
context, and `foldChanges()` folds them into one event per record touched.

Two records touched in one request stay two events, because a person reading the
timeline expects two lines. The same column written twice keeps the first
"before" and the last "after" — a service that writes, recomputes and writes
again should not produce `300 → 320` followed by `320 → 350` when what happened
was `300 → 350`.

`change-fold.ts` is split out with no runtime dependency but `@opsflow/shared`,
so this is tested by value without a database. It is the piece whose failure is
most visible from outside the building.

### 13.3 Three records, not one

`ChangeEvent` did not replace `AuditTrail`, and the reason is worth stating.

| | audience | grain | kept |
|---|---|---|---|
| `AuditTrail` | forensic | one row per column | forever |
| `ChangeEvent` | human | one row per user action | for reading |
| `ActivityLog` | narrative | sentences a service chose to write | for reading |

Collapsing them would mean either putting presentation into the permanent
record, or making the permanent record depend on a notification succeeding.
`AuditTrail` keeps raw column names and raw stored values; `ChangeEvent` carries
the labelled, formatted pair and the priority. The order workspace shows all
three, with Changes opening first because it is what most people want.

### 13.4 Meaning lives in one table

`change-catalogue.ts` in `@opsflow/shared` holds the whole of "which changes
matter": which models are tracked, what the factory calls each field, how a
stored value is formatted, and what priority a change earns. It is a readable
table rather than conditionals spread across services, and it is in `shared`
so the API and the web client cannot label the same change differently.

Priority is derived, never chosen by a caller. A delivery date is HIGH wherever
it appears; a value of `FAIL` or `CANCELLED` is URGENT whatever field carries
it; a batch takes the loudest of its parts and never the average, because the
person reading it needs to see the urgent part.

Two models are deliberately **not** tracked, and both absences are commented in
the table. `StageQuantity` is written cell by cell with `upsert`, which the
middleware does not intercept — and forty cell events is the wrong story
anyway, so the matrix route announces the ledger total instead. `MaterialStock`
is a running balance behind the `MaterialMovement` ledger, and the movement is
already announced; tracking both would send two messages for one event and add
a read to every Serializable stock transaction.

### 13.5 The actor is the session, and only the session

`req.user` is set by `authenticate`, which verifies the JWT and re-reads the
user from the database on every request. `requestContextMiddleware` copies the
id and name into the async context. There is no code path from a request body to
the actor, and `request-context.test.ts` posts `{"changedBy": "Ahmed"}` and
asserts the string appears nowhere in the resulting context.

### 13.6 Email cannot break a save

The ordering is the requirement. By the time anything email-related runs, the
response has already gone to the client — `res.on('finish')`, not a middleware
in the chain. Below that, each step guards its own failure: a failed email
leaves the notifications, a failed notification leaves the event, a failed event
leaves the audit trail, which was written during the request by other code.

`EmailDelivery` is the queue: a table and a timer, because the requirement is
that a failed message can be retried and its failure seen, not that the factory
runs Redis. Rows survive a restart. The backoff is 1, 5, 25, 120 and 600
minutes — geometric, because the failures worth retrying are transient ones, and
totalling over twelve hours so an outage that starts in the evening is still
delivered in the morning.

An **unconfigured** system is not a failure. Messages stay PENDING with their
attempt count untouched, so filling in the credentials tomorrow delivers what
happened today rather than finding the backlog exhausted.

### 13.7 Microsoft Graph with two HTTP calls and no dependencies

Client credentials against `login.microsoftonline.com`, then
`POST /v1.0/users/{sender}/sendMail`. `fetch` rather than `@azure/msal-node`
and `@microsoft/microsoft-graph-client`: those libraries and their transitive
dependencies are a large amount of supply chain for one token request and one
POST, and the brief asks for no unnecessary dependencies. The in-memory token
cache is the only thing MSAL would have provided that is actually needed, and it
is fifteen lines.

Recipients go in **Bcc** with the sender mailbox as the single To. A change
notification going to the whole factory must not publish everyone's address to
everyone else, and it is one API call rather than one per person, which matters
when Graph starts throttling.

The permission is `Mail.Send` as an **application** permission with
administrator consent — the minimum that can send mail with no user present.
Application `Mail.Send` grants the app the ability to send as any mailbox in the
tenant, so the README recommends an Exchange `ApplicationAccessPolicy` scoping
it to the one sender mailbox.

### 13.8 What the tests hold

The suite grew by 55. The ones worth naming:

* **The frontend cannot choose the actor** — a request body claiming to be
  somebody else, asserted absent from the context.
* **Reads announce nothing** — GET, HEAD and OPTIONS produce no event even when
  something downstream wrote a cache column.
* **A failed request announces nothing** — 400 through 500, because a partial
  write belongs in the audit trail and not in an email about work that did not
  happen.
* **Three fields, one event** — and two records, two events.
* **Recipients are in Bcc** — asserted on the actual Graph payload, because
  getting this wrong looks like it worked.
* **A value never set is not invented** — no zero standing in for "we do not
  know", in the catalogue, the template, and the rendered HTML.
* **An order name containing `<script>` cannot become markup** in an email.
* **`z.coerce.boolean()` is not used** for any environment flag. `Boolean("false")`
  is `true`, and every variable that reads `false` in `.env.example` would have
  been silently on.

---

## 14. Phase 5 — the order owns its workflow

### 14.1 A correction first

Phase 3 said this file reproduced the workbook's A4:A21 menu verbatim. It did
not. Re-read from the file cell by cell, the menu is:

```
A14 📦 Packing   A15 📦 Stock   A16 📈 Follow-up
A17 🏭 Production Follow-up      A18 ✅ Audit
A19 💰 Actual Costing            A20 🗄 Database   A21 🧾 Invoice
```

Phase 3 had Production and Audit at 11 and 12 — two places too early — and
replaced the workbook's own `Data-Base` sheet with an invented "Complete" step.
The test passed because it asserted the transcription rather than the file. A
test that agrees with the code it is testing is not a test, and that is the
lesson worth keeping from it.

`order-steps.ts` now carries the sequence with the cell reference against each
entry, and `DATABASE` is a real step at 17.

### 14.2 The sidebar is the company; the order is the workflow

Six sidebar entries — Production, External Ops, Quality, Packing, Shipping and
Order BOM — were the same `ModuleListPage` with a different status filter. Six
doors into one room, each implying that work happened *there* when the work
happens inside an order.

They are gone from the sidebar and their routes redirect to Orders with the
filter applied, so old bookmarks land somewhere sensible. What Changed folded
into Administration → Audit Log as its first tab, because it and the audit log
were two pages showing the same events. The sidebar is now four groups and
fifteen entries, and every one of them is a company-wide concern.

The eighteen steps live where they belong: down the left of an order.

### 14.3 A reference page is not a task

`Database` is step 17 because the workbook puts it there, but it holds no work.
So `OrderStepDef` gained `informational`, and a step carrying it is never the
current step and never counted in the progress denominator. An order is not
further along because somebody opened its metadata.

Its weight in `STAGE_META` is 0 for the same reason.

### 14.4 The date crash, and the two sites nobody had found

The reported error:

```
RangeError: Invalid time value
    at Date.toISOString
```

`new Date("13/09/2026")` is an Invalid Date: not an error, not null, an object
that passes `instanceof Date` and throws the instant anything calls
`toISOString()` on it. There were **four** places this could happen, three of
them reachable from a single bad cell:

1. `extractor.ts` `cellText()` — `value.toISOString()` on any Date it met.
2. `tabular-extractor.ts` — `new Date(String(value))` on a coordinator's
   typed override, manufacturing the invalid Date in the first place.
3. `column-mapping.ts` — sampling five cells to guess a column's meaning.
4. `committer.ts` — `poDate.getTime()` is `NaN` for an invalid date, which
   would have pushed the failure into the database rather than the parser.

`excel-date.ts` in `@opsflow/shared` is now the only way a date is read, and its
contract is that it returns a valid `Date` or `null` — never an Invalid Date, so
nothing downstream has to remember to check. It handles Excel serials (with the
1900 leap-year bug), ISO, `DD/MM`, `MM/DD`, `13 Sep 2026`, `September 13, 2026`,
`13th September`, two-digit years, and the placeholders people type where a date
is not known: `TBC`, `N/A`, `ASAP`, `-`, `?`.

Two decisions in it are worth naming. **31 February is refused** rather than
rolled into 3 March, which is how a delivery date moves three days and nobody
notices. And **`03/09/2026` is reported as ambiguous** — day-first preferred,
month-first offered — because that one is how an order ships two months early.
`13/09` is not ambiguous and is not reported as such.

A number is only read as a date between serials 20,000 and 80,000 (1954–2119).
Outside that band a number in a spreadsheet is a quantity, a price or a style
code, and reading `3091` as a day in 1908 is worse than reading nothing.

### 14.5 Provenance, and confidence that means something

`ImportFieldMapping` gained `cell`, `confidence` and `interpretation`. The
extractor already computed the cell and threw it away.

The review screen now separates what it is sure of from what it is not. HIGH is
a value read from the cell an explicit anchor points at, or a column header the
synonym table knows. Anything below that is listed at the top under "Please
confirm these", with the reading stated in words — and for an ambiguous date,
both readings as buttons. Nothing below HIGH is applied silently.

The same provenance is kept on the order forever: step 17 shows the workbook it
came from, the sheet, and the cell every field was read out of. Running PO 13506
through it now reports `PO Number · Order Details_Coordinator · D7 · HIGH`,
which is the example the brief asked for.

### 14.6 A size grid headed "Medium | Large | XL"

The size vocabulary was a pattern covering `XS`–`XXXL`, numeric sizes and `OS`.
It did not cover the words. A customer outside the garment trade sending
`Medium | Large | XL` — the brief's own example — produced three unrecognised
columns and no matrix at all.

`SPELLED_SIZES` is an explicit list rather than a pattern, because "small" must
match and "smaller", "small parts" and "small carton" must not.

### 14.7 What the tests hold now

`hostile-workbook.test.ts` builds, in memory, the files a customer actually
sends: headers on row six under a title block and a note, a merged title
spanning the table, four sheets where the data is on the third, a customer's own
vocabulary, a size grid, and a date column where three rows out of six are
unreadable. Every one asserts that the import does not throw, and that the
readable rows were read.

That last one is the point. An importer that reads four hundred rows and then
dies on row four hundred and one is worse than one that refuses at the start,
because the coordinator has no idea how much of it was understood.
