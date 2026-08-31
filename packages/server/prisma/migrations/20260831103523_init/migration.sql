-- CreateEnum
CREATE TYPE "Department" AS ENUM ('COORDINATOR', 'FACTORY_MANAGER', 'PRODUCTION_MANAGER', 'CUTTING_MARKER', 'WAREHOUSE', 'EXTERNAL_OPS', 'PACKING', 'QUALITY', 'FOLLOW_UP', 'FINANCE', 'ADMIN');

-- CreateEnum
CREATE TYPE "RefKind" AS ENUM ('SEASON', 'FABRIC', 'FIT', 'BLOCK_PATTERN', 'ITEM_TYPE', 'GENDER', 'SHIPPING_METHOD', 'EXTERNAL_WORK_SORT', 'EXTERNAL_WORK_TYPE', 'POSITION', 'UNIT', 'ITEM_SORT', 'THREAD_COLOR', 'REFERENCE', 'COLLAR', 'CUFF', 'SIZE_LABEL', 'FABRIC_COMPOSITION', 'BRAND_LOGO');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'WAITING_APPROVAL', 'READY_FOR_PRODUCTION', 'IN_PRODUCTION', 'PRODUCTION_DELAYED', 'QUALITY_CHECK', 'QUALITY_BLOCKED', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QtyLedger" AS ENUM ('ORDER', 'STOCK', 'CUT', 'IN_LINE', 'OUT_LINE', 'PACKED', 'SHIPPED', 'SECOND_DEGREE');

