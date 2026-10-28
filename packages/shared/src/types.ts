/**
 * Wire DTOs shared by the API and the web client. These are the contract; the
 * Prisma models are the storage. Keeping them separate means a schema change
 * does not silently reshape the API.
 */

import type {
  InvoiceKind, InvoiceStatus, InvoiceLineKind,
  OrderStatus, Health, Priority, TaskStatus, StageKey, StageStatus, QtyLedger,
  ApprovalStatus, ApprovalType, ExternalOpStatus, ProductionOperation, ShipmentStatus,
  BomCategory, Department, NotificationPriority,
} from './enums.js';
import type { Alert } from './calc/alerts.js';
import type { StageProgress } from './calc/progress.js';
import type { ProductionAnalytics } from './calc/production.js';
import type {
  DayRange, OutputSummary, Trend, DefectRateSummary, FabricUtilisationSummary, OperationOutput, FactoryOverview,
  LabourSummary, DeliverySummary, RftSummary,
} from './calc/productivity.js';
import type { BomSummary } from './calc/materials.js';
import type { CostingResult } from './calc/costing.js';
import type { CostingOverviewRow, CostingOverviewSummary } from './calc/costing-overview.js';
import type { MaterialPosition, ConsumptionVariance } from './calc/inventory.js';
import type { Blocker } from './calc/workflow-gates.js';
import type { QuantityMatrix, FunnelStep, ColorProgress, CutVariance, StockDeduction } from './calc/quantities.js';
import type { ProformaSheetSettings } from './calc/proforma-sheet.js';

export interface UserDto {
  id: string;
  name: string;
  email: string;
  roleKey: string;
  roleLabel: string;
  department: Department;
  permissions: string[];
  avatarInitials: string;
}

export interface ClientDto { id: string; name: string; code: string | null; shippingAddress: string | null; billingAddress: string | null; }
export interface FactoryDto { id: string; name: string; code: string | null; address: string | null; isExternal: boolean; }

/** The row shape used by the Orders table and the dashboard's attention list. */
export interface OrderSummaryDto {
  id: string;
  poNumber: string;
  orderName: string;
  clientId: string;
  clientName: string;
  season: string;
  coordinatorName: string | null;
  factoryName: string | null;
  itemType: string | null;
  styleNumber: string | null;
  fabric: string | null;
  shippingMethod: string | null;
  orderQty: number;
  producedQty: number;
  packedQty: number;
  shippedQty: number;
  currentStage: StageKey | null;
  currentStageLabel: string | null;
  progressPct: number;
  status: OrderStatus;
  health: Health;
  priority: Priority;
  poDate: string | null;
  promisedShippingDate: string | null;
  requiredDeliveryDate: string | null;
  daysRemaining: number | null;
  nextAction: string;
  nextActionDepartment: string | null;
  alertCounts: { critical: number; warning: number; attention: number };
  /** How many stage requirements are unmet. Drives "3 blocked orders". */
  blockerCount: number;
  /** The single most pressing one, so a list row can say *why* without expanding. */
  topBlocker: string | null;
  /** Materials genuinely short of stock, as opposed to merely unreserved. */
  materialShortCount: number;
  updatedAt: string;
}

/** Everything the Order Workspace Overview tab needs, in one request. */
export interface OrderDetailDto {
  id: string;
  poNumber: string;
  orderName: string;
  season: string;
  itemType: string | null;
  gender: string | null;
  styleNumber: string | null;
  fit: string | null;
  blockPattern: string | null;
  fabric: string | null;
  shippingMethod: string | null;
  pricePerPieceUsd: number | null;
  /** Standard allowed minutes to sew one garment. Null until entered. */
  samMinutes: number | null;
  cutPercentage: number;
  accessoryPercentage: number;
  externalReference: string | null;
  externalWorkSort: string | null;
  externalWorkType: string | null;
  /// External Order_Ex.Op shows three fabric slots and two supplier dates.
  fabric2: string | null;
  fabric3: string | null;
  fabricDeliveryToSupplier: string | null;
  supplierDeliveryDate: string | null;
  poDate: string | null;
  /// The factory's own PO date, distinct from the customer's.
  internalPoDate: string | null;
  /// Null is "nobody has said yet", which is not the same as "no".
  productionSample: boolean | null;
  /// A comment typed instead of Yes or No; when set it is the answer shown.
  productionSampleNote: string | null;
  /// The order's own addresses. Null means it inherits the client's, which
  /// `client.shippingAddress` already resolves for display.
  shippingAddress: string | null;
  billingAddress: string | null;
  promisedShippingDate: string | null;
  requiredDeliveryDate: string | null;
  cancelled: boolean;
  priority: Priority;

