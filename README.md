# OpsFlow — Garment Order Control Centre

Replaces the `PO No. 85 – A302059B Florida T Shirt Summer order 2026.xlsx` workbook — and every workbook
like it — with one relational system.

**[ARCHITECTURE.md](./ARCHITECTURE.md) is the document to read first.** It explains what the Excel file
actually is, the three findings that drove the design, and every decision made because of them.

---

## Getting it running

Prerequisites: **Node 20+** and **Docker** (for PostgreSQL).

```bash
cp .env.example .env          # the defaults work as-is for local development
npm run setup                 # install → build shared → start Postgres → migrate → seed
npm run dev                   # API on :4000, web on :5173
```

`npm run setup` is the four commands below in one:

```bash
npm install
npm run build -w @opsflow/shared   # the API and the web app both import this
npm run db:up                      # docker compose up -d db  (Postgres on :5433)
npm run db:migrate                 # prisma migrate dev
npm run db:seed                    # reference data + PO A302059B
```

Then open **http://localhost:5173** and sign in:

| Email | Role | What they can do |
|---|---|---|
| `hassona@age-factory.com` | Order Coordinator | **Start here.** The brief's most important user. |
| `admin@age-factory.com` | Administrator | Everything operational, plus visibility of accounts and the audit log. Cannot create or disable an account. |
| `ahmed@soccertex.biz` | Super Administrator | The only tier that can create, disable, re-role and reset accounts. |
| `laila@soccertex.biz` | Super Administrator | The second named super administrator. |
| `khaled@age-factory.com` | Warehouse | Issue materials — watch the shortage alert clear. |
| `helmy@age-factory.com` | External Operations | Try to release printing before the approval lands. |
| `shimaa@age-factory.com` | Quality | Record an audit; fail it and watch the order block. |

Password for all of them: `opsflow-demo-2026`

The two super-administrator accounts are seeded with `mustChangePassword` set, so the first thing
they see is a password change and the API refuses everything else until they do. That is the
intended behaviour for an account whose password someone else has seen — not a bug.

### Who may manage accounts

`SUPER_ADMIN_EMAILS` in `.env` lists the addresses permitted to hold super-administrator rights.
The third address is added there, with no code change and no deploy. Being listed is **necessary
but not sufficient**: an existing super administrator must also grant the rights, and the API
re-checks both on every request — so removing an address from the list revokes the power at the
next call rather than at the next deploy.

---

## What to try first

The seeded order is A302059B in its real state: 1,972 pieces ordered, 2,084 to cut, materials wholly
unissued, and printing blocked on a customer approval that has been outstanding twelve days.

1. **Open the order → Overview.** Every one of the brief's twenty questions is answered on this one
   screen. Progress reads 36% and the panel underneath says where that number came from.
2. **External & Approvals → press Send.** The system refuses. The order sheet's Arabic note —
   *«برجاء عدم البدء ف طباعه الاوردر الا بعد موافقه العميل»* — is a constraint here, not a reminder.
3. **Record the approval as approved.** Four blocked operations and the workflow task behind them release
   at once, and the alert count drops on the dashboard.
4. **BOM → Issue on any short line.** Issue the lot and the shortage alert clears; issue part of it and
   the coverage bar moves instead.
5. **Production → Record output → enter 20 pieces.** The projected completion date slides past the
   required date, the order flips to Production Delayed, and the dashboard follows.
6. **Costing.** Unit cost reads "Not calculated" rather than `#DIV/0!`, and says why.
7. **Workflow → tick a task out of sequence.** It explains which step it is waiting on.

### Phase 2 — inventory and the universal importer

8. **Open the order → Overview.** The first thing on the page is what is blocking it: Rosetta White
   is **476 m short** of the 1,194 m the order needs, so cutting cannot start. That number is not a
   fixture — the store holds 718 m, and the ledger behind it explains where the rest went.
9. **Materials tab.** Every requirement against real stock, in four states: covered, reservable
   (in stock, one click), short (does not exist), and not linked. Press **Reserve** on a reservable
   line and watch the material's available figure drop while its physical figure does not move.
