/**
 * Wire DTOs shared by the API and the web client. These are the contract; the
 * Prisma models are the storage. Keeping them separate means a schema change
 * does not silently reshape the API.
 */

import type {
  OrderStatus, Health, Priority, TaskStatus, StageKey, StageStatus, QtyLedger,
  ApprovalStatus, ApprovalType, ExternalOpStatus, ProductionOperation, ShipmentStatus,
  BomCategory, Department, NotificationPriority,
} from './enums.js';
import type { Alert } from './calc/alerts.js';
import type { StageProgress } from './calc/progress.js';
import type { ProductionAnalytics } from './calc/production.js';
import type { BomSummary } from './calc/materials.js';
import type { CostingResult } from './calc/costing.js';
import type { MaterialPosition, ConsumptionVariance } from './calc/inventory.js';
import type { Blocker } from './calc/workflow-gates.js';
import type { QuantityMatrix, FunnelStep, ColorProgress, CutVariance, StockDeduction } from './calc/quantities.js';

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
  cutPercentage: number;
  accessoryPercentage: number;
  externalReference: string | null;
  externalWorkSort: string | null;
  externalWorkType: string | null;
  poDate: string | null;
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
  costing: CostingResult | null;
  qualityPassPct: number | null;

  counts: {
    openTasks: number;
    overdueTasks: number;
    pendingApprovals: number;
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
  downloadUrl: string;
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
    waitingApproval: number;
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

export interface FollowUpItemDto {
  id: string;
  kind: 'TASK' | 'APPROVAL' | 'SHORTAGE' | 'EXTERNAL' | 'QUALITY';
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