  client: ClientDto;
  factory: FactoryDto | null;
  externalFactory: FactoryDto | null;
  coordinator: UserDto | null;
  outsideWorkManager: UserDto | null;

  notes: {
    general: string | null;
    spread: string | null;
    cut: string | null;
    packing: string | null;
    external: string | null;
  };

  // Derived — computed by @opsflow/shared, never stored.
  status: OrderStatus;
  health: Health;
  progressPct: number;
  currentStage: StageKey | null;
  nextAction: { text: string; department: string | null; taskId: string | null };
  stages: StageProgress[];
  alerts: Alert[];
  funnel: FunnelStep[];
  colorProgress: ColorProgress[];
  cutVariance: CutVariance;
  stockDeduction: StockDeduction;
  production: ProductionAnalytics;
  /**
   * Pieces produced, as the rest of the order counts them: the in-line ledger
   * or the sewing records, whichever is further along. `production.producedQty`
   * is sewing only; this is the figure the shipment limit is checked against.
   */
  producedQty: number;
  bom: BomSummary | null;
  /** Requirements against real stock: reserved, reservable, genuinely short. */
  materials: MaterialPosition | null;
  /** Every unmet stage requirement, derived at read time — never stored. */
  blockers: Blocker[];
  warnings: Blocker[];
  /** Stages whose requirements are all met, so the coordinator can start them. */
  readyStages: StageKey[];
  /** Expected against actual consumption, per material with a known rate. */
  consumption: ConsumptionVariance[];
  /**
   * `hasRecord` says whether anybody has entered the factory's own figures yet;
   * everything derivable from the order itself is filled in either way.
   *
   * Null for a caller without `costing:read`. The block carries the unit cost,
   * the profit and the margin, which the costing permission exists to guard,
   * and the order detail is readable by every role.
   */
  costing: CostingResult | null;
  qualityPassPct: number | null;

  counts: {
    openTasks: number;
    overdueTasks: number;
    openExternalOps: number;
    attachments: number;
    blockers: number;
  };
  updatedAt: string;
}

export interface MatrixResponseDto {
  colors: Array<{ id: string; name: string; hex: string | null; position: number }>;
  sizes: Array<{ id: string; name: string; position: number }>;
  matrices: Partial<Record<QtyLedger, QuantityMatrix>>;
  totals: Record<QtyLedger, number>;
}

export interface TaskDto {
  id: string;
  orderId: string;
  orderPoNumber: string;
  orderName: string;
  stageKey: StageKey;
  stageLabel: string;
  title: string;
  requirementEn: string | null;
  requirementAr: string | null;
  department: Department;
  departmentLabel: string;
  assignee: { id: string; name: string } | null;
  status: TaskStatus;
  priority: Priority;
  sequence: number;
  estimatedMinutes: number | null;
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: { id: string; name: string } | null;
  notes: string | null;
  attachmentCount: number;
  commentCount: number;
  daysRemaining: number | null;
  isOverdue: boolean;
  blockedReason: string | null;
}

export interface StageDetailDto {
  stageKey: StageKey;
  label: string;
  status: StageStatus;
  progressPct: number;
  responsibleDepartments: Department[];
  startedAt: string | null;
  dueDate: string | null;
  completedAt: string | null;
  notes: string | null;
  tasks: TaskDto[];
  attachmentCount: number;
}