10. **Inventory → Materials → Rosetta Jersey — White.** The four states, who has it reserved, and
    the movement history: a 5,000 m receipt, two issues to older orders, 82 m of roll-end damage,
    200 m returned. They add up to 718.
11. **Press Reconcile** on the Materials page. It replays every ledger and reports drift. On a fresh
    seed it should find none — that is the check that makes the stored balance trustworthy.
12. **Issue material, then return some.** The reservation is drawn down as the fabric leaves, and
    restored when it comes back. Both appear in the ledger; neither is ever an edit.
13. **Import → drop any spreadsheet in.** Not just the AGE workbook — a two-column
    `Colour | Size | Qty` file, or a size grid with one column per size. The importer says what it
    found, asks about anything it is unsure of, previews the order, and only then creates it.

### Phase 3 — the guided routine

14. **Import the real workbook.** Drop
    `PO No. 85 13506 Florida T Shirt Summer order 2026.xlsx` on the Import page. It is recognised
    as the AGE profile with full confidence: ProTime, PO 13506, style 3091, $7.25, and 1,972
    pieces across SKY BLUE, ATH. GOLD, SCARLET and LIME. *Fit* and *Block Pattern* come back
    empty and are listed as unresolved — the workbook leaves them blank, and blank is the honest
    answer (see ARCHITECTURE.md §12.7 for what happened before that was true).
15. **Open the order.** The sixteen-tab strip is gone. Down the left is the factory's own
    eighteen-step routine, taken from the hyperlink menu in cells A4:A21 of every sheet, with one
    step marked **You are here** and the next one named at the top of the page.
16. **Read the current step.** It says what it is for, who normally does it, what you type, and
    one sentence naming what is still missing. Nothing else on the page is more prominent.
17. **Step 5, External Order, is greyed out and dashed.** It says *"This order has no printing or
    embroidery."* Not ticked, not hidden, and left out of the progress denominator — so the order
    can still reach 100%.
18. **Press "Not required" on any step.** It refuses a blank reason. Six weeks later somebody will
    ask why the order skipped that step.
19. **Step 1, Customer Reference → drop a PDF in.** The upload control this README listed as
    missing since Phase 1. Try renaming a `.txt` to `.pdf` first: it is refused because the first
    bytes are not `%PDF-`.
20. **Step 4, Proforma Invoice.** The consignee and quantity are seeded from the order — facts it
    already holds. Clear a unit price and the line total reads "Not calculated" rather than 0.00,
    and drops out of the grand total. Mark it sent and it locks.
21. **Step 10, Custom Instructions, and step 14, Stock.** Neither ever completes itself. "No
    special instructions" and "we checked and there is none" are decisions somebody makes, and an
    empty table cannot tell them apart from nobody having looked.
22. **Click "All screens".** The full tab strip is still there for people who know exactly where
    they are going.

### Phase 4 — change tracking, notifications and real Outlook email

23. **Change something.** Move a delivery date on any order. Then look at three places: the bell
    in the top-right has a badge, **What Changed?** in the sidebar has a new line, and the order's
    **Activity → Changes** tab shows it with the old date and the new one.
24. **Change three things at once.** Edit the quantity, the delivery date and the coordinator in
    one action. You get **one** notification and **one** email listing all three — not three of
    each. That grouping is by request, which is why no route handler had to be taught about it.
25. **Look at the priority.** A delivery date is orange (High). Cancelling an order or failing a
    quality audit is red (Urgent). A marker note is green (Low). Nothing chose those in the
    frontend — they are derived on the server from what actually changed.
26. **Press "Not required" on a step, or upload a document.** Both appear in the feed. Now open an
    order and read it: nothing appears, because reads are not changes.
27. **Try to lie about who you are.** Post an order edit with `{"changedBy": "Ahmed"}` in the body.
    The change is recorded against *your* account, because the actor comes from your session and
    there is no code path from the request body to it.
28. **Settings → Email notifications.** Says whether Microsoft 365 is configured — by naming the
    settings that are *missing*, never the ones that are set. **Send me a test** sends one real
    email to your own address and reports what Microsoft actually said.
