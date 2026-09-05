/**
 * Typed API client.
 *
 * Every method returns a DTO from @opsflow/shared, so a change to the wire
 * contract is a compile error in both the server and the client rather than a
 * runtime surprise.
 */

import type {
  OrderSummaryDto, OrderDetailDto, TaskDto, DashboardDto, FollowUpItemDto,
  MatrixResponseDto, NotificationDto, ActivityDto, ImportPreviewDto, Paginated,
  StockPosition, MaterialPosition, InventorySummary, ImportConcept, ColumnAnalysis,
  OrderStepsResult, Blocker, StageKey, StageStatus,
  NotificationPriority, ChangeCategory, ShipmentDto,
} from '@opsflow/shared';

const BASE = import.meta.env.VITE_API_URL ?? '/api';
const TOKEN_KEY = 'opsflow.token';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private browsing — the session simply won't persist */ }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  /** True for the business-rule refusals that deserve an explanatory UI. */
  get isRuleViolation(): boolean {
    return [
      'APPROVAL_REQUIRED', 'QUANTITY_RULE_VIOLATION',
      'TASK_PREREQUISITE_UNMET', 'OVERRIDE_REQUIRED',
    ].includes(this.code);
  }
}

interface RequestOptions extends RequestInit {
  /** Sent as X-Change-Reason; required for privileged overrides. */
  reason?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { reason, ...init } = options;
  const token = getToken();

  const headers: Record<string, string> = {
    ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(reason ? { 'X-Change-Reason': reason } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const e = body as { error?: string; code?: string; details?: unknown } | null;
    // An expired session should send the user to sign in, not show an error.
    if (res.status === 401) {
      setToken(null);
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    throw new ApiError(
      e?.error ?? `Request failed (${res.status})`,
      res.status,
      e?.code ?? 'UNKNOWN',
      e?.details,
    );
  }

  return body as T;
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, body?: unknown, reason?: string) =>
  request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), reason });
const patch = <T>(p: string, body: unknown, reason?: string) =>
  request<T>(p, { method: 'PATCH', body: JSON.stringify(body), reason });
const put = <T>(p: string, body: unknown) =>
  request<T>(p, { method: 'PUT', body: JSON.stringify(body) });
const del = (p: string) => request<void>(p, { method: 'DELETE' });