export interface BomItemDto {
  id: string;
  category: BomCategory;
  position: string | null;
  consumptionPerPiece: number | null;
  item: string;
  description: string | null;
  color: string | null;
  requiredQty: number;
  unit: string;
  issuedQty: number;
  shortage: number;
  shortQty: number;
  coveragePct: number | null;
  status: 'NOT_ISSUED' | 'PARTIAL' | 'COMPLETE' | 'OVER_ISSUED';
  issuedBy: string | null;
  issuedTo: string | null;
  issuedAt: string | null;
}

export interface ExternalOperationDto {
  id: string;
  externalFactoryName: string | null;
  externalReference: string | null;
  operationType: string;
  operationTypeAr: string | null;
  qty: number;
  unitPriceUsd: number | null;
  totalPriceUsd: number | null;
  sentDate: string | null;
  expectedReturnDate: string | null;
  actualReturnDate: string | null;
  status: ExternalOpStatus;
  requiresApproval: boolean;
  approvalCleared: boolean;
  approvalStatus: ApprovalStatus | null;
  notes: string | null;
  daysLate: number | null;
  colors: string[];
}

export interface ApprovalDto {
  id: string;
  type: ApprovalType;
  typeLabel: string;
  status: ApprovalStatus;
  blocking: boolean;
  requestedDate: string | null;
  requestedByName: string | null;
  sentTo: string | null;
  approvedDate: string | null;
  approvedByName: string | null;
  comment: string | null;
  attachmentCount: number;
  daysOutstanding: number | null;
}

export interface ProductionRecordDto {
  id: string;
  date: string;
  operation: ProductionOperation;
  qty: number;
  line: string | null;
  team: string | null;
  notes: string | null;
  recordedByName: string | null;
}

export interface PackingCartonDto {
  id: string;
  cartonNumber: string;
  cartonSize: string | null;
  colorName: string | null;
  sizeName: string | null;
  qty: number;
  grossWeightKg: number | null;
  netWeightKg: number | null;
}

export interface ShipmentDto {
  id: string;
  method: string | null;
  status: ShipmentStatus;
  promisedShippingDate: string | null;
  requiredDeliveryDate: string | null;
  actualShippingDate: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  notes: string | null;
  qty: number;
}