29. **Filter What Changed?** By category, priority, person, or date. The person list is built from
    who has actually changed something, not from every account in the factory.

### Phase 5 — the order owns its workflow

30. **Look at the sidebar.** Six entries are gone — Production, External Ops, Quality, Packing,
    Shipping and Order BOM were the same order list with six different filters. Their routes
    redirect to Orders, so old bookmarks still land somewhere sensible.
31. **Open an order.** The eighteen steps down the left are the workbook's own menu, in the
    workbook's own order, with the sheet name against each. Step 17 is **Database** — the workbook
    has a `Data-Base` sheet at A20, and Phase 3 had wrongly replaced it with an invented step.
32. **Step 6, Progress Status.** The percentage, the current step, every blocker, and whether the
    order will make its date at the rate it is actually running. Nothing on that screen is typed.
33. **Step 15, Audit.** Who changed what, from what to what, with the time. Real rows from the
    database, not a mock — and the quality inspection is the second tab.
34. **Step 17, Database.** The workbook it was imported from, and **the cell every field was read
    out of**: `PO Number · Order Details_Coordinator · D7`.
35. **Import a file with a broken date.** Put `#VALUE!`, `TBC` and `31/02/2026` in a delivery-date
    column. The good rows import, the bad ones come back empty, and the
    `RangeError: Invalid time value` crash cannot happen — there were four places it could, and
    all four are closed.
36. **Import `03/09/2026`.** The review screen asks whether you mean 3 September or 9 March,
    with both as buttons. `13/09/2026` is not ambiguous and is not questioned.
37. **Import a grid headed `Medium | Large | XL`.** It now reads as a size matrix; the vocabulary
    only knew `S/M/L/XL` before.

---

## Microsoft 365 email — the one thing you must configure

Change notifications appear in OpsFlow with no setup at all. **Real emails need
four settings**, and until they are present OpsFlow queues the messages rather than losing them —
fill the settings in later and the backlog goes out.

### 1. Register the application

1. **https://entra.microsoft.com** → *Applications* → *App registrations* → **New registration**.
2. Name: `OpsFlow Notifications`. Supported account types: **Single tenant**.
   **Leave Redirect URI blank** — this is a background service, not a sign-in flow.
3. Press **Register**.

### 2. Copy the two ids

The **Overview** page shows both:

| On the page | Goes in `.env` as |
|---|---|
| Directory (tenant) ID | `MICROSOFT_TENANT_ID` |
| Application (client) ID | `MICROSOFT_CLIENT_ID` |

### 3. Create the client secret

*Certificates & secrets* → *Client secrets* → **New client secret**. Choose an expiry you will
remember — email stops the day it lapses.

Copy the **Value** column, not the Secret ID. It is shown once and never again. That is
`MICROSOFT_CLIENT_SECRET`.

### 4. Grant exactly one permission

*API permissions* → **Add a permission** → **Microsoft Graph** → **Application permissions**
(not *Delegated* — there is no user sitting in front of this) → search `Mail.Send` → **Add**.

Then press **Grant admin consent for &lt;your tenant&gt;**. Application permissions do nothing
without it, and only a Microsoft 365 administrator can press it.

`Mail.Send` is the only permission OpsFlow needs. Do not grant `Mail.ReadWrite`, `User.Read.All`
or anything else — it never reads a mailbox and never lists your directory.

### 5. Choose the sender mailbox

`MICROSOFT_SENDER_EMAIL` must be a **real, licensed mailbox in your tenant** — a shared mailbox
such as `opsflow@yourcompany.com` is ideal. Every message is sent from it, and a copy lands in its
Sent Items.

