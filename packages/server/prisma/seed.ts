/**
 * Database seed.
 *
 * Creates the reference data, the roles and users, the 27 workflow task
 * templates from `Progress Status`, and PO A302059B exactly as the workbook
 * records it — 1,972 pieces across four colours, a 2,084-piece cut order, a
 * six-lay marker plan consuming 1,194 m of Rosetta, 23 BOM lines with nothing
 * issued, and an external printing operation blocked on customer approval.
 *
 * Idempotent: safe to run repeatedly.
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import argon2 from 'argon2';
import {
  WORKFLOW_TEMPLATE, ROLE_PERMISSIONS, ROLE_LABEL, computeCutMatrix, planDueDate,
  parseSuperAdminEmails, normaliseEmail,
  STAGE_META, type StageKey, type QtyCell, type AxisRef,
} from '@opsflow/shared';
import {
  SEASONS, ITEM_TYPES, FITS, BLOCK_PATTERNS, GENDERS, SHIPPING_METHODS, FABRICS,
  POSITIONS, UNITS, ITEM_SORTS, EXTERNAL_WORK_TYPES, COLORS, SIZES,
  ORDER, ORDER_SIZES, ORDER_MATRIX, PRODUCT_NAMES, NOTES, BOM, LAYS,
  EXTERNAL_COLORS, COSTING, COST_LINES, USERS, SUPER_ADMINS, CLIENTS, FACTORIES, DEMO_PRODUCTION,
  MATERIALS, MATERIAL_MOVEMENTS, INVENTORY_LOCATIONS,
} from './seed-data.js';

const prisma = new PrismaClient();
const DEFAULT_PASSWORD = 'opsflow-demo-2026';

async function main(): Promise<void> {
  console.log('Seeding OpsFlow…\n');

  // ── Roles ─────────────────────────────────────────────────────────────────
  for (const [key, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    await prisma.role.upsert({
      where: { key },
      create: { key, label: ROLE_LABEL[key as keyof typeof ROLE_LABEL], permissions, isSystem: true },
      update: { permissions, label: ROLE_LABEL[key as keyof typeof ROLE_LABEL] },
    });
  }
  console.log(`  roles                 ${Object.keys(ROLE_PERMISSIONS).length}`);

  // ── Users ─────────────────────────────────────────────────────────────────
  const passwordHash = await argon2.hash(DEFAULT_PASSWORD);
  for (const u of USERS) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: u.roleKey } });
    await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email, name: u.name, passwordHash,
        roleId: role.id, department: u.department as never,
      },
      update: { name: u.name, roleId: role.id, department: u.department as never },
    });
  }
  console.log(`  users                 ${USERS.length}`);

  // ── Super administrators ──────────────────────────────────────────────────
  //
  // Created with a password that must be changed on first sign-in, so the
  // seeded credential is never a long-term one. The flag is only set where the
  // address is also on the environment allowlist; anything else would be a
  // grant the running application would refuse anyway.
  const allowlist = parseSuperAdminEmails(
    process.env.SUPER_ADMIN_EMAILS ?? 'ahmed@soccertex.biz,laila@soccertex.biz',
  );
  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });

  for (const sa of SUPER_ADMINS) {
    const email = normaliseEmail(sa.email);
    const allowed = allowlist.includes(email);
    if (!allowed) {
      console.log(`  ! ${email} is not in SUPER_ADMIN_EMAILS — created without super-admin rights`);
    }
    await prisma.user.upsert({
      where: { email },
      create: {
        email, name: sa.name, passwordHash,
        roleId: superAdminRole.id, department: sa.department as never,
        isSuperAdmin: allowed, mustChangePassword: true,
      },
      // Re-seeding must not silently re-grant rights to an address that has
      // since been taken off the allowlist.
      update: { name: sa.name, roleId: superAdminRole.id, isSuperAdmin: allowed },
    });
  }

  // Anyone holding the flag who is no longer on the list loses it here too, so
  // the database and the environment cannot drift apart unnoticed.
  const losing = await prisma.user.findMany({
    where: { isSuperAdmin: true, NOT: { email: { in: allowlist } } },
    select: { id: true, email: true },
  });
  const revoked = await prisma.user.updateMany({
    where: { isSuperAdmin: true, NOT: { email: { in: allowlist } } },
    data: { isSuperAdmin: false },
  });
  // `updateMany` bypasses the audit middleware, which only diffs single-record
  // updates. A bulk revocation of super-admin rights must not be invisible, so
  // it is recorded explicitly.
  if (losing.length > 0) {
    await prisma.activityLog.createMany({
      data: losing.map((u) => ({
        actorName: 'Seed',
        action: 'USER_SUPERADMIN_REVOKED',
        summary: `revoked super-administrator rights from ${u.email} — no longer on SUPER_ADMIN_EMAILS`,
        entityType: 'User',
        entityId: u.id,
      })),
    });
  }
  console.log(`  super administrators  ${SUPER_ADMINS.filter((s) => allowlist.includes(normaliseEmail(s.email))).length}${revoked.count > 0 ? ` (revoked ${revoked.count} no longer allowlisted)` : ''}`);

  // ── Reference data — the Data-Base sheet ──────────────────────────────────
  for (const [i, c] of COLORS.entries()) {
    await prisma.refColor.upsert({
      where: { name: c.name },
      create: { name: c.name, hex: c.hex, position: i },
      update: { hex: c.hex, position: i },
    });
  }
  for (const [i, s] of SIZES.entries()) {
    await prisma.refSize.upsert({
      where: { name: s.name },
      create: { name: s.name, longName: s.longName, position: i },
      update: { longName: s.longName, position: i },
    });
  }

  const refValues: Prisma.RefValueCreateManyInput[] = [
    ...SEASONS.map((v, i) => ({ kind: 'SEASON' as const, value: v, position: i })),
    ...ITEM_TYPES.map((v, i) => ({ kind: 'ITEM_TYPE' as const, value: v, position: i })),
    ...FITS.map((v, i) => ({ kind: 'FIT' as const, value: v, position: i })),
    ...BLOCK_PATTERNS.map((v, i) => ({ kind: 'BLOCK_PATTERN' as const, value: v, position: i })),
    ...GENDERS.map((v, i) => ({ kind: 'GENDER' as const, value: v, position: i })),
    ...SHIPPING_METHODS.map((v, i) => ({ kind: 'SHIPPING_METHOD' as const, value: v, position: i })),
    ...FABRICS.map((v, i) => ({ kind: 'FABRIC' as const, value: v, position: i })),
    ...POSITIONS.map((v, i) => ({ kind: 'POSITION' as const, value: v, position: i })),
    ...UNITS.map((v, i) => ({ kind: 'UNIT' as const, value: v, position: i })),
    ...ITEM_SORTS.map((v, i) => ({ kind: 'ITEM_SORT' as const, value: v, position: i })),
    ...['Print', 'Embroidery'].map((v, i) => ({ kind: 'EXTERNAL_WORK_SORT' as const, value: v, position: i })),
    ...EXTERNAL_WORK_TYPES.map((v, i) => ({
      kind: 'EXTERNAL_WORK_TYPE' as const, value: v.en, valueAr: v.ar, position: i,
    })),
  ];
  await prisma.refValue.createMany({ data: refValues, skipDuplicates: true });
  console.log(`  reference values      ${refValues.length} (+ ${COLORS.length} colours, ${SIZES.length} sizes)`);

  // ── Clients and factories ─────────────────────────────────────────────────
  for (const c of CLIENTS) {
    const existing = await prisma.client.findFirst({ where: { name: c.name } });
    if (!existing) {
      await prisma.client.create({
        data: { name: c.name, shippingAddress: c.shippingAddress, billingAddress: c.billingAddress },
      });
    }
  }
  for (const f of FACTORIES) {
    const existing = await prisma.factory.findFirst({ where: { name: f.name } });
    if (!existing) await prisma.factory.create({ data: f });
  }
  console.log(`  clients / factories   ${CLIENTS.length} / ${FACTORIES.length}`);

  // ── Workflow templates — Progress Status!C8:I34 ───────────────────────────
  for (const [i, t] of WORKFLOW_TEMPLATE.entries()) {
    await prisma.taskTemplate.upsert({
      where: { key: t.key },
      create: {
        key: t.key, stageKey: t.stageKey as StageKey, department: t.department as never,
        title: t.title, requirementEn: t.requirementEn, requirementAr: t.requirementAr,
        estimatedMinutes: t.estimatedMinutes, sequence: t.sequence,
        priority: t.priority, critical: t.critical, position: i,
      },
      update: {
        title: t.title, requirementEn: t.requirementEn, requirementAr: t.requirementAr,
        estimatedMinutes: t.estimatedMinutes, sequence: t.sequence, position: i,
      },
    });
  }
  console.log(`  task templates        ${WORKFLOW_TEMPLATE.length} (from Progress Status)`);

  // ── PO A302059B ───────────────────────────────────────────────────────────
  const existing = await prisma.order.findUnique({ where: { poNumber: ORDER.poNumber } });
  if (existing) {
    console.log(`\n  Order ${ORDER.poNumber} already exists — skipping.\n`);
    return;
  }

  const client = await prisma.client.findFirstOrThrow({ where: { name: ORDER.clientName } });
  const factory = await prisma.factory.findFirstOrThrow({ where: { name: ORDER.externalFactoryName } });
  const coordinator = await prisma.user.findFirstOrThrow({ where: { name: ORDER.coordinatorName } });
  const outsideWorkManager = await prisma.user.findFirstOrThrow({ where: { name: ORDER.outsideWorkManagerName } });
  const warehouse = await prisma.user.findFirstOrThrow({ where: { department: 'WAREHOUSE' } });
  const cutting = await prisma.user.findFirstOrThrow({ where: { department: 'CUTTING_MARKER' } });
  const productionMgr = await prisma.user.findFirstOrThrow({ where: { department: 'PRODUCTION_MANAGER' } });
  const factoryMgr = await prisma.user.findFirstOrThrow({ where: { department: 'FACTORY_MANAGER' } });

  const poDate = new Date(`${ORDER.poDate}T00:00:00Z`);
  const shipDate = new Date(`${ORDER.promisedShippingDate}T00:00:00Z`);
  const deliveryDate = new Date(`${ORDER.requiredDeliveryDate}T00:00:00Z`);

  const order = await prisma.order.create({
    data: {
      poNumber: ORDER.poNumber,
      orderName: ORDER.orderName,
      season: ORDER.season,
      itemType: ORDER.itemType,
      gender: ORDER.gender,
      styleNumber: ORDER.styleNumber,
      fabric: ORDER.fabric,
      shippingMethod: ORDER.shippingMethod,
      pricePerPieceUsd: ORDER.pricePerPieceUsd,
      cutPercentage: ORDER.cutPercentage,
      accessoryPercentage: ORDER.accessoryPercentage,
      poDate, promisedShippingDate: shipDate, requiredDeliveryDate: deliveryDate,
      externalWorkSort: ORDER.externalWorkSort,
      externalWorkType: ORDER.externalWorkTypeAr,
      shippingAddress: ORDER.shippingAddress,
      billingAddress: ORDER.billingAddress,
      priority: 'HIGH',
      clientId: client.id,
      externalFactoryId: factory.id,
      factoryId: factory.id,
      coordinatorId: coordinator.id,
      outsideWorkManagerId: outsideWorkManager.id,
    },
  });

  // Axes
  const colorIds = new Map<string, string>();
  for (const [i, name] of Object.keys(ORDER_MATRIX).entries()) {
    const ref = await prisma.refColor.findUniqueOrThrow({ where: { name } });
    const oc = await prisma.orderColor.create({
      data: { orderId: order.id, colorId: ref.id, productName: PRODUCT_NAMES[name], position: i },
    });
    colorIds.set(name, oc.id);
  }

  const sizeIds = new Map<string, string>();
  for (const [i, name] of ORDER_SIZES.entries()) {
    const ref = await prisma.refSize.findUniqueOrThrow({ where: { name } });
    const os = await prisma.orderSize.create({ data: { orderId: order.id, sizeId: ref.id, position: i } });
    sizeIds.set(name, os.id);
  }

  // ORDER ledger — 1,972 pieces
  const orderCells: Prisma.StageQuantityCreateManyInput[] = [];
  for (const [color, row] of Object.entries(ORDER_MATRIX)) {
    const orderColorId = colorIds.get(color)!;
    row.forEach((qty, i) => {
      const orderSizeId = sizeIds.get(ORDER_SIZES[i]!)!;
      if (qty > 0) orderCells.push({ orderId: order.id, orderColorId, orderSizeId, ledger: 'ORDER', qty });
    });
  }
  await prisma.stageQuantity.createMany({ data: orderCells });

  // CUT ledger — computed, not transcribed. Yields exactly 2,084.
  const axesColors: AxisRef[] = [...colorIds.entries()].map(([name, id], i) => ({ id, name, position: i }));
  const axesSizes: AxisRef[] = [...sizeIds.entries()].map(([name, id], i) => ({ id, name, position: i }));
  const cells: QtyCell[] = orderCells.map((c) => ({
    colorId: c.orderColorId, sizeId: c.orderSizeId, ledger: 'ORDER' as const, qty: c.qty!,
  }));
  const cutCells = computeCutMatrix(cells, axesColors, axesSizes, ORDER.cutPercentage);
  await prisma.stageQuantity.createMany({
    data: cutCells.map((c) => ({
      orderId: order.id, orderColorId: c.colorId, orderSizeId: c.sizeId, ledger: 'CUT' as const, qty: c.qty,
    })),
  });

  const orderTotal = orderCells.reduce((a, c) => a + (c.qty ?? 0), 0);
  const cutTotal = cutCells.reduce((a, c) => a + c.qty, 0);
  console.log(`\n  Order ${ORDER.poNumber} — ${ORDER.orderName}`);
  console.log(`    ordered             ${orderTotal.toLocaleString()} pcs`);
  console.log(`    cut (5% allowance)  ${cutTotal.toLocaleString()} pcs`);

  // Notes
  for (const [kind, body] of Object.entries(NOTES)) {
    await prisma.orderNote.create({ data: { orderId: order.id, kind: kind as never, body } });
  }

  // ── Workflow: 17 stages, 27 tasks ─────────────────────────────────────────
  const stageIds = new Map<StageKey, string>();
  for (const stageKey of Object.keys(STAGE_META) as StageKey[]) {
    const s = await prisma.orderStage.create({ data: { orderId: order.id, stageKey } });
    stageIds.set(stageKey, s.id);
  }

  const assigneeFor: Record<string, string> = {
    COORDINATOR: coordinator.id,
    FACTORY_MANAGER: factoryMgr.id,
    PRODUCTION_MANAGER: productionMgr.id,
    CUTTING_MARKER: cutting.id,
    WAREHOUSE: warehouse.id,
    EXTERNAL_OPS: outsideWorkManager.id,
    PACKING: (await prisma.user.findFirstOrThrow({ where: { department: 'PACKING' } })).id,
    QUALITY: (await prisma.user.findFirstOrThrow({ where: { department: 'QUALITY' } })).id,
    FOLLOW_UP: (await prisma.user.findFirstOrThrow({ where: { department: 'FOLLOW_UP' } })).id,
    ADMIN: (await prisma.user.findFirstOrThrow({ where: { department: 'ADMIN' } })).id,
  };

  /**
   * Progress the demo order to a realistic mid-flight state: sequences 1–4 are
   * done, sequence 5 is where it is stuck (waiting on the customer's print
   * approval), and everything after is not started. That is exactly the state
   * the workbook describes.
   */
  const COMPLETED_THROUGH = 4;
  const taskIdByKey = new Map<string, string>();

  for (const t of WORKFLOW_TEMPLATE) {
    const done = t.sequence <= COMPLETED_THROUGH;
    const dueDate = planDueDate(t.sequence, poDate, shipDate);
    const completedAt = done
      ? new Date(poDate.getTime() + t.sequence * 2 * 86_400_000)
      : null;

    const task = await prisma.task.create({
      data: {
        orderId: order.id,
        orderStageId: stageIds.get(t.stageKey as StageKey)!,
        stageKey: t.stageKey as StageKey,
        templateKey: t.key,
        title: t.title,
        requirementEn: t.requirementEn,
        requirementAr: t.requirementAr,
        department: t.department as never,
        sequence: t.sequence,
        estimatedMinutes: t.estimatedMinutes,
        actualMinutes: done ? t.estimatedMinutes : null,
        priority: t.priority,
        dueDate,
        status: done ? 'COMPLETED' : t.sequence === COMPLETED_THROUGH + 1 ? 'IN_PROGRESS' : 'NOT_STARTED',
        startedAt: done ? new Date(poDate.getTime() + (t.sequence - 1) * 2 * 86_400_000) : null,
        completedAt,
        completedById: done ? assigneeFor[t.department] ?? null : null,
        assigneeId: assigneeFor[t.department] ?? null,
      },
    });
    taskIdByKey.set(t.key, task.id);
  }

  // The external-order task is blocked on the approval, not merely unstarted.
  await prisma.task.update({
    where: { id: taskIdByKey.get('EX_SEND_ORDER')! },
    data: {
      status: 'BLOCKED',
      blockedReason: 'Waiting for the customer to approve the print artwork. External Order note: برجاء عدم البدء ف طباعه الاوردر الا بعد موافقه العميل',
    },
  });

  console.log(`    tasks               ${WORKFLOW_TEMPLATE.length} (sequences 1–${COMPLETED_THROUGH} complete)`);

  // ── BOM — 23 lines, nothing issued, exactly as the file has it ────────────
  for (const [i, b] of BOM.entries()) {
    const refColor = b.color ? await prisma.refColor.findFirst({ where: { name: b.color } }) : null;
    await prisma.bomItem.create({
      data: {
        orderId: order.id,
        category: b.category as never,
        position: b.position,
        item: b.item,
        description: b.description,
        colorId: refColor?.id ?? null,
        colorText: refColor ? null : b.color,
        consumptionPerPiece: b.consumptionPerPiece,
        requiredQty: b.requiredQty,
        unit: b.unit,
        issuedQty: 0, // the live workbook has this column empty on every line
        position_: i,
      },
    });
  }
  console.log(`    BOM lines           ${BOM.length} (none issued — matches the file)`);

  await seedInventory(order.id, warehouse);

  // ── Markers ───────────────────────────────────────────────────────────────
  for (const [i, l] of LAYS.entries()) {
    await prisma.marker.create({
      data: {
        orderId: order.id, markerNumber: `M${i + 1}`,
        fabricName: l.fabric, fabricColor: l.color, panel: l.panel,
        sizeRatio: l.sizeRatio, layers: l.layers, markerLengthM: l.markerLengthM,
        totalLengthM: l.totalLengthM, nestPcs: l.nestPcs, position: i,
      },
    });
  }
  const totalLayers = LAYS.reduce((a, l) => a + l.layers, 0);
  const totalFabric = LAYS.reduce((a, l) => a + l.totalLengthM, 0);
  console.log(`    lays                ${LAYS.length} — ${totalLayers} layers, ${Math.round(totalFabric)} m`);

  await prisma.fabricRecord.create({
    data: {
      orderId: order.id, fabricName: 'Rosetta', colorName: 'White',
      requiredM: 1194, availableM: null, issuedM: null, actualConsumptionM: null,
      responsibleName: cutting.name,
    },
  });

  await prisma.cuttingRecord.create({
    data: {
      orderId: order.id,
      cutDate: new Date(poDate.getTime() + 9 * 86_400_000),
      cuttingTeam: 'Cutting floor', cutByName: cutting.name,
      actualCutQty: cutTotal, fabricUsedM: 1194,
    },
  });

  // ── Approval and external operation — the blocked gate ────────────────────
  const approval = await prisma.approval.create({
    data: {
      orderId: order.id,
      type: 'PRINT_ARTWORK',
      status: 'PENDING',
      blocking: true,
      requestedDate: new Date(poDate.getTime() + 8 * 86_400_000),
      requestedById: outsideWorkManager.id,
      sentTo: 'John Orr — Florida Celtic',
      comment: 'Full-piece print artwork sent for approval. Production cannot start until this returns.',
    },
  });

  for (const ec of EXTERNAL_COLORS) {
    await prisma.externalOperation.create({
      data: {
        orderId: order.id,
        externalFactoryId: factory.id,
        operationType: ORDER.externalWorkTypeEn,
        operationTypeAr: ORDER.externalWorkTypeAr,
        operationSort: 'Print',
        qty: ec.qty,
        unitRate: ec.rate,
        expectedReturnDate: new Date(poDate.getTime() + 20 * 86_400_000),
        status: 'WAITING_APPROVAL',
        requiresApproval: true,
        // All four colours share the one artwork approval.
        approvalId: ec.color === EXTERNAL_COLORS[0]!.color ? approval.id : null,
        notes: `Colour area ${ec.areaM} m at ${ec.rate} m/pc — ${ec.color}`,
        colorIds: [colorIds.get(ec.color)!],
      },
    });
  }
  console.log(`    external ops        ${EXTERNAL_COLORS.length} (blocked on customer approval)`);

  // ── Costing ───────────────────────────────────────────────────────────────
  const costing = await prisma.costingRecord.create({
    data: {
      orderId: order.id,
      costingDate: new Date(),
      dollarRate: COSTING.dollarRate,
      dailyCostEgp: COSTING.dailyCostEgp,
      machineCount: COSTING.machineCount,
      machineDaysUsed: COSTING.machineDaysUsed,
      daysInLine: COSTING.daysInLine,
      productionLineMachines: COSTING.productionLineMachines,
    },
  });

  for (const [i, l] of COST_LINES.entries()) {
    await prisma.costLine.create({
      data: {
        costingId: costing.id,
        group: l.group as never,
        label: l.label,
        unit: l.unit,
        unitPriceEgp: l.unitPriceEgp,
        unitPriceUsd: l.unitPriceUsd ?? (l.unitPriceEgp != null ? l.unitPriceEgp / COSTING.dollarRate : null),
        quantity: null, // not yet consumed — this is exactly why the sheet shows #DIV/0!
        position: i,
      },
    });
  }
  console.log(`    cost lines          ${COST_LINES.length} (unit cost not yet calculable — as in the file)`);

  // ── Demo production history ───────────────────────────────────────────────
  const today = new Date();
  const inLineByCell = new Map<string, number>();
  let sewnTotal = 0;

  for (const p of DEMO_PRODUCTION) {
    const date = new Date(today.getTime() + p.dayOffset * 86_400_000);
    await prisma.productionRecord.create({
      data: {
        orderId: order.id, date, operation: p.operation as never,
        qty: p.qty, line: p.line, recordedById: productionMgr.id,
        notes: 'Demo production history',
      },
    });
    if (p.operation === 'SEWING') sewnTotal += p.qty;
  }

  // Distribute the sewn pieces across the cut matrix so the IN_LINE ledger and
  // the production records tell the same story.
  //
  // Largest-remainder allocation rather than floor-and-dump-the-rest: flooring
  // forty cells loses up to forty pieces, and giving the remainder to the last
  // cell can exceed what that cell had cut. Either way the funnel would end up
  // disagreeing with the production total, which is exactly the class of
  // discrepancy this system exists to remove.
  const cutSum = cutCells.reduce((a, c) => a + c.qty, 0);
  const parts = cutCells.map((c) => {
    const exact = (c.qty / cutSum) * sewnTotal;
    return { c, base: Math.min(Math.floor(exact), c.qty), rem: exact - Math.floor(exact), cap: c.qty };
  });
  let left = Math.min(sewnTotal, cutSum) - parts.reduce((a, p) => a + p.base, 0);
  for (const p of [...parts].sort((a, b) => b.rem - a.rem)) {
    if (left > 0 && p.base < p.cap) { p.base++; left--; }
  }
  for (let i = 0; left > 0 && i < parts.length * 2; i++) {
    const p = parts[i % parts.length]!;
    if (p.base < p.cap) { p.base++; left--; }
  }
  for (const p of parts) {
    if (p.base > 0) inLineByCell.set(`${p.c.colorId}:${p.c.sizeId}`, p.base);
  }

  await prisma.stageQuantity.createMany({
    data: [...inLineByCell.entries()].map(([key, qty]) => {
      const [orderColorId, orderSizeId] = key.split(':') as [string, string];
      return { orderId: order.id, orderColorId, orderSizeId, ledger: 'IN_LINE' as const, qty };
    }),
  });
  console.log(`    production          ${sewnTotal.toLocaleString()} pcs sewn over ${DEMO_PRODUCTION.filter((p) => p.operation === 'SEWING').length} days`);

  // ── Activity history ──────────────────────────────────────────────────────
  const activity: Prisma.ActivityLogCreateManyInput[] = [
    { orderId: order.id, actorId: factoryMgr.id, actorName: factoryMgr.name, action: 'ORDER_CREATED', summary: `created order ${ORDER.poNumber} — ${ORDER.orderName}`, createdAt: poDate },
    { orderId: order.id, actorId: factoryMgr.id, actorName: factoryMgr.name, action: 'QUANTITIES_UPDATED', summary: 'entered the quantity matrix — 1,972 pcs across 4 colours', createdAt: new Date(poDate.getTime() + 1 * 3_600_000) },
    { orderId: order.id, actorId: coordinator.id, actorName: coordinator.name, action: 'ORDER_UPDATED', summary: 'set the cut allowance to 5% and confirmed the shipping address', createdAt: new Date(poDate.getTime() + 2 * 86_400_000) },
    { orderId: order.id, actorId: coordinator.id, actorName: coordinator.name, action: 'CUT_ORDER_GENERATED', summary: 'generated the cut order — 2,084 pieces at 5% allowance', createdAt: new Date(poDate.getTime() + 2 * 86_400_000 + 3_600_000) },
    { orderId: order.id, actorId: cutting.id, actorName: cutting.name, action: 'MARKER_ADDED', summary: 'added 6 lays — 408 layers consuming 1,194 m of Rosetta', createdAt: new Date(poDate.getTime() + 4 * 86_400_000) },
    { orderId: order.id, actorId: coordinator.id, actorName: coordinator.name, action: 'BOM_ITEM_ADDED', summary: 'completed the bill of materials — 23 lines', createdAt: new Date(poDate.getTime() + 5 * 86_400_000) },
    { orderId: order.id, actorId: outsideWorkManager.id, actorName: outsideWorkManager.name, action: 'APPROVAL_REQUESTED', summary: 'requested print artwork approval from John Orr — Florida Celtic', createdAt: new Date(poDate.getTime() + 8 * 86_400_000) },
    { orderId: order.id, actorId: cutting.id, actorName: cutting.name, action: 'CUTTING_RECORDED', summary: 'recorded cutting — 2,084 pcs', createdAt: new Date(poDate.getTime() + 9 * 86_400_000) },
  ];
  for (const p of DEMO_PRODUCTION.filter((x) => x.operation === 'SEWING')) {
    activity.push({
      orderId: order.id, actorId: productionMgr.id, actorName: productionMgr.name,
      action: 'PRODUCTION_RECORDED',
      summary: `recorded ${p.qty.toLocaleString()} pcs sewing on ${p.line}`,
      createdAt: new Date(today.getTime() + p.dayOffset * 86_400_000),
    });
  }
  await prisma.activityLog.createMany({ data: activity });

  // ── Notifications for the coordinator ─────────────────────────────────────
  await prisma.notification.createMany({
    data: [
      {
        userId: coordinator.id, orderId: order.id, type: 'APPROVAL_REQUESTED',
        title: `Print approval still outstanding on ${ORDER.poNumber}`,
        body: 'Full-piece printing cannot be released to AGE until the customer approves the artwork.',
        link: `/orders/${order.id}?tab=approvals`,
      },
      {
        userId: coordinator.id, orderId: order.id, type: 'MATERIAL_SHORTAGE',
        title: `All ${BOM.length} material lines outstanding on ${ORDER.poNumber}`,
        body: 'Nothing has been issued from the warehouse, including 2,084 poly bags and 1,194 m of Rosetta.',
        link: `/orders/${order.id}?tab=bom`,
      },
    ],
  });

  console.log(`\nDone.\n`);
  console.log(`  Sign in with any of these — password: ${DEFAULT_PASSWORD}`);
  console.log(`    hassona@age-factory.com   Order Coordinator  (the main user)`);
  console.log(`    admin@age-factory.com     Administrator`);
  console.log(`    khaled@age-factory.com    Warehouse`);
  console.log(`    helmy@age-factory.com     External Operations`);
  console.log(`    shimaa@age-factory.com    Quality`);
  console.log(`\n  Super administrators — must set a new password on first sign-in:`);
  for (const sa of SUPER_ADMINS) console.log(`    ${sa.email.padEnd(25)} ${sa.name}`);
  console.log('');
}