export interface ActivityDto {
  id: string;
  orderId: string | null;
  actorName: string;
  actorInitials: string;
  action: string;
  summary: string;
  entityType: string | null;
  entityId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditTrailDto {
  id: string;
  entityType: string;
  entityId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actorName: string;
  reason: string | null;
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string | null;
  /** Derived from what changed, on the server. Drives colour and ordering. */
  priority: NotificationPriority;
  orderId: string | null;
  orderPoNumber: string | null;
  /** The change this came from, when there was one. */
  changeEventId: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
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
  /** A link the browser can open directly — signed and short-lived. */
  downloadUrl: string;
  /**
   * Whether the bytes are still stored.
   *
   * False for rows whose file was written to a container's own disk before
   * storage moved into the database: the record survived, the file did not.
   * Reported so a screen can say so rather than offering a link that fails.
   */
  available: boolean;
}

/** Dashboard payload — one request populates every card and the attention list. */
/** One thing to do, with somewhere to go and something to press. */
export interface ActionItemDto {
  id: string;
  orderId: string;
  poNumber: string;
  orderName: string;
  severity: 'CRITICAL' | 'WARNING' | 'ATTENTION';
  title: string;
  detail: string;
  actionLabel: string;
  tab: string;
  /** True when the signed-in user coordinates this order. Sorts to the top. */
  mine: boolean;
  daysRemaining: number | null;
}

export interface DashboardDto {
  cards: {
    totalActive: number;
    dueSoon: number;
    late: number;
    /** Orders with at least one unmet stage requirement. */
    blocked: number;
    atRisk: number;
    onTrack: number;
    materialShortages: number;
    inProduction: number;
    waitingMaterials: number;
    waitingExternal: number;
    waitingQuality: number;
    readyForPacking: number;
    readyToShip: number;
  };
  actionItems: ActionItemDto[];
  actionItemCounts: { total: number; mine: number; critical: number };
  ordersRequiringAttention: OrderSummaryDto[];
  myOpenTasks: TaskDto[];
  recentActivity: ActivityDto[];
  productionTrend: Array<{ date: string; qty: number }>;
  statusBreakdown: Array<{ status: OrderStatus; count: number }>;
}

// --- Factory productivity (Phase 1: existing data only) --------------------

/** An order that produced something in the period, with what it produced. */
export interface ProductivityOrderRowDto {
  orderId: string;
  poNumber: string;
  orderName: string;
  clientName: string;
  factoryName: string | null;
  /** Standard allowed minutes per garment, when the order has one. */
  samMinutes: number | null;
  byOperation: OperationOutput;
  primary: number | null;
  recordedDays: number;
  recordCount: number;
}

/** A factory day log as stored: what was on the floor that day. */
export interface ProductivityDayLogDto {
  date: string;
  operators: number | null;
  helpers: number | null;
  workingMinutes: number | null;
  machinesRunning: number | null;
  notes: string | null;
}

/** One production record, as the drill-down from a day shows it. */
export interface ProductivityRecordDto {
  id: string;
  orderId: string;
  poNumber: string;
  orderName: string;
  date: string;
  operation: ProductionOperation;
  qty: number;
  line: string | null;
  team: string | null;
}

export interface ProductivityAuditRowDto {
  id: string;
  orderId: string;
  poNumber: string;
  orderName: string;
  inspectionDate: string;
  auditType: string;
  sampleSize: number | null;
  /** Defects found — occurrences, not defective pieces. */
  defectQty: number | null;
  result: 'PASS' | 'FAIL' | 'PENDING';
  /** True when this audit re-inspects after an earlier failure. */
  isReinspection: boolean;
  /** False when the audit could not be counted in the rate. */
  counted: boolean;
}

export interface ProductivityCuttingRowDto {
  id: string;
  orderId: string;
  poNumber: string;
  orderName: string;
  cutDate: string;
  actualCutQty: number | null;
  fabricUsedM: number | null;
  counted: boolean;
}

export interface ProductivityDto {
  range: DayRange;
  previousRange: DayRange;
  /** The whole factory: unique garments, stage throughput, activity. Never a sum across stages. */
  overview: FactoryOverview;
  /** Garments sewn per recorded day, this period against the one before. */
  overviewTrend: Trend;
  /** Line efficiency and pieces per operator, from the day logs and order SAMs. */
  labour: LabourSummary;
  /** Line efficiency, this period against the one before. */
  efficiencyTrend: Trend;
  /** On-time delivery and cut-to-ship for the shipments of the period. Absent without shipment:read. */
  delivery: DeliverySummary | null;
  dayLogs: ProductivityDayLogDto[];
  primaryOperation: ProductionOperation;
  output: OutputSummary;
  /** Primary-operation average per recorded day, this period against the one before. */
  trend: Trend;
  /** Primary-operation total, this period against the one before. */
  totalTrend: Trend;
  orders: ProductivityOrderRowDto[];
  records: ProductivityRecordDto[];
  /** Absent when the account lacks quality:read. */
  quality: { summary: DefectRateSummary; rft: RftSummary; audits: ProductivityAuditRowDto[] } | null;
  /** Absent when the account lacks cutting:read. */
  fabric: { summary: FabricUtilisationSummary; records: ProductivityCuttingRowDto[] } | null;
}

/** The Costing sidebar page: every order's costing before it is opened. */
export interface CostingOverviewDto {
  summary: CostingOverviewSummary;
  rows: CostingOverviewRow[];
}

export interface FollowUpItemDto {
  id: string;
  kind: 'TASK' | 'SHORTAGE' | 'EXTERNAL' | 'QUALITY';
  orderId: string;
  orderPoNumber: string;
  orderName: string;
  title: string;
  detail: string;
  responsibleName: string | null;
  department: string | null;
  dueDate: string | null;
  daysRemaining: number | null;
  priority: Priority;
  severity: 'CRITICAL' | 'WARNING' | 'ATTENTION' | 'OK';
  nextAction: string;
  tab: string | null;
}

// --- Excel import ---------------------------------------------------------

export interface ImportSheetInfo {
  name: string;
  rows: number;
  cols: number;
  recognisedAs: string | null;
  confidence: number;
}

export interface ImportFieldMapping {
  field: string;
  label: string;
  sheet: string | null;
  /** Anchor label the extractor searches for, e.g. "Po No". */
  anchor: string | null;
  /** [rowOffset, colOffset] from the anchor cell. */
  offset: [number, number] | null;
  /**
   * Where the value actually came from: "D7", or a column letter for a table.
   *
   * Provenance, not decoration. A coordinator checking an imported order
   * against the workbook in front of them needs to know which cell to look at,
   * and six weeks later "where did this delivery date come from?" has an
   * answer instead of a shrug.
   */
  cell: string | null;
  sampleValue: string | null;
  required: boolean;
  resolved: boolean;
  /**
   * How sure the importer is.
   *
   * HIGH   read from a labelled cell, or a header the synonym table knows.
   * MEDIUM read, but the reading is ambiguous — an 03/09 date, a header the
   *        scorer matched only loosely.
   * LOW    a guess worth showing but not worth trusting.
   * NONE   not found. The review screen asks.
   *
   * Anything below HIGH is surfaced on the review screen for confirmation
   * rather than silently applied.
   */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  /** How the value was read, in words: "Excel serial number 46278". */
  interpretation?: string | null;
  /** The other reading of an ambiguous value, for the review screen to offer. */
  alternative?: { value: string; interpretation: string } | null;
}

export interface ImportIssue {
  /**
   * ERROR blocks the import, WARNING lets it through with a caveat, INFO is the
   * importer showing its working — "read as a size grid", "took the PO number
   * from the sheet header". Explaining a correct guess is how a coordinator
   * comes to trust an automatic mapping.
   */
  level: 'ERROR' | 'WARNING' | 'INFO';
  field: string | null;
  sheet: string | null;
  cell: string | null;
  message: string;
}

export interface ImportPreviewDto {
  jobId: string;
  fileName: string;
  profile: string | null;
  profileConfidence: number;
  sheets: ImportSheetInfo[];
  mappings: ImportFieldMapping[];
  issues: ImportIssue[];
  preview: {
    order: Record<string, string | number | null>;
    colors: string[];
    sizes: string[];
    matrixTotal: number;
    matrixRows: Array<{ color: string; cells: Record<string, number>; total: number }>;
    bomLines: number;
    externalOps: number;
    lays: number;
  };
  canCommit: boolean;
}

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

// ── Proforma / Invoice ───────────────────────────────────────────────────────

/** The factory's own letterhead: what goes at the top of every document and in its payment block. */
export interface CompanyProfileDto {
  name: string;
  tagline: string | null;
  address: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  /** One line per bank detail, printed as written. */
  bankDetails: string | null;
  /** Default terms and conditions, one per line; copied onto each new document. */
  invoiceTerms: string | null;
  /** Default payment terms ("COD", "50% in advance, balance before shipping"). */
  paymentTerms: string | null;
  /** The QIZ reference printed in the exporter block. */
  qizRef: string | null;
  /** Who signs the documents: printed under "For and in behalf of <company>". */
  signatory: string | null;
  /** The company stamp as a data URL (PNG/JPEG, kept small), printed by the signature. */
  stampDataUrl: string | null;
  updatedAt: string | null;
}

export interface InvoiceLineDto {
  id: string;
  kind: InvoiceLineKind;
  description: string;
  size: string | null;
  quantity: number | null;
  unitPrice: number | null;
  /** Extras only. */
  amount: number | null;
  /** Derived: quantity × unit price, or the extra's amount. Null until both are known. */
  lineTotal: number | null;
  position: number;
}

/** One carton on the manifest, as it was when the document was built. */
export interface InvoiceCartonDto {
  n: number;
  cartonNumber: string;
  cartonSize: string | null;
  product: string;
  /** The PO the carton belongs to. Absent on documents built before one document could cover several orders. */
  poNumber?: string;
  contents: Array<{ label: string; qty: number }>;
  /** What is in a carton typed by hand on a proforma, when it is not a size list. */
  contentsText?: string | null;
  pieces: number;
  netKg: number | null;
  grossKg: number | null;
}

export interface InvoiceReconciliationRowDto { label: string; ordered: number; shipped: number; short: number }
export interface InvoiceReconciliationGroupDto {
  product: string;
  /** The PO the group compares against. Absent on documents built before one document could cover several orders. */
  poNumber?: string;
  rows: InvoiceReconciliationRowDto[];
  ordered: number; shipped: number; short: number;
}

/** One order on a document, as it was when the document was last built. */
export interface InvoiceOrderRefDto {
  id: string;
  poNumber: string;
  orderName: string;
  styleNumber: string | null;
  clientName: string;
  packingListId: string | null;
  shipmentId: string | null;
}

export interface InvoiceDto {
  id: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string;
  date: string;
  dueDate: string | null;
  paymentTerms: string | null;