**Worth doing:** application `Mail.Send` lets this app send as *any* mailbox in the tenant. To
restrict it to just this one, ask your administrator to run an Exchange Online
[ApplicationAccessPolicy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
scoped to the app's client id. Recommended, not required.

### 6. Fill in `.env` and restart

```bash
MICROSOFT_TENANT_ID="00000000-0000-0000-0000-000000000000"
MICROSOFT_CLIENT_ID="00000000-0000-0000-0000-000000000000"
MICROSOFT_CLIENT_SECRET="the Value column, not the Secret ID"
MICROSOFT_SENDER_EMAIL="opsflow@yourcompany.com"

# Optional: the "Open in OpsFlow" button in emails. Leave blank and it is
# omitted rather than pointing at localhost.
APP_BASE_URL="https://opsflow.yourcompany.com"
```

The API says at boot which it is:

```
  email    → Microsoft Graph as opsflow@yourcompany.com
```

### 7. Prove it works

Sign in as a super administrator → **Settings** → **Email notifications** → **Send me a test**.

One real email goes to your own address and the screen reports what Microsoft actually said. On a
first send, check the junk folder. If it fails, the exact Graph or Entra error is shown — the
common ones:

| Error | What it means |
|---|---|
| `AADSTS7000215: Invalid client secret` | You copied the Secret ID instead of the Value, or it expired |
| `ErrorAccessDenied` | Admin consent was not granted, or `Mail.Send` is *Delegated* rather than *Application* |
| `ErrorInvalidUser` / `MailboxNotEnabledForRESTAPI` | `MICROSOFT_SENDER_EMAIL` is not a real licensed mailbox in the tenant |
| `Access to OData is disabled` | An ApplicationAccessPolicy is excluding this mailbox |

Then make a real change to an order and watch it arrive in every active user's inbox.

### Who receives them

Every **active** user, read live from the `users` table. Disabled accounts are excluded by the same
`active` column the sign-in check uses, so an account stops receiving mail at the moment it stops
being able to sign in. Nobody is hard-coded anywhere.

The person who made the change is not emailed about their own action — telling somebody what they
just did is the fastest way to teach a factory that OpsFlow mail is noise. Set `NOTIFY_ACTOR=true`
if you disagree; it is one setting.

---

## Layout

### Where things are

```
SIDEBAR                        THE COMPANY
  Overview     Dashboard · Orders · My Tasks · Follow-Up
  Inventory    Materials · Reservations · Movements
  Business     Costing · Clients · Factories · Reports · Excel Import
  Administration  Users · Audit Log · Settings

OPEN AN ORDER                  THE WORKFLOW
   1 Customer Reference    7 Cut Order            13 Follow-up
   2 Order Details         8 Laying Fabric        14 Production Follow-up
   3 Main Order            9 Bill of Material     15 Audit
   4 Proforma Invoice     10 Custom Instructions  16 Actual Costing
   5 External Order       11 Packing              17 Database
   6 Progress Status      12 Stock                18 Invoice
```

The eighteen are the workbook's own hyperlink menu, cells A4:A21 of every sheet.
They are sections **inside an order**, never sidebar pages: Materials,
Reservations and Movements stay company-wide under Inventory, while an order's
BOM and Stock show that order's own material situation.

```
packages/shared/   @opsflow/shared — pure TypeScript, zero dependencies.
                   Enums, DTOs, and the whole calculation engine. Imported by
                   BOTH the API and the web client so a number cannot be
                   computed two different ways.
packages/server/   Express + Prisma + PostgreSQL. REST, RBAC, business rules,
                   inventory, Excel import. 46 models in prisma/schema.prisma.
packages/web/      React 18 + TypeScript + Vite + Tailwind + TanStack Query.
```

### Commands

```bash
npm run dev            # API and web together
npm run build          # build all three packages
npm run typecheck      # tsc --noEmit across the workspace
npm test               # 406 tests: engine, access control, inventory, importer, steps
npm run db:seed        # re-seed (idempotent)
npm run studio -w @opsflow/server   # Prisma Studio
```

---

## The three rules this codebase follows

**1. Only facts are stored.** Status, progress, every shortage, every alert, the projected completion
date — all computed at read time by `@opsflow/shared`. A stored shortage is a shortage that can disagree
with its inputs. The one deliberate exception is documented in ARCHITECTURE.md §1 (Finding 3b): the lay
length is *measured*, not derived, and deriving it would under-state the order's fabric by 80 metres.

**2. Nothing renders `NaN`.** Every division goes through `safeDiv()`, which returns `null`. Every number
reaches the screen through `<Num>`, which renders `null` as "Not calculated". The workbook shows
`#DIV/0!` in five costing cells and `#VALUE!` on four sheets; that class of bug cannot occur here.

**3. Rules are enforced, not written down.** The workbook is full of instructions nobody is bound by.
Each one that a machine can check is now a typed error in `services/rules.ts` with a message written for
the person who hit it — the API returns 409 and the UI shows the sentence verbatim.

---

## Testing

```bash
npm test
```

406 tests. Forty-four cover the calculation engine, with every expected value read out of the workbook
rather than invented to pass: the 1,972 and 2,084 totals, per-colour and per-size rows, the
`ROUNDUP((order − stock) × 1.05)` cut formula cell by cell, the six-lay marker plan and its `(+/−)`
variance row, the AQL sampling table, and the costing figures including the `#DIV/0!` cases. Writing
them found three real defects — see ARCHITECTURE.md §9.

Eighteen more cover access control: that ADMIN cannot create, disable, reset or re-role an account;
that no operational role can touch accounts at all; that the coordinator keeps every order-owning
permission it needs; that the super-admin allowlist parses to nobody rather than everybody when it
is unset; and that the sign-in lockout counter runs across lockout windows instead of resetting —
the difference between a wall and a speed limit.

The remaining 127 cover Phase 2:

- **Inventory arithmetic** — the four stock states, reservations that do not move stock, issuing
  against a reservation, returns, over-reservation, consumption variance, unit conversion that
  refuses to guess across dimensions.
- **Stock lifecycle** — a simulation of the service's own state transitions that asserts four
  invariants after *every* step of a long mixed sequence: the balance equals the ledger, available
  equals physical minus reserved, reserved is the unconsumed part of active reservations, and
  nothing goes negative. A hundred one-metre issues leave exactly zero.
- **Column mapping** — the brief's two customers (`Style|Color|Size|Qty` and
  `Article|Shade|Size|Pieces`) resolving to the same concepts, every spelling of "quantity", the
  data overruling a misleading header, and an honest refusal on an unrecognised one.