/**
 * Materials, stock, the movement ledger, and the reservations that make the
 * order's material position real rather than illustrative.
 *
 * Written directly against Prisma rather than through `inventory-service`,
 * because the service takes an authenticated actor and enforces rules that a
 * seed legitimately sits outside. The invariant the service guarantees is
 * preserved by hand here: **every balance equals the sum of its movements**, so
 * `reconcileStock()` reports no drift on a freshly seeded database.
 */
async function seedInventory(orderId: string, warehouseUser: { id: string; name: string }): Promise<void> {
  for (const l of INVENTORY_LOCATIONS) {
    await prisma.inventoryLocation.upsert({
      where: { name: l.name },
      create: l,
      update: { code: l.code, kind: l.kind },
    });
  }
  const mainStore = await prisma.inventoryLocation.findUniqueOrThrow({ where: { name: 'Main store' } });

  const byCode = new Map<string, string>();

  for (const m of MATERIALS) {
    const material = await prisma.material.upsert({
      where: { code: m.code },
      create: {
        code: m.code, name: m.name, type: m.type as never, unit: m.unit as never,
        colorName: m.colorName, composition: m.composition, gsm: m.gsm, widthCm: m.widthCm,
        sizeLabel: m.sizeLabel, supplierName: m.supplierName,
        minimumQty: m.minimumQty, unitCostUsd: m.unitCostUsd, notes: m.notes,
      },
      update: { name: m.name, minimumQty: m.minimumQty, unitCostUsd: m.unitCostUsd, notes: m.notes },
    });
    byCode.set(m.code, material.id);

    // Re-seeding must not double the stock, so the ledger is rebuilt rather
    // than appended to.
    await prisma.materialMovement.deleteMany({ where: { materialId: material.id } });
    await prisma.materialStock.deleteMany({ where: { materialId: material.id } });

    const history = MATERIAL_MOVEMENTS.filter((mv) => mv.code === m.code);

    if (history.length === 0) {
      // One opening receipt, so even a simple material has a traceable origin.
      await prisma.materialMovement.create({
        data: {
          materialId: material.id, locationId: mainStore.id,
          type: 'RECEIPT', qty: m.physicalQty, unit: m.unit as never,
          balanceAfter: m.physicalQty,
          reason: 'Opening stock', actorId: warehouseUser.id, actorName: warehouseUser.name,
          occurredAt: daysAgo(90),
        },
      });
    } else {
      let balance = 0;
      for (const mv of history) {
        const signed = mv.type === 'RECEIPT' || mv.type === 'RETURN' || mv.type === 'TRANSFER_IN'
          ? mv.qty : -mv.qty;
        balance = Math.round((balance + signed) * 10_000) / 10_000;
        await prisma.materialMovement.create({
          data: {
            materialId: material.id, locationId: mainStore.id,
            type: mv.type as never, qty: mv.qty, unit: m.unit as never,
            balanceAfter: balance, reason: mv.reason, batchLot: mv.batchLot,
            actorId: warehouseUser.id, actorName: warehouseUser.name,
            occurredAt: daysAgo(mv.daysAgo),
          },
        });
      }
      if (balance !== m.physicalQty) {
        // Loud, because a seed whose ledger disagrees with its balance would
        // make the reconciliation tool look broken on first use.
        throw new Error(
          `Seed inconsistency: ${m.code} movements sum to ${balance} but physicalQty says ${m.physicalQty}.`,
        );
      }
    }

    await prisma.materialStock.create({
      data: { materialId: material.id, locationId: mainStore.id, physicalQty: m.physicalQty },
    });
  }

  console.log(`    materials           ${MATERIALS.length} (${MATERIAL_MOVEMENTS.length + MATERIALS.length - MATERIAL_MOVEMENTS.filter((m) => MATERIALS.some((x) => x.code === m.code)).length} movements)`);

  // ── Link BOM lines to the catalogue ──────────────────────────────────────
  const bomItems = await prisma.bomItem.findMany({ where: { orderId }, include: { color: true } });
  let linked = 0;

  for (const m of MATERIALS) {
    if (!m.bomMatch) continue;
    const materialId = byCode.get(m.code)!;
    for (const match of m.bomMatch) {
      for (const b of bomItems) {
        if (b.materialId) continue;
        if (b.item !== match.item) continue;
        if (match.description && b.description !== match.description) continue;
        if (match.color) {
          const colour = b.color?.name ?? b.colorText ?? '';
          if (colour.toLowerCase() !== match.color.toLowerCase()) continue;
        }
        await prisma.bomItem.update({ where: { id: b.id }, data: { materialId } });
        b.materialId = materialId;
        linked++;
      }
    }
  }
  console.log(`    BOM lines linked    ${linked} of ${bomItems.length} to catalogue materials`);

  // ── Reserve what the order can actually get ──────────────────────────────
  //
  // Reserving the available quantity rather than the required one is the point:
  // Rosetta White has 718 m against a 1,194 m requirement, so 718 is reserved
  // and 476 is reported short. That shortage is what blocks the cutting stage
  // when the order is opened, which is the whole demonstration.
  const linkedItems = await prisma.bomItem.findMany({
    where: { orderId, materialId: { not: null } },
    include: { material: { include: { stock: true } } },
  });

  let reservedLines = 0;
  let shortLines = 0;

  for (const b of linkedItems) {
    if (!b.material) continue;
    const physical = b.material.stock.reduce((a, s) => a + Number(s.physicalQty.toString()), 0);
    const alreadyReserved = await prisma.materialReservation.aggregate({
      where: { materialId: b.materialId!, status: 'ACTIVE' },
      _sum: { qty: true, consumedQty: true },
    });
    const outstandingReserved =
      Number(alreadyReserved._sum.qty?.toString() ?? 0) - Number(alreadyReserved._sum.consumedQty?.toString() ?? 0);
    const available = Math.max(0, physical - outstandingReserved);

    const required = Number(b.requiredQty.toString());
    const toReserve = Math.min(required, available);

    if (toReserve > 0) {
      await prisma.materialReservation.create({
        data: {
          materialId: b.materialId!, orderId, bomItemId: b.id,
          qty: toReserve, unit: b.material.unit,
          reservedById: warehouseUser.id,
          notes: toReserve < required ? 'Partial — all that was available' : null,
        },
      });
      reservedLines++;
    }
    if (toReserve < required) shortLines++;
  }

  console.log(`    reservations        ${reservedLines} lines reserved, ${shortLines} short`);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
