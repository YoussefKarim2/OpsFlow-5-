import type { Prisma, PrismaClient } from '@prisma/client';
import { TRACKED_MODELS } from '@opsflow/shared';
import { getRequestContext, collectChange } from '../request-context.js';

/**
 * Field-level audit trail — the brief's section 41.
 *
 * Implemented as Prisma middleware rather than as calls inside route handlers,
 * because a handler that forgets to log leaves a permanent hole. Every update
 * to a watched model is diffed before and after and each changed field becomes
 * an AuditTrail row.
 *
 * The actor comes from AsyncLocalStorage rather than being threaded through
 * every service signature.
 *
 * Since the change-tracking work, this middleware has a second job. As well as
 * writing AuditTrail rows it registers each change on the request's collector
 * (`collectChange`), and once the response has gone out the change service
 * turns the whole collection into one ChangeEvent, one notification per active
 * user and one email. That is why no route handler contains notification code:
 * the one place that already sees every mutation announces them all.
 *
 * The two jobs are kept independent on purpose. Registering a draft cannot fail
 * — it appends to an array — and the audit write is unchanged, so adding
 * notifications did not put the permanent record at any new risk.
 */

/** Models whose field changes matter enough to keep forever. */
const WATCHED = new Set([
  'Order', 'Task', 'BomItem', 'ExternalOperation', 'Approval',
  'Shipment', 'QualityAudit', 'CostingRecord', 'Marker',
  'CuttingRecord', 'PackingList', 'User',
  // Editing a role's permission list is the single most security-relevant
  // change the system allows. It belongs here, not only in WATCHED_LIFECYCLE.
  'Role',
]);

/**
 * Models where the *existence* of a record is itself the event worth keeping —
 * an account being created or deleted is the thing you want to find later, not
 * a diff of its fields. Updates are logged for every WATCHED model; creates and
 * deletes only for these, so the trail does not fill with routine inserts.
 */
const WATCHED_LIFECYCLE = new Set(['User', 'Role']);

/** Fields worth recording when a lifecycle-watched record is created. */
const CREATE_FIELDS: Record<string, string[]> = {
  User: ['email', 'name', 'department', 'roleId', 'active', 'isSuperAdmin'],
  Role: ['key', 'label', 'permissions'],
};

/** Fields that change on every write and would drown the log. */
const IGNORED_FIELDS = new Set([
  'updatedAt', 'createdAt', 'cachedProgressPct', 'cachedStatus', 'cachedStageKey',
  // Bookkeeping the throttle writes on nearly every sign-in.
  'lastLoginAt', 'failedLoginCount', 'lockedUntil',
]);

/** Never write a credential into the audit trail, hashed or not. */
const REDACTED_FIELDS = new Set(['passwordHash', 'password']);