- **Stage gates** — a fabric shortage blocking cutting and saying by how much, several problems
  reported together rather than one at a time, and a completed stage's gates staying quiet.
- **The universal importer** (`npm run test -w @opsflow/server`) — real .xlsx files built in
  memory in five customer formats, asserting that three different layouts produce identical
  matrices and that an unreadable file fails with an explanation instead of a wrong import.

Phase 3 adds fifty-one more:

- **The eighteen steps** — that the sequence matches the workbook's own hyperlink menu cell by
  cell, that `STAGE_META` and the step list cannot drift apart, that exactly one step is ever
  current, that a blocked step stays current instead of hiding behind the next unblocked one,
  that "not required" is excluded from progress, and that a person's decision always beats the
  system's guess. Writing them found a real defect: a step with a thousand of two thousand pieces
  produced read "Not started".
- **Step context assembly** — every field asserted by value rather than by type, because this is
  the layer where a mistyped column name is invisible: the step simply never leaves "Not started".
  Three were wrong in the first draft.
- **PO 13506** — the profile extractor against the real workbook's two traps, reconstructed in
  memory: a merged label bleeding into a blank cell, and a shared formula with no cached result.
  Both produced a successful import with wrong data (ARCHITECTURE.md §12.7).
- **The instruction sanitiser** — that script, style, iframes and every attribute are stripped,
  and that the formatting a coordinator actually uses survives.

Phase 4 adds ninety-eight:

- **Who made the change** — a request body claiming `{"changedBy": "Ahmed"}`, asserted absent from
  the recorded context; GET, HEAD and OPTIONS announcing nothing; a 4xx or 5xx announcing nothing.
- **One action, one message** — three fields folding into one event, two records staying two, the
  same column written twice keeping the first before and the last after.