-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('GENERAL', 'SPREAD', 'CUT', 'PACKING', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "StageKey" AS ENUM ('CUSTOMER_ORDER_REF', 'ORDER_DETAILS', 'MAIN_ORDER', 'PROGRESS_STATUS', 'CUT_ORDER', 'LAYING_FABRIC', 'BILL_OF_MATERIAL', 'CUSTOM_INSTRUCTIONS', 'EXTERNAL_ORDER', 'STOCK', 'FOLLOW_UP', 'PRODUCTION_FOLLOW_UP', 'PACKING', 'AUDIT', 'ACTUAL_COSTING', 'DATABASE', 'INVOICE', 'COMPLETED', 'PROFORMA_INVOICE');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'BLOCKED', 'OVERDUE', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "BomCategory" AS ENUM ('FABRIC', 'THREAD', 'LABEL', 'TRANSFER', 'BADGE', 'LOGO', 'SPONSOR', 'SIZE', 'POLY_BAG', 'BUTTER_PAPER', 'STICKY_TAPE', 'BARCODE_PAPER', 'HALF_BOX', 'CARTON', 'TAPE', 'ACCESSORY', 'OTHER');

-- CreateEnum
CREATE TYPE "MaterialType" AS ENUM ('FABRIC', 'THREAD', 'TRIM', 'LABEL', 'BUTTON', 'ZIPPER', 'ELASTIC', 'PRINT_TRANSFER', 'BADGE', 'PACKAGING', 'CARTON', 'POLY_BAG', 'ACCESSORY', 'CHEMICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('RECEIPT', 'ISSUE', 'RETURN', 'ADJUSTMENT', 'WASTAGE', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'FULFILLED', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('M', 'CM', 'YD', 'KG', 'G', 'PCS', 'DZN', 'ROLL', 'CONE', 'SET', 'BOX', 'L');

-- CreateEnum
CREATE TYPE "ExternalOpStatus" AS ENUM ('NOT_SENT', 'WAITING_APPROVAL', 'SENT', 'IN_PROGRESS', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('PRINT_ARTWORK', 'EMBROIDERY', 'COLOR', 'SAMPLE', 'LABEL', 'PACKING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "ProductionOperation" AS ENUM ('CUTTING', 'SEWING', 'PRINTING', 'EMBROIDERY', 'WASHING', 'FINISHING', 'PACKING');

-- CreateEnum
CREATE TYPE "AuditType" AS ENUM ('FINAL_AUDIT', 'BEFORE_IRON', 'BEFORE_PACKING', 'IN_PACKING', 'INLINE');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('PENDING', 'PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "DefectCategory" AS ENUM ('COLOR_COMBINATION', 'FABRIC_DEFECT', 'CONSTRUCTION_STITCHING', 'TRIMMING', 'PRINT_EMBROIDERY', 'CLEANLINESS', 'PACKING', 'MEASUREMENTS');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('NOT_READY', 'READY', 'BOOKED', 'SHIPPED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "CostGroup" AS ENUM ('FABRIC', 'ACCESSORY', 'EXTERNAL', 'LABOUR', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CUSTOMER_PO', 'CUSTOMER_REFERENCE', 'ARTWORK', 'TECH_PACK', 'FABRIC_PHOTO', 'SAMPLE_PHOTO', 'MARKER_FILE', 'BOM', 'EXTERNAL_OP_DOC', 'PACKING_LIST', 'QUALITY_REPORT', 'INVOICE', 'SHIPPING_DOC', 'PROFORMA_INVOICE', 'OTHER');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TASK_ASSIGNED', 'TASK_OVERDUE', 'APPROVAL_REQUESTED', 'APPROVAL_RECEIVED', 'MATERIAL_SHORTAGE', 'PRODUCTION_DELAY', 'QUALITY_FAILURE', 'PACKING_COMPLETED', 'SHIPMENT_READY', 'ORDER_OVERDUE', 'MENTIONED');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ChangeCategory" AS ENUM ('ORDER', 'PRODUCTION', 'INVENTORY', 'MATERIALS', 'TASKS', 'QUALITY', 'SHIPMENT', 'APPROVALS', 'DOCUMENTS', 'ADMIN');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'DETECTED', 'MAPPED', 'VALIDATED', 'COMMITTED', 'FAILED');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "department" "Department" NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "disabledById" TEXT,
    "createdById" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordChangedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "shippingAddress" TEXT,
    "billingAddress" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "factories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "address" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "isExternal" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "factories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ref_colors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ref_colors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ref_sizes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "longName" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ref_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ref_values" (
    "id" TEXT NOT NULL,
    "kind" "RefKind" NOT NULL,
    "value" TEXT NOT NULL,
    "valueAr" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ref_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "itemType" TEXT,
    "gender" TEXT,
    "styleNumber" TEXT,
    "fit" TEXT,
    "blockPattern" TEXT,
    "fabric" TEXT,
    "fabric2" TEXT,
    "fabric3" TEXT,
    "fabricDescription" TEXT,
    "shippingMethod" TEXT,
    "pricePerPieceUsd" DECIMAL(10,4),
    "cutPercentage" DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    "accessoryPercentage" DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    "poDate" TIMESTAMP(3),
    "promisedShippingDate" TIMESTAMP(3),
    "requiredDeliveryDate" TIMESTAMP(3),
    "fabricDeliveryToSupplier" TIMESTAMP(3),
    "supplierDeliveryDate" TIMESTAMP(3),
    "externalReference" TEXT,
    "externalWorkSort" TEXT,
    "externalWorkType" TEXT,
    "shippingAddress" TEXT,
    "billingAddress" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancelledReason" TEXT,
    "cachedProgressPct" INTEGER DEFAULT 0,
    "cachedStatus" "OrderStatus" DEFAULT 'DRAFT',
    "cachedStageKey" "StageKey",
    "clientId" TEXT NOT NULL,
    "factoryId" TEXT,
    "externalFactoryId" TEXT,
    "coordinatorId" TEXT,
    "outsideWorkManagerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_colors" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "colorId" TEXT NOT NULL,
    "productName" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_colors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_sizes" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_quantities" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderColorId" TEXT NOT NULL,
    "orderSizeId" TEXT NOT NULL,
    "ledger" "QtyLedger" NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stage_quantities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_notes" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "NoteKind" NOT NULL,
    "body" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_stages" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stageKey" "StageKey" NOT NULL,
    "startedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "completedById" TEXT,
    "notRequiredReason" TEXT,
    "statusOverride" "StageStatus",
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_templates" (
    "key" TEXT NOT NULL,
    "stageKey" "StageKey" NOT NULL,
    "department" "Department" NOT NULL,
    "title" TEXT NOT NULL,
    "requirementEn" TEXT NOT NULL,
    "requirementAr" TEXT NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "task_templates_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderStageId" TEXT NOT NULL,
    "stageKey" "StageKey" NOT NULL,
    "templateKey" TEXT,
    "title" TEXT NOT NULL,
    "requirementEn" TEXT,
    "requirementAr" TEXT,
    "department" "Department" NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "estimatedMinutes" INTEGER,
    "actualMinutes" INTEGER,
    "status" "TaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "dueDate" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "blockedReason" TEXT,
    "assigneeId" TEXT,
    "completedById" TEXT,
    "blockedByTaskId" TEXT,
    "isCorrectiveAction" BOOLEAN NOT NULL DEFAULT false,
    "sourceAuditId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "category" "BomCategory" NOT NULL,
    "position" TEXT,
    "item" TEXT NOT NULL,
    "description" TEXT,
    "colorId" TEXT,
    "colorText" TEXT,
    "materialId" TEXT,
    "consumptionPerPiece" DECIMAL(12,6),
    "requiredQty" DECIMAL(14,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "issuedQty" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "issuedByName" TEXT,
    "issuedToName" TEXT,
    "issuedAt" TIMESTAMP(3),
    "purchaseOrderRef" TEXT,
    "notes" TEXT,
    "sort_position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_issues" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "bomItemId" TEXT NOT NULL,
    "qty" DECIMAL(14,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "issuedToId" TEXT,
    "issuedToName" TEXT,
    "notes" TEXT,

    CONSTRAINT "material_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_records" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "colorName" TEXT NOT NULL,
    "sizeName" TEXT NOT NULL,
    "availableQty" INTEGER NOT NULL DEFAULT 0,
    "reservedQty" INTEGER NOT NULL DEFAULT 0,
    "usedQty" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT,
    "notes" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "type" "MaterialType" NOT NULL,
    "description" TEXT,
    "colorName" TEXT,
    "widthCm" DECIMAL(8,2),
    "composition" TEXT,
    "gsm" INTEGER,
    "sizeLabel" TEXT,
    "unit" "UnitOfMeasure" NOT NULL,
    "supplierName" TEXT,
    "supplierRef" TEXT,
    "minimumQty" DECIMAL(18,4),
    "unitCostUsd" DECIMAL(14,6),
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'STORE',
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_stock" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "locationId" TEXT,
    "physicalQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "binRef" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_movements" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "locationId" TEXT,
    "type" "MovementType" NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL,
    "balanceAfter" DECIMAL(18,4) NOT NULL,
    "orderId" TEXT,
    "reservationId" TEXT,
    "bomItemId" TEXT,
    "reason" TEXT,
    "batchLot" TEXT,
    "reference" TEXT,
    "stage" "StageKey",
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_reservations" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "bomItemId" TEXT,
    "qty" DECIMAL(18,4) NOT NULL,
    "consumedQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit" "UnitOfMeasure" NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reservedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cutting_records" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "cutDate" TIMESTAMP(3),
    "cuttingTeam" TEXT,
    "cutByName" TEXT,
    "inspectedByName" TEXT,
    "numberingByName" TEXT,
    "bundledByName" TEXT,
    "approvedByName" TEXT,
    "actualCutQty" INTEGER,
    "fabricUsedM" DECIMAL(12,3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cutting_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markers" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "markerNumber" TEXT,
    "fabricName" TEXT NOT NULL,
    "fabricColor" TEXT,
    "panel" TEXT NOT NULL DEFAULT 'ALL',
    "sizeRatio" TEXT NOT NULL,
    "layers" INTEGER NOT NULL,
    "markerLengthM" DECIMAL(10,3) NOT NULL,
    "totalLengthM" DECIMAL(12,3),
    "nestPcs" INTEGER,
    "efficiencyPct" DECIMAL(6,3),
    "maxLayer" INTEGER,
    "notes" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fabric_records" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fabricName" TEXT NOT NULL,
    "colorName" TEXT,
    "fabricType" TEXT,
    "composition" TEXT,
    "supplier" TEXT,
    "requiredM" DECIMAL(12,3),
    "availableM" DECIMAL(12,3),
    "issuedM" DECIMAL(12,3),
    "actualConsumptionM" DECIMAL(12,3),
    "responsibleName" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "fabric_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_operations" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalFactoryId" TEXT,
    "externalReference" TEXT,
    "operationType" TEXT NOT NULL,
    "operationTypeAr" TEXT,
    "operationSort" TEXT,
    "qty" INTEGER NOT NULL,
    "unitRate" DECIMAL(12,6),
    "unitPriceUsd" DECIMAL(12,4),
    "sentDate" TIMESTAMP(3),
    "expectedReturnDate" TIMESTAMP(3),
    "actualReturnDate" TIMESTAMP(3),
    "status" "ExternalOpStatus" NOT NULL DEFAULT 'NOT_SENT',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalId" TEXT,
    "notes" TEXT,
    "colorIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "ApprovalType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "requestedDate" TIMESTAMP(3),
    "requestedById" TEXT,
    "sentTo" TEXT,
    "approvedDate" TIMESTAMP(3),
    "approvedByName" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_instructions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibleTo" "Department"[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_records" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "operation" "ProductionOperation" NOT NULL,
    "qty" INTEGER NOT NULL,
    "line" TEXT,
    "team" TEXT,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_audits" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "inspectionDate" TIMESTAMP(3) NOT NULL,
    "factoryId" TEXT,
    "auditType" "AuditType" NOT NULL DEFAULT 'FINAL_AUDIT',
    "availableQty" INTEGER NOT NULL,
    "sampleSize" INTEGER,
    "acceptedQty" INTEGER,
    "rejectedQty" INTEGER,
    "result" "AuditResult" NOT NULL DEFAULT 'PENDING',
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "correctiveAction" TEXT,
    "correctiveActionClosed" BOOLEAN NOT NULL DEFAULT false,
    "reinspectionOf" TEXT,
    "reinspectFor" TEXT,
    "auditorId" TEXT,
    "factoryRepName" TEXT,
    "colorsInspected" TEXT[],
    "sizesInspected" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quality_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_defects" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "category" "DefectCategory" NOT NULL,
    "qty" INTEGER NOT NULL,
    "comment" TEXT,
    "isReinspection" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "quality_defects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packing_lists" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reference" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedByName" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packing_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cartons" (
    "id" TEXT NOT NULL,
    "packingListId" TEXT NOT NULL,
    "cartonNumber" TEXT NOT NULL,
    "cartonSize" TEXT,
    "orderColorId" TEXT,
    "orderSizeId" TEXT,
    "qty" INTEGER NOT NULL,
    "grossWeightKg" DECIMAL(10,3),
    "netWeightKg" DECIMAL(10,3),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cartons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'NOT_READY',
    "qty" INTEGER NOT NULL DEFAULT 0,
    "promisedShippingDate" TIMESTAMP(3),
    "requiredDeliveryDate" TIMESTAMP(3),
    "actualShippingDate" TIMESTAMP(3),
    "deliveredDate" TIMESTAMP(3),
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "awbNumber" TEXT,
    "containerSeal" TEXT,
    "vesselVoyage" TEXT,
    "finalDestination" TEXT,
    "notes" TEXT,
    "overrideApproved" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "costing_records" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "costingDate" TIMESTAMP(3),
    "dollarRate" DECIMAL(10,4) NOT NULL DEFAULT 48.5,
    "dailyCostEgp" DECIMAL(14,4),
    "machineCount" INTEGER,
    "machineDaysUsed" INTEGER,
    "daysInLine" INTEGER,
    "productionLineMachines" JSONB,
    "sublimationCostUsd" DECIMAL(14,4),
    "embroideryCostUsd" DECIMAL(14,4),
    "externalOpCostUsd" DECIMAL(14,4),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "costing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_lines" (
    "id" TEXT NOT NULL,
    "costingId" TEXT NOT NULL,
    "group" "CostGroup" NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" DECIMAL(14,4),
    "unit" TEXT NOT NULL,
    "unitPriceUsd" DECIMAL(14,6),
    "unitPriceEgp" DECIMAL(14,4),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cost_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proforma_invoices" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "number" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consignee" TEXT,
    "billingAddress" TEXT,
    "email" TEXT,
    "vesselVoyage" TEXT,
    "containerSeal" TEXT,
    "shippingDate" TIMESTAMP(3),
    "shipmentFrom" TEXT DEFAULT 'Cairo / Egypt',
    "shipmentTo" TEXT,
    "consolidatingVendor" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "terms" TEXT,
    "sentAt" TIMESTAMP(3),
    "preparedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proforma_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proforma_invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,4),
    "unit" TEXT NOT NULL DEFAULT 'PCS',
    "unitPrice" DECIMAL(14,6),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "proforma_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "orderStageId" TEXT,
    "stageKey" "StageKey",
    "taskId" TEXT,
    "approvalId" TEXT,
    "externalOperationId" TEXT,
    "qualityAuditId" TEXT,
    "shipmentId" TEXT,
    "customInstructionId" TEXT,
    "fileName" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL DEFAULT 'OTHER',
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storageDriver" TEXT NOT NULL DEFAULT 'local',
    "version" INTEGER NOT NULL DEFAULT 1,
    "checksum" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_trails" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'UPDATE',
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_trails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "changeEventId" TEXT,
    "type" "NotificationType" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_events" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "category" "ChangeCategory" NOT NULL,
    "subject" TEXT,
    "summary" TEXT NOT NULL,
    "priority" "NotificationPriority" NOT NULL,
    "orderId" TEXT,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "link" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_event_fields" (
    "id" TEXT NOT NULL,
    "changeEventId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "change_event_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" TEXT NOT NULL,
    "changeEventId" TEXT,
    "recipients" TEXT[],
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "profile" TEXT,
    "profileConfidence" DECIMAL(5,4),
    "detectedSheets" JSONB,
    "mappings" JSONB,
    "issues" JSONB,
    "preview" JSONB,
    "createdOrderId" TEXT,
    "errorMessage" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_column_mappings" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "label" TEXT NOT NULL,
    "headerFingerprint" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_column_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_department_idx" ON "users"("department");

-- CreateIndex
CREATE INDEX "users_active_idx" ON "users"("active");

-- CreateIndex
CREATE INDEX "users_isSuperAdmin_idx" ON "users"("isSuperAdmin");

-- CreateIndex
CREATE UNIQUE INDEX "clients_name_key" ON "clients"("name");

-- CreateIndex
CREATE UNIQUE INDEX "factories_name_key" ON "factories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ref_colors_name_key" ON "ref_colors"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ref_sizes_name_key" ON "ref_sizes"("name");

-- CreateIndex
CREATE INDEX "ref_values_kind_active_idx" ON "ref_values"("kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ref_values_kind_value_key" ON "ref_values"("kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "orders_poNumber_key" ON "orders"("poNumber");

-- CreateIndex
CREATE INDEX "orders_clientId_idx" ON "orders"("clientId");

-- CreateIndex
CREATE INDEX "orders_coordinatorId_idx" ON "orders"("coordinatorId");

-- CreateIndex
CREATE INDEX "orders_season_idx" ON "orders"("season");

-- CreateIndex
CREATE INDEX "orders_cachedStatus_idx" ON "orders"("cachedStatus");

-- CreateIndex
CREATE INDEX "orders_requiredDeliveryDate_idx" ON "orders"("requiredDeliveryDate");

-- CreateIndex
CREATE INDEX "orders_cancelled_cachedStatus_idx" ON "orders"("cancelled", "cachedStatus");

-- CreateIndex
CREATE INDEX "order_colors_orderId_idx" ON "order_colors"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "order_colors_orderId_colorId_key" ON "order_colors"("orderId", "colorId");

-- CreateIndex
CREATE INDEX "order_sizes_orderId_idx" ON "order_sizes"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "order_sizes_orderId_sizeId_key" ON "order_sizes"("orderId", "sizeId");

-- CreateIndex
CREATE INDEX "stage_quantities_orderId_ledger_idx" ON "stage_quantities"("orderId", "ledger");

-- CreateIndex
CREATE UNIQUE INDEX "stage_quantities_orderId_orderColorId_orderSizeId_ledger_key" ON "stage_quantities"("orderId", "orderColorId", "orderSizeId", "ledger");

-- CreateIndex
CREATE UNIQUE INDEX "order_notes_orderId_kind_key" ON "order_notes"("orderId", "kind");

-- CreateIndex
CREATE INDEX "order_stages_orderId_idx" ON "order_stages"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "order_stages_orderId_stageKey_key" ON "order_stages"("orderId", "stageKey");

-- CreateIndex
CREATE INDEX "task_templates_sequence_idx" ON "task_templates"("sequence");

-- CreateIndex
CREATE INDEX "tasks_orderId_status_idx" ON "tasks"("orderId", "status");

-- CreateIndex
CREATE INDEX "tasks_assigneeId_status_idx" ON "tasks"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "tasks_department_status_idx" ON "tasks"("department", "status");

-- CreateIndex
CREATE INDEX "tasks_dueDate_idx" ON "tasks"("dueDate");

-- CreateIndex
CREATE INDEX "task_comments_taskId_idx" ON "task_comments"("taskId");

-- CreateIndex
CREATE INDEX "bom_items_orderId_category_idx" ON "bom_items"("orderId", "category");

-- CreateIndex
CREATE INDEX "bom_items_materialId_idx" ON "bom_items"("materialId");

-- CreateIndex
CREATE INDEX "material_issues_orderId_idx" ON "material_issues"("orderId");

-- CreateIndex
CREATE INDEX "material_issues_bomItemId_idx" ON "material_issues"("bomItemId");

-- CreateIndex
CREATE INDEX "stock_records_orderId_idx" ON "stock_records"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "materials_code_key" ON "materials"("code");

-- CreateIndex
CREATE INDEX "materials_type_active_idx" ON "materials"("type", "active");

-- CreateIndex
CREATE INDEX "materials_name_idx" ON "materials"("name");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_name_key" ON "inventory_locations"("name");

-- CreateIndex
CREATE INDEX "material_stock_materialId_idx" ON "material_stock"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "material_stock_materialId_locationId_key" ON "material_stock"("materialId", "locationId");

-- CreateIndex
CREATE INDEX "material_movements_materialId_occurredAt_idx" ON "material_movements"("materialId", "occurredAt");

-- CreateIndex
CREATE INDEX "material_movements_orderId_occurredAt_idx" ON "material_movements"("orderId", "occurredAt");

-- CreateIndex
CREATE INDEX "material_movements_type_occurredAt_idx" ON "material_movements"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "material_reservations_materialId_status_idx" ON "material_reservations"("materialId", "status");

-- CreateIndex
CREATE INDEX "material_reservations_orderId_status_idx" ON "material_reservations"("orderId", "status");

-- CreateIndex
CREATE INDEX "cutting_records_orderId_idx" ON "cutting_records"("orderId");

-- CreateIndex
CREATE INDEX "markers_orderId_idx" ON "markers"("orderId");

-- CreateIndex
CREATE INDEX "fabric_records_orderId_idx" ON "fabric_records"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "external_operations_approvalId_key" ON "external_operations"("approvalId");

-- CreateIndex
CREATE INDEX "external_operations_orderId_status_idx" ON "external_operations"("orderId", "status");

-- CreateIndex
CREATE INDEX "approvals_orderId_status_idx" ON "approvals"("orderId", "status");

-- CreateIndex
CREATE INDEX "custom_instructions_orderId_idx" ON "custom_instructions"("orderId");

-- CreateIndex
CREATE INDEX "production_records_orderId_date_idx" ON "production_records"("orderId", "date");

-- CreateIndex
CREATE INDEX "production_records_orderId_operation_idx" ON "production_records"("orderId", "operation");

-- CreateIndex
CREATE INDEX "quality_audits_orderId_result_idx" ON "quality_audits"("orderId", "result");

-- CreateIndex
CREATE INDEX "quality_defects_auditId_idx" ON "quality_defects"("auditId");

-- CreateIndex
CREATE INDEX "packing_lists_orderId_idx" ON "packing_lists"("orderId");

-- CreateIndex
CREATE INDEX "cartons_packingListId_idx" ON "cartons"("packingListId");

-- CreateIndex
CREATE INDEX "shipments_orderId_idx" ON "shipments"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "costing_records_orderId_key" ON "costing_records"("orderId");

-- CreateIndex
CREATE INDEX "cost_lines_costingId_idx" ON "cost_lines"("costingId");

-- CreateIndex
CREATE INDEX "proforma_invoices_orderId_idx" ON "proforma_invoices"("orderId");

-- CreateIndex
CREATE INDEX "proforma_invoice_lines_invoiceId_idx" ON "proforma_invoice_lines"("invoiceId");

-- CreateIndex
CREATE INDEX "attachments_orderId_idx" ON "attachments"("orderId");

-- CreateIndex
CREATE INDEX "attachments_orderId_documentType_idx" ON "attachments"("orderId", "documentType");

-- CreateIndex
CREATE INDEX "activity_logs_orderId_createdAt_idx" ON "activity_logs"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_trails_entityType_entityId_idx" ON "audit_trails"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_trails_orderId_createdAt_idx" ON "audit_trails"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_trails_actorId_createdAt_idx" ON "audit_trails"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_trails_entityType_createdAt_idx" ON "audit_trails"("entityType", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "change_events_orderId_createdAt_idx" ON "change_events"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "change_events_entityType_entityId_idx" ON "change_events"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "change_events_category_createdAt_idx" ON "change_events"("category", "createdAt");

-- CreateIndex
CREATE INDEX "change_event_fields_changeEventId_idx" ON "change_event_fields"("changeEventId");

-- CreateIndex
CREATE INDEX "email_deliveries_status_nextAttemptAt_idx" ON "email_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "import_jobs_uploadedById_status_idx" ON "import_jobs"("uploadedById", "status");

-- CreateIndex
CREATE INDEX "saved_column_mappings_headerFingerprint_idx" ON "saved_column_mappings"("headerFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "saved_column_mappings_clientId_headerFingerprint_key" ON "saved_column_mappings"("clientId", "headerFingerprint");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_disabledById_fkey" FOREIGN KEY ("disabledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_coordinatorId_fkey" FOREIGN KEY ("coordinatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_externalFactoryId_fkey" FOREIGN KEY ("externalFactoryId") REFERENCES "factories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "factories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_outsideWorkManagerId_fkey" FOREIGN KEY ("outsideWorkManagerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_colors" ADD CONSTRAINT "order_colors_colorId_fkey" FOREIGN KEY ("colorId") REFERENCES "ref_colors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_colors" ADD CONSTRAINT "order_colors_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_sizes" ADD CONSTRAINT "order_sizes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_sizes" ADD CONSTRAINT "order_sizes_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "ref_sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_quantities" ADD CONSTRAINT "stage_quantities_orderColorId_fkey" FOREIGN KEY ("orderColorId") REFERENCES "order_colors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_quantities" ADD CONSTRAINT "stage_quantities_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_quantities" ADD CONSTRAINT "stage_quantities_orderSizeId_fkey" FOREIGN KEY ("orderSizeId") REFERENCES "order_sizes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stages" ADD CONSTRAINT "order_stages_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stages" ADD CONSTRAINT "order_stages_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_blockedByTaskId_fkey" FOREIGN KEY ("blockedByTaskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_orderStageId_fkey" FOREIGN KEY ("orderStageId") REFERENCES "order_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_templateKey_fkey" FOREIGN KEY ("templateKey") REFERENCES "task_templates"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_colorId_fkey" FOREIGN KEY ("colorId") REFERENCES "ref_colors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_bomItemId_fkey" FOREIGN KEY ("bomItemId") REFERENCES "bom_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_issuedToId_fkey" FOREIGN KEY ("issuedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_stock" ADD CONSTRAINT "material_stock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_stock" ADD CONSTRAINT "material_stock_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_movements" ADD CONSTRAINT "material_movements_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_movements" ADD CONSTRAINT "material_movements_bomItemId_fkey" FOREIGN KEY ("bomItemId") REFERENCES "bom_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_movements" ADD CONSTRAINT "material_movements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_movements" ADD CONSTRAINT "material_movements_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_movements" ADD CONSTRAINT "material_movements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_movements" ADD CONSTRAINT "material_movements_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "material_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_bomItemId_fkey" FOREIGN KEY ("bomItemId") REFERENCES "bom_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_reservedById_fkey" FOREIGN KEY ("reservedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_records" ADD CONSTRAINT "cutting_records_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markers" ADD CONSTRAINT "markers_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fabric_records" ADD CONSTRAINT "fabric_records_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_externalFactoryId_fkey" FOREIGN KEY ("externalFactoryId") REFERENCES "factories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_instructions" ADD CONSTRAINT "custom_instructions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_auditorId_fkey" FOREIGN KEY ("auditorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "factories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_audits" ADD CONSTRAINT "quality_audits_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_defects" ADD CONSTRAINT "quality_defects_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "quality_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packing_lists" ADD CONSTRAINT "packing_lists_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_orderColorId_fkey" FOREIGN KEY ("orderColorId") REFERENCES "order_colors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_orderSizeId_fkey" FOREIGN KEY ("orderSizeId") REFERENCES "order_sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_packingListId_fkey" FOREIGN KEY ("packingListId") REFERENCES "packing_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "costing_records" ADD CONSTRAINT "costing_records_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_lines" ADD CONSTRAINT "cost_lines_costingId_fkey" FOREIGN KEY ("costingId") REFERENCES "costing_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_invoices" ADD CONSTRAINT "proforma_invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_invoices" ADD CONSTRAINT "proforma_invoices_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_invoice_lines" ADD CONSTRAINT "proforma_invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "proforma_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_customInstructionId_fkey" FOREIGN KEY ("customInstructionId") REFERENCES "custom_instructions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_externalOperationId_fkey" FOREIGN KEY ("externalOperationId") REFERENCES "external_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_orderStageId_fkey" FOREIGN KEY ("orderStageId") REFERENCES "order_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_qualityAuditId_fkey" FOREIGN KEY ("qualityAuditId") REFERENCES "quality_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_trails" ADD CONSTRAINT "audit_trails_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_trails" ADD CONSTRAINT "audit_trails_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_changeEventId_fkey" FOREIGN KEY ("changeEventId") REFERENCES "change_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_event_fields" ADD CONSTRAINT "change_event_fields_changeEventId_fkey" FOREIGN KEY ("changeEventId") REFERENCES "change_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_changeEventId_fkey" FOREIGN KEY ("changeEventId") REFERENCES "change_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_column_mappings" ADD CONSTRAINT "saved_column_mappings_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_column_mappings" ADD CONSTRAINT "saved_column_mappings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