function serialise(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Locate the orderId for a record so the trail can be filtered per order. */
function extractOrderId(model: string, before: Record<string, unknown> | null): string | null {
  if (!before) return null;
  if (model === 'Order') return (before.id as string) ?? null;
  return (before.orderId as string) ?? null;
}

export function auditMiddleware(prisma: PrismaClient): Prisma.Middleware {
  return async (params, next) => {
    const { model, action, args } = params;

    if (!model) return next(params);

    // ── Creates ────────────────────────────────────────────────────────────
    //
    // Two different questions, deliberately answered differently.
    //
    // The AuditTrail records a create only for User and Role, where the
    // *existence* of the record is the thing somebody will come looking for.
    // Writing a field row per column for every insert would bury the trail in
    // routine work, which is why that decision was made and why it stands.
    //
    // A ChangeEvent is announced for any model where creating the record is
    // itself the news — a production record, a stock movement, an uploaded
    // document. Those are exactly the things the factory wants to hear about,
    // and they never appear as updates.
    const trackedCreate = TRACKED_MODELS[model];
    if (action === 'create' && (WATCHED_LIFECYCLE.has(model) || trackedCreate?.createIsAnEvent)) {
      const result = await next(params);
      const created = result as Record<string, unknown> | null;
      if (created) {
        const ctx = getRequestContext();

        if (WATCHED_LIFECYCLE.has(model)) {
          const fields = CREATE_FIELDS[model] ?? Object.keys(created);
          writeRows(
            prisma,
            fields
              .filter((f) => !REDACTED_FIELDS.has(f) && !IGNORED_FIELDS.has(f))
              .map((field) => ({
                entityType: model,
                entityId: String(created.id ?? ''),
                action: 'CREATE',
                field,
                oldValue: null,
                newValue: serialise(created[field]),
                orderId: extractOrderId(model, created),
                actorId: ctx?.userId ?? null,
                actorName: ctx?.userName ?? 'System',
                reason: ctx?.reason ?? null,
              })),
          );
        }

        if (trackedCreate?.createIsAnEvent) {
          // The most interesting columns of the new row, so the notification
          // can say "+150 pieces" rather than only "production recorded".
          for (const field of highlightFields(model, created)) {
            collectChange({
              model,
              action: 'CREATE',
              entityId: String(created.id ?? ''),
              orderId: extractOrderId(model, created),
              field,
              oldValue: null,
              newValue: serialise(created[field]),
              subjectHint: subjectHint(created),
            });
          }
        }
      }
      return result;
    }

    // ── Deletes ────────────────────────────────────────────────────────────
    if (action === 'delete' && (WATCHED_LIFECYCLE.has(model) || trackedCreate)) {
      const before = await findBefore(prisma, model, args.where);
      const result = await next(params);
      if (before) {
        const ctx = getRequestContext();
        collectChange({
          model,
          action: 'DELETE',
          entityId: String(before.id ?? ''),
          orderId: extractOrderId(model, before),
          field: 'record',
          oldValue: serialise(before.email ?? before.key ?? before.name ?? before.id),
          newValue: null,
          subjectHint: subjectHint(before),
        });
        if (!WATCHED_LIFECYCLE.has(model)) return result;
        writeRows(prisma, [{
          entityType: model,
          entityId: String(before.id ?? ''),
          action: 'DELETE',
          field: 'record',
          // Enough to identify what vanished, without the credential.
          oldValue: serialise(before.email ?? before.key ?? before.name ?? before.id),
          newValue: null,
          orderId: extractOrderId(model, before),
          actorId: ctx?.userId ?? null,
          actorName: ctx?.userName ?? 'System',
          reason: ctx?.reason ?? null,
        }]);
      }
      return result;
    }

    // Updates are audited for WATCHED models and announced for tracked ones.
    // The two sets overlap but are not the same: a MaterialStock balance is
    // worth telling the warehouse about and not worth keeping a field-level
    // forensic record of, because the MaterialMovement ledger already is one.
    const auditThis = WATCHED.has(model);
    const announceThis = trackedCreate != null;
    if (action !== 'update' || (!auditThis && !announceThis)) {
      return next(params);
    }

    // Snapshot before the write. One extra read per audited update: the cost of
    // knowing what actually changed.
    const before = await findBefore(prisma, model, args.where);

    const result = await next(params);

    if (!before || !result) return result;

    const ctx = getRequestContext();
    const after = result as Record<string, unknown>;
    const rows: Prisma.AuditTrailCreateManyInput[] = [];
    const orderId = extractOrderId(model, before);
    const hint = subjectHint(after) ?? subjectHint(before);

    for (const field of Object.keys((args.data ?? {}) as Record<string, unknown>)) {
      if (IGNORED_FIELDS.has(field)) continue;

      // A password change is recorded as an event; the value never is.
      if (REDACTED_FIELDS.has(field)) {
        if (announceThis) {
          collectChange({
            model, action: 'UPDATE', entityId: String(after.id ?? before.id ?? ''),
            orderId, field, oldValue: null, newValue: null, subjectHint: hint,
          });
        }
        if (!auditThis) continue;
        rows.push({
          entityType: model,
          entityId: String(after.id ?? before.id ?? ''),
          action: 'UPDATE',
          orderId,
          field,
          oldValue: '(redacted)',
          newValue: '(redacted)',
          actorId: ctx?.userId ?? null,
          actorName: ctx?.userName ?? 'System',
          reason: ctx?.reason ?? null,
        });
        continue;
      }

      const oldValue = serialise(before[field]);
      const newValue = serialise(after[field]);
      if (oldValue === newValue) continue;

      if (announceThis) {
        collectChange({
          model, action: 'UPDATE', entityId: String(after.id ?? before.id ?? ''),
          orderId, field, oldValue, newValue, subjectHint: hint,
        });
      }
      if (!auditThis) continue;

      rows.push({
        entityType: model,
        entityId: String(after.id ?? before.id ?? ''),
        action: 'UPDATE',
        orderId,
        field,
        oldValue,
        newValue,
        actorId: ctx?.userId ?? null,
        actorName: ctx?.userName ?? 'System',
        reason: ctx?.reason ?? null,
      });
    }

    writeRows(prisma, rows);
    return result;
  };
}

/**
 * Which columns of a freshly created row are worth announcing.
 *
 * A create has no "before", so listing every column would produce a wall of
 * "set to" lines. These are the ones that answer "what actually happened":
 * how many pieces, how much material, which document.
 */
const HIGHLIGHT_FIELDS: Record<string, string[]> = {
  ProductionRecord: ['qty', 'operation', 'date', 'line'],
  CuttingRecord: ['qty', 'date'],
  MaterialMovement: ['type', 'qty', 'reason'],
  MaterialReservation: ['qty'],
  MaterialIssue: ['qty', 'issuedToName'],
  StockRecord: ['colorName', 'sizeName', 'availableQty'],
  QualityAudit: ['result', 'availableQty', 'rejectedQty'],
  QualityDefect: ['defectType', 'qty'],
  Attachment: ['fileName', 'documentType'],
  CustomInstruction: ['title'],
  Approval: ['type', 'status'],
  ExternalOperation: ['operationType', 'qty', 'status'],
  Shipment: ['method', 'qty', 'status'],
  PackingList: ['reference'],
  Order: ['poNumber', 'orderName', 'season'],
  Task: ['title', 'status'],
  TaskComment: ['body'],
  BomItem: ['item', 'requiredQty', 'unit'],
  Material: ['name', 'type', 'unit'],
  ProformaInvoice: ['number', 'currency'],
  Marker: ['fabricName', 'layers'],
  User: ['name', 'email', 'department'],
};

function highlightFields(model: string, row: Record<string, unknown>): string[] {
  const named = HIGHLIGHT_FIELDS[model];
  if (named) return named.filter((f) => row[f] !== undefined && row[f] !== null);
  // No entry: fall back to a short, non-noisy slice so the event still says
  // something. Ids and timestamps are not information to a person.
  return Object.keys(row)
    .filter((f) => !IGNORED_FIELDS.has(f) && !REDACTED_FIELDS.has(f) && !/Id$|^id$/.test(f))
    .filter((f) => row[f] !== null && row[f] !== undefined)
    .slice(0, 4);
}

/**
 * A short name for the record a change happened to, taken from whichever
 * identifying column it has. Never an id: "PO 13506" tells somebody something,
 * "cmf3k2..." does not.
 */
function subjectHint(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  for (const key of ['poNumber', 'fileName', 'title', 'name', 'item', 'reference', 'cartonNumber', 'email', 'number']) {
    const v = row[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/** Read the row about to change, so the diff has a "before". */
async function findBefore(
  prisma: PrismaClient,
  model: string,
  where: unknown,
): Promise<Record<string, unknown> | null> {
  try {
    const delegate = (prisma as unknown as Record<string, { findUnique: (a: unknown) => Promise<unknown> }>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ];
    return (await delegate?.findUnique({ where })) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: audit logging must never break the operation it records.
 *
 * A failure is logged rather than swallowed. An audit trail described as "worth
 * keeping forever" that silently stops writing — a constraint violation, a full
 * disk — is worse than no audit trail, because it still looks complete.
 *
 * Known limitation: these rows are written on the base client, so an operation
 * that is rolled back by an enclosing `$transaction` leaves its audit rows
 * behind. Prisma's `$use` middleware is not given the transaction client;
 * closing this properly means moving to a `$extends` query extension, which is
 * a change across all nine transactional call sites rather than a local fix.
 */
function writeRows(prisma: PrismaClient, rows: Prisma.AuditTrailCreateManyInput[]): void {
  if (rows.length === 0) return;
  prisma.auditTrail.createMany({ data: rows }).catch((err: unknown) => {
    console.error('AUDIT WRITE FAILED — changes were made but not recorded:', err);
  });
}