  /** The first order on the document. */
  order: { id: string; poNumber: string; orderName: string; styleNumber: string | null; clientName: string };
  /** Every order the document covers, the first one first: an order split into several POs is invoiced on one document. */
  orders: InvoiceOrderRefDto[];
  shipmentId: string | null;
  packingListId: string | null;

  billTo: string;
  billToAddress: string | null;
  billToEmail: string | null;
  /** The customer's own reference, printed as "Your reference". */
  customerReference: string | null;
  /** The consignment the invoice covers: an AWB, a container, or the factory's own shipment number. */
  shipmentRef: string | null;
  shippedOn: string | null;
  coverNote: string | null;
  terms: string | null;
  bankDetails: string | null;
  notes: string | null;
  /** DETAILED: every colour and size. SUMMARY: one line per style (or per order) — total pieces, rate, amount. */
  lineLayout: 'DETAILED' | 'SUMMARY';
  /**
   * A proforma's shipment and exporter details and each style's PO, part
   * number, HTS code, weights and cartons — the factory's proforma sheet.
   * Null on an invoice.
   */
  sheet: ProformaSheetSettings | null;

  seller: CompanyProfileDto;
  lines: InvoiceLineDto[];
  manifest: InvoiceCartonDto[];
  reconciliation: InvoiceReconciliationGroupDto[];
  /** What the builder could not do, in plain words — shown on the draft, never printed. */
  warnings: string[];