const qs = (params: Record<string, unknown>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

/** One thing that changed, as the feed and the order timeline show it. */
export interface ChangeEventDto {
  id: string;
  entityType: string;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  category: ChangeCategory;
  categoryLabel: string;
  subject: string | null;
  summary: string;
  priority: NotificationPriority;
  priorityLabel: string;
  orderId: string | null;
  orderPoNumber: string | null;
  orderName: string | null;
  actorId: string | null;
  actorName: string;
  link: string | null;
  reason: string | null;
  createdAt: string;
  fields: Array<{
    field: string;
    label: string;
    /** Null means genuinely not set — never a stand-in zero. */
    oldValue: string | null;
    newValue: string | null;
  }>;
}

export interface ChangeFiltersDto {
  actors: Array<{ id: string; name: string; count: number }>;
  categories: Array<{ key: ChangeCategory; label: string; count: number }>;
  priorities: Array<{ key: NotificationPriority; count: number }>;
}

export interface EmailDeliveriesDto {
  data: Array<{
    id: string;
    subject: string;
    recipientCount: number;
    recipients: string[];
    status: 'PENDING' | 'SENT' | 'FAILED';
    attempts: number;
    lastError: string | null;
    sentAt: string | null;
    nextAttemptAt: string;
    createdAt: string;
    changeEventId: string | null;
  }>;
  counts: Partial<Record<'PENDING' | 'SENT' | 'FAILED', number>>;
  /** Whether Microsoft 365 is set up. Never says what the settings *are*. */
  configured: boolean;
  missingSettings: string[];
}

/** Step 17, Database: reference information about the order itself. */
export interface OrderProvenanceDto {
  order: {
    id: string; poNumber: string; orderName: string; season: string;
    clientId: string; clientName: string;
    coordinator: { id: string; name: string; email: string } | null;
    createdAt: string; updatedAt: string;
    cachedStatus: string | null;
    cachedProgressPct: number | null;
    cachedStageKey: string | null;
  };
  counts: Record<string, number>;
  /** Null when the order was entered by hand rather than imported. */
  source: {
    importId: string;
    fileName: string;
    profile: string | null;
    confidence: number | null;
    importedAt: string;
    importedBy: { name: string; email: string } | null;
    sheets: unknown;
    mappings: unknown;
    issues: unknown;
  } | null;
}

export interface OrderStepsPayload extends OrderStepsResult {
  orderId: string;
  poNumber: string;
  blockers: Blocker[];
}

export interface AttachmentDto {
  id: string;
  fileName: string;
  documentType: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  stageKey: StageKey | null;
  uploadedByName: string;
  createdAt: string;
  downloadUrl: string;
}

export interface InstructionDto {
  id: string;
  title: string;
  /** Sanitised on the server. Rendered with dangerouslySetInnerHTML. */
  body: string;
  visibleTo: string[];
  position: number;
  attachmentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StockRecordDto {
  id: string;
  colorName: string;
  sizeName: string;
  availableQty: number;
  reservedQty: number;
  usedQty: number;
  location: string | null;
  notes: string | null;
  recordedAt: string;
}

export interface ProformaLineDto {
  id: string;
  description: string;
  quantity: number | null;
  unit: string;
  unitPrice: number | null;
  /** Null when the line has no quantity or no price — never a hopeful zero. */
  lineTotal: number | null;
  position: number;
}

export interface ProformaDto {
  id: string;
  number: string | null;
  date: string;
  consignee: string | null;
  billingAddress: string | null;
  email: string | null;
  vesselVoyage: string | null;
  containerSeal: string | null;
  shippingDate: string | null;
  shipmentFrom: string | null;
  shipmentTo: string | null;
  consolidatingVendor: string | null;
  currency: string;
  terms: string | null;
  sentAt: string | null;
  lines: ProformaLineDto[];
  grandTotal: number | null;
  incomplete: boolean;
  preparedBy?: { name: string } | null;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string; name: string; email: string; roleKey: string; roleLabel: string;
    department: string; permissions: string[]; avatarInitials: string;
    /** Mirrors the server: the flag AND the configured allowlist. */
    isSuperAdmin: boolean;
    /** True after an administrator reset the password. Blocks everything else. */
    mustChangePassword: boolean;
  };
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  department: string;
  roleKey: string;
  roleLabel: string;
  active: boolean;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  /** Failed sign-ins since the last success — runs across lockout windows. */
  failedLoginCount: number;
  lastLoginAt: string | null;
  createdAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
  disabledByName: string | null;
  createdByName: string | null;
  openTaskCount: number;
  orderCount: number;
}

export interface AuditRow {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actorId: string | null;
  actorName: string;
  reason: string | null;
  orderId: string | null;
  orderPoNumber: string | null;
  createdAt: string;
}

export interface ActivityRow {
  id: string;
  action: string;
  summary: string;
  actorId: string | null;
  actorName: string;
  entityType: string | null;
  entityId: string | null;
  orderId: string | null;
  orderPoNumber: string | null;
  createdAt: string;
}

/** What the importer worked out about a file it has not seen before. */
export interface ImportAnalysisDto extends ImportPreviewDto {
  analysis: {
    sheetName: string;
    headerRowIndex: number;
    columns: ColumnAnalysis[];
    layout: 'LONG' | 'WIDE' | 'UNKNOWN';
    sizeColumns: string[];
    readiness: { ready: boolean; missing: ImportConcept[]; unconfirmed: ColumnAnalysis[]; detected: ImportConcept[] };
    candidateSheets: Array<{ name: string; score: number; rows: number; headerRowIndex: number }>;
    checklist: Array<{ concept: ImportConcept; label: string; detected: boolean; columnHeader: string | null }>;
    rowsDetected: number;
  } | null;
}

export interface LayingRowDto {
  rowNumber: number;
  markerNumber: string | null;
  fabricName: string | null;
  fabricColor: string | null;
  panel: string | null;
  sizeRatio: string | null;
  layers: number | null;
  markerLengthM: number | null;
  markerWidthM: number | null;
  totalLengthM: number | null;
  nestPcs: number | null;
  efficiencyPct: number | null;
  wastagePct: number | null;
  fabricConsumptionM: number | null;
  cutDate: string | null;
  cutByName: string | null;
  poNumber: string | null;
}

/** What the Laying & Marking importer worked out about a file, scoped to one order. */
export interface LayingImportAnalysisDto {
  jobId: string;
  fileName: string;
  sheetName: string;
  candidateSheets: Array<{ name: string; rows: number }>;
  columns: ColumnAnalysis[];
  rows: LayingRowDto[];
  conflicts: Array<{
    key: string;
    existing: {
      id: string; markerNumber: string | null; fabricName: string; fabricColor: string | null;
      layers: number; markerLengthM: string; totalLengthM: string | null;
    };
  }>;
  issues: Array<{ level: 'ERROR' | 'WARNING' | 'INFO'; field: string | null; sheet: string | null; cell: string | null; message: string }>;
  detectedPoNumbers: string[];
  priorImportExists: boolean;
  canCommit: boolean;
}

export interface MaterialRow {
  id: string;
  code: string | null;
  name: string;
  type: string;
  unit: string;
  colorName: string | null;
  widthCm: number | null;
  composition: string | null;
  gsm: number | null;
  sizeLabel: string | null;
  supplierName: string | null;
  minimumQty: number | null;
  unitCostUsd: number | null;
  active: boolean;
  notes: string | null;
  position: StockPosition;
  locations: Array<{ locationId: string | null; locationName: string | null; qty: number; binRef: string | null }>;
  reservations: Array<{
    id: string; orderId: string; poNumber: string; orderName: string;
    qty: number; consumedQty: number; outstandingQty: number;
  }>;
}

export interface MovementRow {
  id: string;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  type: string;
  qty: number;
  signedQty: number;
  unit: string;
  balanceAfter: number;
  orderId: string | null;
  orderPoNumber: string | null;
  reason: string | null;
  batchLot: string | null;
  stage: string | null;
  actorName: string;
  occurredAt: string;
}

export interface ReservationRow {
  id: string;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  materialType: string;
  orderId: string;
  poNumber: string;
  orderName: string;
  requiredDeliveryDate: string | null;
  qty: number;
  consumedQty: number;
  outstandingQty: number;
  unit: string;
  status: string;
  reservedByName: string | null;
  createdAt: string;
}

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const api = {
  auth: {
    login: (email: string, password: string) => post<LoginResponse>('/auth/login', { email, password }),
    me: () => get<LoginResponse['user']>('/auth/me'),
    changePassword: (currentPassword: string, newPassword: string) =>
      post<{ ok: true }>('/auth/change-password', { currentPassword, newPassword }),
  },

  admin: {
    users: () => get<{ data: AdminUser[] }>('/admin/users'),
    user: (id: string) => get<AdminUser>(`/admin/users/${id}`),
    createUser: (body: {
      name: string; email: string; roleKey: string; department: string;
      password?: string; phone?: string; isSuperAdmin?: boolean;
    }) => post<{ user: AdminUser; temporaryPassword: string | null }>('/admin/users', body),
    updateUser: (id: string, body: { name?: string; department?: string; phone?: string | null }) =>
      patch<AdminUser>(`/admin/users/${id}`, body),
    disableUser: (id: string, reason?: string) =>
      post<AdminUser>(`/admin/users/${id}/disable`, { reason }),
    enableUser: (id: string) => post<AdminUser>(`/admin/users/${id}/enable`),
    resetPassword: (id: string) =>
      post<{ user: AdminUser; temporaryPassword: string }>(`/admin/users/${id}/reset-password`),
    unlockUser: (id: string) => post<AdminUser>(`/admin/users/${id}/unlock`),
    changeRole: (id: string, roleKey: string) => post<AdminUser>(`/admin/users/${id}/role`, { roleKey }),
    setSuperAdmin: (id: string, isSuperAdmin: boolean) =>
      post<AdminUser>(`/admin/users/${id}/super-admin`, { isSuperAdmin }),
    roles: () => get<{ data: Array<{ key: string; label: string; permissionCount: number; userCount: number }> }>('/admin/roles'),
    allowlist: () => get<{
      allowlist: string[];
      holders: Array<{ email: string; name: string; active: boolean; effective: boolean }>;
    }>('/admin/super-admin-allowlist'),
    audit: (params: Record<string, unknown> = {}) => get<Page<AuditRow>>(`/admin/audit${qs(params)}`),
    activity: (params: Record<string, unknown> = {}) => get<Page<ActivityRow>>(`/admin/activity${qs(params)}`),
    auditFacets: () => get<{
      entityTypes: string[]; auditActions: string[]; activityActions: string[];
      actors: Array<{ id: string; name: string }>;
    }>('/admin/audit/facets'),
  },

  inventory: {
    meta: () => get<{
      types: Array<{ value: string; label: string; fields: readonly string[] }>;
      units: string[];
      movementTypes: Array<{ value: string; label: string }>;
      statuses: string[];
      locations: Array<{ id: string; name: string; code: string | null; kind: string }>;
    }>('/inventory/meta'),

    materials: (filters: Record<string, unknown> = {}) =>
      get<{ data: MaterialRow[]; summary: InventorySummary }>(`/inventory/materials${qs(filters)}`),
    material: (id: string) => get<MaterialRow>(`/inventory/materials/${id}`),
    materialMovements: (id: string, limit = 100) =>
      get<{ data: MovementRow[] }>(`/inventory/materials/${id}/movements${qs({ limit })}`),
    createMaterial: (body: Record<string, unknown>) => post<MaterialRow>('/inventory/materials', body),
    updateMaterial: (id: string, body: Record<string, unknown>) => patch<MaterialRow>(`/inventory/materials/${id}`, body),

    receive: (body: { materialId: string; qty: number; unit?: string; batchLot?: string; reference?: string; unitCostUsd?: number }) =>
      post<MaterialRow>('/inventory/receipts', body),
    adjust: (body: { materialId: string; qty: number; reason: string }) =>
      post<MaterialRow>('/inventory/adjustments', body),
    wastage: (body: { materialId: string; qty: number; orderId?: string | null; reason: string }) =>
      post<MaterialRow>('/inventory/wastage', body),

    reserve: (body: {
      materialId: string; orderId: string; qty: number; bomItemId?: string | null;
      allowPartial?: boolean; notes?: string;
    }) => post<{ reservation: { id: string; qty: number }; material: MaterialRow; partial: boolean }>('/inventory/reservations', body),
    releaseReservation: (id: string, reason?: string) =>
      post<MaterialRow>(`/inventory/reservations/${id}/release`, { reason }),
    reservations: (filters: Record<string, unknown> = {}) =>
      get<{ data: ReservationRow[] }>(`/inventory/reservations${qs(filters)}`),

    issue: (body: {
      materialId: string; orderId: string; qty: number; bomItemId?: string | null;
      stage?: string | null; issuedToName?: string; batchLot?: string; reason?: string;
    }) => post<{ material: MaterialRow; drawnFromReservation: number; drawnFromFree: number }>('/inventory/issues', body),
    return: (body: { materialId: string; orderId: string; qty: number; bomItemId?: string | null; reason?: string }) =>
      post<MaterialRow>('/inventory/returns', body),

    movements: (filters: Record<string, unknown> = {}) =>
      get<{ data: MovementRow[] }>(`/inventory/movements${qs(filters)}`),

    orderPosition: (orderId: string) => get<MaterialPosition>(`/inventory/orders/${orderId}/position`),
    reserveOrder: (orderId: string) => post<{
      reserved: Array<{ materialName: string; qty: number; unit: string }>;
      short: Array<{ materialName: string; shortQty: number; unit: string }>;
      skipped: number;
    }>(`/inventory/orders/${orderId}/reserve`),
    linkBom: (bomItemId: string, materialId: string | null) =>
      post<MaterialPosition>(`/inventory/bom/${bomItemId}/link`, { materialId }),

    reconcile: (fix = false) => post<{
      checked: number;
      drifted: Array<{ materialId: string; materialName: string; stored: number; ledger: number; difference: number }>;
      fixed: boolean;
    }>('/inventory/reconcile', { fix }),
  },

  dashboard: {
    get: () => get<DashboardDto>('/dashboard'),
    followUp: (mine = false) =>
      get<{ data: FollowUpItemDto[]; counts: { critical: number; warning: number; attention: number } }>(
        `/dashboard/follow-up${qs({ mine })}`,
      ),
    notifications: () => get<{
      data: NotificationDto[];
      unreadCount: number;
      unreadByPriority: Partial<Record<NotificationPriority, number>>;
    }>('/dashboard/notifications'),
    markRead: (id: string) => post<{ ok: true }>(`/dashboard/notifications/${id}/read`),
    markAllRead: () => post<{ ok: true }>('/dashboard/notifications/read-all'),
  },

  /**
   * The change feed. Read-only by design — a client cannot post a change into
   * it and cannot choose whose name a change carries. The backend takes the
   * actor from the authenticated session, always.
   */
  changes: {
    list: (filters: Record<string, unknown> = {}) =>
      get<{
        data: ChangeEventDto[];
        page: number; pageSize: number; total: number; totalPages: number;
      }>(`/changes${qs(filters)}`),
    filters: () => get<ChangeFiltersDto>('/changes/filters'),
    forOrder: (orderId: string, limit = 200) =>
      get<{ data: ChangeEventDto[]; orderId: string; poNumber: string }>(
        `/changes/order/${orderId}${qs({ limit })}`,
      ),
    emails: (status?: string) => get<EmailDeliveriesDto>(`/changes/emails${qs({ status })}`),
    retryEmails: () => post<{ attempted: number; sent: number; missingSettings: string[] }>(
      '/changes/emails/retry',
    ),
    sendTestEmail: () => post<{
      sentTo: string; status: string; attempts: number; error: string | null; note: string;
    }>('/changes/emails/test'),
  },

  notificationPreferences: {
    list: () => get<{
      data: Array<{
        category: ChangeCategory; label: string;
        inApp: boolean; email: boolean; minPriority: NotificationPriority;
      }>;
    }>('/notification-preferences'),
    save: (rows: Array<{ category: ChangeCategory; inApp: boolean; email: boolean; minPriority: NotificationPriority }>) =>
      put<{ ok: true }>('/notification-preferences', rows),
  },

  orders: {
    list: (filters: Record<string, unknown> = {}) => get<Paginated<OrderSummaryDto>>(`/orders${qs(filters)}`),
    search: (q: string) => get<{ data: OrderSummaryDto[] }>(`/orders/search${qs({ q })}`),
    get: (id: string) => get<OrderDetailDto>(`/orders/${id}`),
    create: (body: unknown) => post<OrderDetailDto>('/orders', body),
    update: (id: string, body: unknown) => patch<OrderDetailDto>(`/orders/${id}`, body),
    matrix: (id: string) => get<MatrixResponseDto>(`/orders/${id}/matrix`),
    setMatrix: (id: string, ledger: string, cells: Array<{ orderColorId: string; orderSizeId: string; qty: number }>) =>
      put<OrderDetailDto>(`/orders/${id}/matrix`, { ledger, cells }),
    generateCut: (id: string) => post<OrderDetailDto>(`/orders/${id}/matrix/generate-cut`),
    tasks: (id: string) => get<{ data: TaskDto[] }>(`/orders/${id}/tasks`),
    activity: (id: string, limit = 50) => get<{ data: ActivityDto[] }>(`/orders/${id}/activity${qs({ limit })}`),
    auditTrail: (id: string) => get<{ data: unknown[] }>(`/orders/${id}/audit-trail`),
    attachments: (id: string) => get<{ data: AttachmentDto[] }>(`/orders/${id}/attachments`),
    /** Step 17 — where the order came from and what it is made of. */
    provenance: (id: string) => get<OrderProvenanceDto>(`/orders/${id}/provenance`),
  },

  /**
   * The guided routine. Every one of these returns the *whole* step list, not
   * just the step that changed: completing one step can unblock another three,
   * and a rail that only refreshed the row you clicked would show that
   * incorrectly until the next reload.
   */
  steps: {
    list: (orderId: string) => get<{ data: OrderStepsPayload }>(`/orders/${orderId}/steps`),
    setStatus: (orderId: string, stageKey: StageKey, body: {
      status: StageStatus | null; reason?: string; notes?: string;
    }) => post<{ data: OrderStepsPayload }>(`/orders/${orderId}/steps/${stageKey}/status`, body),
    start: (orderId: string, stageKey: StageKey) =>
      post<{ data: OrderStepsPayload }>(`/orders/${orderId}/steps/${stageKey}/start`),

    upload: (orderId: string, file: File, documentType: string, stageKey?: StageKey) => {
      const form = new FormData();
      form.append('file', file);
      form.append('documentType', documentType);
      if (stageKey) form.append('stageKey', stageKey);
      // No Content-Type header: the browser must set the multipart boundary.
      return request<{ data: AttachmentDto }>(`/orders/${orderId}/attachments`, {
        method: 'POST', body: form,
      });
    },
    removeAttachment: (orderId: string, attachmentId: string) =>
      del(`/orders/${orderId}/attachments/${attachmentId}`),

    instructions: (orderId: string) =>
      get<{ data: InstructionDto[] }>(`/orders/${orderId}/instructions`),
    addInstruction: (orderId: string, body: { title: string; body: string; visibleTo: string[] }) =>
      post<{ data: InstructionDto }>(`/orders/${orderId}/instructions`, body),
    updateInstruction: (orderId: string, id: string, body: Partial<{ title: string; body: string; visibleTo: string[] }>) =>
      patch<{ data: InstructionDto }>(`/orders/${orderId}/instructions/${id}`, body),
    removeInstruction: (orderId: string, id: string) =>
      del(`/orders/${orderId}/instructions/${id}`),

    stock: (orderId: string) => get<{
      data: StockRecordDto[]; recorded: boolean; totalAvailable: number;
    }>(`/orders/${orderId}/stock`),
    recordStock: (orderId: string, body: {
      colorName: string; sizeName: string; availableQty: number;
      reservedQty?: number; usedQty?: number; location?: string; notes?: string;
    }) => post<{ data: StockRecordDto }>(`/orders/${orderId}/stock`, body),
    removeStock: (orderId: string, recordId: string) => del(`/orders/${orderId}/stock/${recordId}`),

    proforma: (orderId: string) => get<{ data: ProformaDto | null }>(`/orders/${orderId}/proforma`),
    saveProforma: (orderId: string, body: unknown) =>
      put<{ data: ProformaDto }>(`/orders/${orderId}/proforma`, body),
    sendProforma: (orderId: string) => post<{ data: ProformaDto }>(`/orders/${orderId}/proforma/send`),
  },

  tasks: {
    mine: (includeCompleted = false) => get<{ data: TaskDto[] }>(`/tasks/mine${qs({ includeCompleted })}`),
    list: (filters: Record<string, unknown> = {}) => get<{ data: TaskDto[] }>(`/tasks${qs(filters)}`),
    start: (id: string) => post<TaskDto>(`/tasks/${id}/start`),
    complete: (id: string, body?: { notes?: string; actualMinutes?: number }) =>
      post<TaskDto>(`/tasks/${id}/complete`, body ?? {}),
    reopen: (id: string) => post<TaskDto>(`/tasks/${id}/reopen`),
    assign: (id: string, assigneeId: string | null) => post<TaskDto>(`/tasks/${id}/assign`, { assigneeId }),
    update: (id: string, body: unknown) => patch<TaskDto>(`/tasks/${id}`, body),
    comments: (id: string) => get<{ data: Array<{ id: string; body: string; authorName: string; createdAt: string }> }>(`/tasks/${id}/comments`),
    comment: (id: string, body: string) => post<unknown>(`/tasks/${id}/comments`, { body }),
  },

  production: {
    get: (orderId: string) => get<{
      records: Array<{ id: string; date: string; operation: string; qty: number; line: string | null; team: string | null; notes: string | null }>;
      analytics: OrderDetailDto['production'];
      byOperation: Array<{ operation: string; qty: number; days: number; avgPerDay: number | null }>;
      byLine: Array<{ line: string; qty: number; days: number; avgPerDay: number | null }>;
    }>(`/production/${orderId}`),
    record: (orderId: string, body: unknown) => post<unknown>(`/production/${orderId}`, body),
    remove: (recordId: string) => del(`/production/record/${recordId}`),
  },

  materials: {
    bom: (orderId: string) => get<{
      summary: NonNullable<OrderDetailDto['bom']>;
      groups: Array<{ category: string; items: unknown[]; shortCount: number }>;
      items: unknown[];
    }>(`/materials/${orderId}/bom`),
    addBomItem: (orderId: string, body: unknown) => post<{ id: string }>(`/materials/${orderId}/bom`, body),
    updateBomItem: (id: string, body: unknown) => patch<unknown>(`/materials/bom/${id}`, body),
    removeBomItem: (id: string) => del(`/materials/bom/${id}`),
    issue: (bomItemId: string, body: { qty: number; issuedToName?: string; notes?: string }) =>
      post<{ id: string; newIssuedQty: number; stillShort: number }>(`/materials/bom/${bomItemId}/issue`, body),
    markers: (orderId: string) => get<{ plan: unknown; fabrics: unknown[]; cutting: unknown[] }>(`/materials/${orderId}/markers`),
    addMarker: (orderId: string, body: unknown) => post<{ id: string }>(`/materials/${orderId}/markers`, body),
    removeMarker: (id: string) => del(`/materials/markers/${id}`),
    recordCutting: (orderId: string, body: unknown) => post<{ id: string }>(`/materials/${orderId}/cutting`, body),
  },

  external: {
    operations: (orderId: string) => get<{ data: unknown[] }>(`/external/${orderId}/operations`),
    addOperation: (orderId: string, body: unknown) => post<{ id: string }>(`/external/${orderId}/operations`, body),
    setStatus: (opId: string, body: unknown) => post<{ ok: true }>(`/external/operations/${opId}/status`, body),
    approvals: (orderId: string) => get<{ data: unknown[] }>(`/external/${orderId}/approvals`),
    requestApproval: (orderId: string, body: unknown) => post<{ id: string }>(`/external/${orderId}/approvals`, body),
    recordApproval: (id: string, body: unknown) => post<{ ok: true }>(`/external/approvals/${id}/record`, body),
    pendingApprovals: () => get<{ data: unknown[] }>('/external/approvals/pending'),
  },

  quality: {
    list: (orderId: string) => get<{ data: unknown[] }>(`/quality/${orderId}`),
    aql: (qty?: number) => get<{ table: unknown[]; match: unknown; defectCategories: string[] }>(`/quality/aql${qs({ qty })}`),
    record: (orderId: string, body: unknown) => post<{ id: string; result: string }>(`/quality/${orderId}`, body),
    closeCorrectiveAction: (auditId: string, note?: string) =>
      post<{ ok: true }>(`/quality/audit/${auditId}/close-corrective-action`, { note }),
  },

  packing: {
    lists: (orderId: string) => get<{ data: unknown[] }>(`/packing/${orderId}`),
    createList: (orderId: string, body?: unknown) => post<{ id: string }>(`/packing/${orderId}`, body ?? {}),
    addCarton: (listId: string, body: unknown) => post<{ id: string }>(`/packing/list/${listId}/cartons`, body),
    approve: (listId: string) => post<{ ok: true }>(`/packing/list/${listId}/approve`),
    shipments: (orderId: string) => get<{ data: ShipmentDto[] }>(`/packing/${orderId}/shipments`),
    createShipment: (orderId: string, body: unknown, reason?: string) =>
      post<{ id: string; overrideApplied: boolean }>(`/packing/${orderId}/shipments`, body, reason),
  },

  reference: {
    lookups: () => get<{
      colors: Array<{ id: string; name: string; hex: string | null; position: number }>;
      sizes: Array<{ id: string; name: string; longName: string | null; position: number }>;
      values: Record<string, Array<{ id: string; value: string; valueAr: string | null }>>;
      clients: Array<{ id: string; name: string; code: string | null; shippingAddress: string | null; billingAddress: string | null }>;
      factories: Array<{ id: string; name: string; code: string | null; isExternal: boolean }>;
      // Names and departments only — enough to assign a task. Email addresses
      // live behind `user:manage`, in the admin area.
      users: Array<{ id: string; name: string; department: string; roleKey: string; roleLabel: string }>;
      roles: Array<{ key: string; label: string }>;
    }>('/lookups'),
    clients: () => get<{ data: unknown[] }>('/clients'),
    factories: () => get<{ data: unknown[] }>('/factories'),
    users: () => get<{ data: unknown[] }>('/users'),
    report: (kind: string, params: Record<string, unknown> = {}) =>
      get<{ kind: string; rows: unknown[] }>(`/reports/${kind}${qs(params)}`),
  },

  import: {
    profiles: () => get<{ data: unknown[] }>('/import/profiles'),
    upload: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return request<ImportAnalysisDto>('/import/upload', { method: 'POST', body: fd });
    },
    job: (jobId: string) => get<ImportPreviewDto>(`/import/${jobId}`),
    /** Re-analyse with the coordinator's column corrections applied. */
    remap: (jobId: string, body: {
      sheetName?: string;
      columnMapping?: Record<string, string>;
      fieldOverrides?: Record<string, string | number | null>;
    }) => post<ImportAnalysisDto>(`/import/${jobId}/remap`, body),
    commit: (jobId: string, body?: {
      generateCutOrder?: boolean;
      overrides?: Record<string, unknown>;
      columnMapping?: Record<string, string>;
      sheetName?: string;
      reserveMaterials?: boolean;
    }) => post<{
      orderId: string; poNumber: string; order: OrderDetailDto;
      reservation: {
        reserved: Array<{ materialName: string; qty: number; unit: string }>;
        short: Array<{ materialName: string; shortQty: number; unit: string }>;
        skipped: number;
      } | null;
    }>(`/import/${jobId}/commit`, body ?? {}),
    saveMapping: (jobId: string, body: { clientId?: string | null; label?: string }) =>
      post<{ id: string; label: string; columns: number }>(`/import/${jobId}/save-mapping`, body),
    mappings: (clientId?: string) => get<{
      data: Array<{ id: string; label: string; clientId: string | null; clientName: string | null; columns: number; useCount: number; lastUsedAt: string | null }>;
    }>(`/import/mappings${qs({ clientId })}`),
    deleteMapping: (id: string) => del(`/import/mappings/${id}`),
    history: () => get<{ data: unknown[] }>('/import'),
  },

  layingImport: {
    upload: (orderId: string, file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return request<LayingImportAnalysisDto>(`/orders/${orderId}/laying-import/upload`, { method: 'POST', body: fd });
    },
    remap: (orderId: string, jobId: string, body: { sheetName?: string; columnMapping?: Record<string, string> }) =>
      post<LayingImportAnalysisDto>(`/orders/${orderId}/laying-import/${jobId}/remap`, body),
    saveMapping: (orderId: string, jobId: string, label?: string) =>
      post<{ id: string }>(`/orders/${orderId}/laying-import/${jobId}/save-mapping`, { label }),
    commit: (orderId: string, jobId: string, resolutions: Record<string, 'KEEP' | 'REPLACE' | 'ADD_NEW'>) =>
      post<{
        markersCreated: number; markersUpdated: number; markersSkipped: number;
        cuttingRecordsCreated: number; fabricRecordsCreated: number;
      }>(`/orders/${orderId}/laying-import/${jobId}/commit`, { resolutions }),
    history: (orderId: string) => get<{
      data: Array<{
        id: string; fileName: string; status: string; createdAt: string; committedAt: string | null;
        uploadedBy: { name: string; email: string }; errorMessage: string | null; rowCount: number;
      }>;
    }>(`/orders/${orderId}/laying-import`),
  },
};