- **What a change means** — a delivery date always High, a `FAIL` always Urgent, a batch taking the
  loudest of its parts, an unknown previous value never becoming a zero.
- **Microsoft Graph** — the token request's grant type and scope, recipients in Bcc rather than To,
  one call for forty people, a 401 dropping the cached token, and Entra's error becoming one
  readable line rather than a wall of correlation ids. Every one stubs `fetch`; nothing in the
  suite talks to Microsoft.
- **The email itself** — an order name containing `<script>` escaped everywhere it appears, a
  plain-text part readable on its own, and no "Open in OpsFlow" button when no base URL is
  configured, because a link to localhost in somebody's inbox is worse than no link.

The tests are compiled before they run (`tsc -p tsconfig.test.json`, then `node --test` over the
output) rather than executed as TypeScript directly. They import siblings by the ESM `.js` specifier
the compiled package uses, and Node's type stripping does not rewrite that back to `.ts`. Compiling
first also means every `npm test` typechecks the test files.

### Typechecking the server without a database

`npm run typecheck` needs `prisma generate` to have run. Where the Prisma engine binaries cannot be
downloaded, `tools/gen-prisma-stub.mjs` builds a structural stub from `schema.prisma`:

```bash
node packages/server/tools/gen-prisma-stub.mjs
npx tsc -p packages/server/tsconfig.offline.json
```

That is how the server in this drop was verified — it found two real bugs the eye had missed: a multer
`fileFilter` callback invoked with both an error and an accept flag (its signature is an overload pair,
so a rejected upload was being accepted anyway), and an `undefined` in a JSON `meta` payload that Prisma
would have dropped silently instead of storing as null.

---

## Where to pick it up

Built to the brief's phase plan. Phases 1–4 are deep; 5–6 are working but thinner.

| Area | State |
|---|---|
| Schema (46 models) | Complete |
| Calculation engine | Complete, tested against the workbook |
| Auth, RBAC, audit trail | Complete |
| Super Admin tier, user management, admin audit viewer | Complete (Phase 1) |
| Materials & inventory (four states, movement ledger, reservations) | Complete (Phase 2) |
| Universal Excel importer (any layout, column mapping, saved mappings) | Complete (Phase 2) |
| Stage gates and blockers, action-first dashboard | Complete (Phase 2) |
| Dashboard, Orders, Order Workspace | Complete |
| Quantity matrix, Workflow, Follow-Up | Complete |
| BOM, Cutting/Marker, External Ops, Approvals | Complete |
| Production tracking & analytics | Complete |
| Excel import pipeline | Complete for the `age-order-v1` profile |
| Quality, Packing, Shipping, Costing | Working; screens are thinner than the above |
| Notifications | Stored and listed; no email/push transport |
| File storage | Local driver working; **`S3Driver` is a typed stub** — five methods to fill in |
| Attachments | **Complete (Phase 3)** — upload with extension, MIME and magic-byte validation |
| Change tracking, order history, What Changed (now inside Audit Log) | Complete (Phase 4) |
| Sidebar reduced to company-wide concerns; 18 steps live inside the order | Complete (Phase 5) |
| Progress Status, Audit, Database and Invoice sections | Complete (Phase 5) |
| Safe spreadsheet dates, field provenance (sheet + cell), confidence on the review screen | Complete (Phase 5) |
| In-app notifications with priority, bell dropdown, read/unread | Complete (Phase 4) |
| Real Microsoft 365 email via Graph, delivery status and retry | Complete (Phase 4) — needs four settings in `.env` |
| Guided 18-step routine, step rail, "not required" with reasons | Complete (Phase 3) |
| Customer Reference, Custom Instructions, Stock, Proforma Invoice, per-order Follow-up | Complete (Phase 3) |

The clearest next steps: implement `S3Driver`, render the proforma invoice as a PDF the factory
can actually send, and deepen the Packing and Shipping screens to match the depth of the BOM and
Production tabs.

Adding a second Excel layout means adding one profile to `services/import/profiles.ts` — fields are
located by anchor text, so no cell references need hard-coding.