  totals: {
    totalQty: number;
    subtotal: number;
    extras: number;
    total: number;
    incomplete: boolean;
  };
  totalInWords: string;

  preparedByName: string | null;
  issuedByName: string | null;
  issuedAt: string | null;
  sentAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  /** True on a draft whose cartons no longer match the packing list — rebuild it before issuing. */
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceListRowDto {
  id: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number: string;
  date: string;
  dueDate: string | null;
  orderId: string;
  poNumber: string;
  orderName: string;
  clientName: string;
  /** Every order on the document, the first one first. */
  orders: Array<{ orderId: string; poNumber: string; orderName: string }>;
  billTo: string;
  totalQty: number;
  total: number;
  incomplete: boolean;
  issuedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

/** An order that could be invoiced now, with what it has done so far. */
export interface InvoiceCandidateDto {
  orderId: string;
  poNumber: string;
  orderName: string;
  clientId: string;
  clientName: string;
  orderQty: number;
  packedQty: number;
  shippedQty: number;
  pricePerPieceUsd: number | null;
  /** Documents already raised on this order, newest first. */
  invoices: Array<{ id: string; kind: InvoiceKind; status: InvoiceStatus; number: string; totalQty: number }>;
  packingLists: Array<{ id: string; reference: string | null; approved: boolean; cartonCount: number; totalQty: number; createdAt: string }>;
  shipments: Array<{ id: string; status: ShipmentStatus; qty: number; actualShippingDate: string | null; awbNumber: string | null; trackingNumber: string | null }>;
}
