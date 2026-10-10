/**
 * Factory productivity aggregation.
 *
 * The property these tests guard is that a number on the productivity screen
 * is always a sum of records somebody entered, and that the absence of records
 * is reported as absence — never as zero.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ProductionOperation } from '../enums.js';
import {
  summariseOutput, summariseByOrder, summariseDefectRate, summariseFabricUtilisation, summariseFactory,
  compareTrend, periodRange, previousRange, rangeBounds, daysInRange, enumerateDays,
  isDayKey, shiftDay, PRODUCTION_OPERATIONS, STAGE_ORDER,
  summariseLabour, summariseRft, summariseDelivery,
  type ProductivityRecordInput,
} from './productivity.js';

const rec = (
  date: string, operation: ProductionOperation, qty: number, orderId = 'o1', extra: Partial<ProductivityRecordInput> = {},
): ProductivityRecordInput => ({ id: `${orderId}-${date}-${operation}-${qty}`, orderId, date, operation, qty, ...extra });

const WEEK = { from: '2026-10-05', to: '2026-10-11' }; // Monday to Sunday

describe('daily output by operation', () => {
  test('one row per calendar day of the range, even days with nothing', () => {
    const s = summariseOutput([], WEEK);
    assert.equal(s.days.length, 7);
    assert.deepEqual(s.days.map((d) => d.date), enumerateDays(WEEK));
    assert.equal(s.calendarDays, 7);
  });

  test('records on the same day and operation are summed; other operations stay null', () => {
    const s = summariseOutput([
      rec('2026-10-06', 'SEWING', 400, 'o1'),
      rec('2026-10-06', 'SEWING', 250, 'o2'),
      rec('2026-10-06', 'CUTTING', 900, 'o1'),
    ], WEEK);
    const tue = s.days.find((d) => d.date === '2026-10-06')!;
    assert.equal(tue.byOperation.SEWING, 650);
    assert.equal(tue.byOperation.CUTTING, 900);
    assert.equal(tue.byOperation.PACKING, null, 'nobody recorded packing, so it is unknown');
    assert.equal(tue.primary, 650);
    assert.equal(tue.recorded, true);
    assert.equal(tue.recordCount, 3);
    assert.equal(tue.orderCount, 2);
  });

  test('a zero-quantity record is zero output, a missing record is not', () => {
    const s = summariseOutput([rec('2026-10-07', 'SEWING', 0)], WEEK);
    const wed = s.days.find((d) => d.date === '2026-10-07')!;
    const thu = s.days.find((d) => d.date === '2026-10-08')!;
    assert.equal(wed.primary, 0, 'an explicit zero was entered');
    assert.equal(wed.recorded, true);
    assert.equal(thu.primary, null, 'nothing was entered');
    assert.equal(thu.recorded, false);
  });

  test('a day with only cutting recorded does not report sewing as zero', () => {
    const s = summariseOutput([rec('2026-10-07', 'CUTTING', 500)], WEEK);
    const wed = s.days.find((d) => d.date === '2026-10-07')!;
    assert.equal(wed.recorded, true);
    assert.equal(wed.primary, null);
  });

  test('period totals and averages are over recorded days only', () => {
    const s = summariseOutput([
      rec('2026-10-05', 'SEWING', 300),
      rec('2026-10-06', 'SEWING', 500),
      rec('2026-10-07', 'CUTTING', 100), // recorded day, but no sewing
    ], WEEK);
    assert.equal(s.recordedDays, 3);
    assert.equal(s.unrecordedDays, 4);
    assert.equal(s.primaryQty, 800);
    assert.equal(s.primaryRecordedDays, 2);
    assert.equal(s.primaryAvgPerRecordedDay, 400, 'not 800 ÷ 7 and not 800 ÷ 3');
    assert.deepEqual(s.primaryPeakDay, { date: '2026-10-06', qty: 500 });

    const sewing = s.byOperation.find((o) => o.operation === 'SEWING')!;
    assert.equal(sewing.qty, 800);
    assert.equal(sewing.recordedDays, 2);
    assert.equal(sewing.avgPerRecordedDay, 400);
    const packing = s.byOperation.find((o) => o.operation === 'PACKING')!;
    assert.equal(packing.qty, null);
    assert.equal(packing.avgPerRecordedDay, null);
  });

  test('every operation appears in the breakdown in a fixed order', () => {
    const s = summariseOutput([], WEEK);
    assert.deepEqual(
      s.byOperation.map((o) => o.operation),
      ['CUTTING', 'SEWING', 'PRINTING', 'EMBROIDERY', 'PACKING'],
    );
  });

  test('the primary operation can be changed', () => {
    const s = summariseOutput([rec('2026-10-05', 'PACKING', 120)], WEEK, 'PACKING');
    assert.equal(s.primaryQty, 120);
  });
});

describe('date boundaries', () => {
  test('a record at the last second of the last day is inside; midnight after is not', () => {
    const s = summariseOutput([
      rec('2026-10-11T23:59:59.999Z', 'SEWING', 10),
      rec('2026-10-12T00:00:00.000Z', 'SEWING', 999),
      rec('2026-10-04T23:59:59.999Z', 'SEWING', 999),
    ], WEEK);
    assert.equal(s.primaryQty, 10);
  });

  test('database bounds are half-open: [start of first day, start of day after last)', () => {
    const b = rangeBounds(WEEK);
    assert.equal(b.start.toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(b.end.toISOString(), '2026-10-12T00:00:00.000Z');
  });

  test('a Date instance buckets on its UTC calendar day', () => {
    const s = summariseOutput([{ id: 'x', orderId: 'o', date: new Date('2026-10-09T00:00:00.000Z'), operation: 'SEWING', qty: 5 }], WEEK);
    assert.equal(s.days.find((d) => d.date === '2026-10-09')!.primary, 5);
  });

  test('a single-day range has one day and compares with the day before', () => {
    const r = periodRange('day', '2026-10-09');
    assert.deepEqual(r, { from: '2026-10-09', to: '2026-10-09' });
    assert.equal(daysInRange(r), 1);
    assert.deepEqual(previousRange(r), { from: '2026-10-08', to: '2026-10-08' });
  });

  test('a week runs Monday to Sunday whichever day is picked', () => {
    assert.deepEqual(periodRange('week', '2026-10-09'), WEEK); // a Friday
    assert.deepEqual(periodRange('week', '2026-10-05'), WEEK); // the Monday
    assert.deepEqual(periodRange('week', '2026-10-11'), WEEK); // the Sunday
    assert.deepEqual(previousRange(WEEK), { from: '2026-09-28', to: '2026-10-04' });
  });

  test('a month covers its own length, across a year end and in a leap year', () => {
    assert.deepEqual(periodRange('month', '2026-10-09'), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(periodRange('month', '2026-12-31'), { from: '2026-12-01', to: '2026-12-31' });
    assert.deepEqual(periodRange('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
    assert.deepEqual(periodRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  });

  test('the previous range of a month is the same number of days before it, not "last month"', () => {
    const oct = periodRange('month', '2026-10-15');
    assert.deepEqual(previousRange(oct), { from: '2026-08-31', to: '2026-09-30' });
    assert.equal(daysInRange(previousRange(oct)), 31);
  });

  test('day arithmetic crosses month and year ends', () => {
    assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  });

  test('only a real calendar day is accepted as a day key', () => {
    assert.equal(isDayKey('2026-10-09'), true);
    assert.equal(isDayKey('2026-02-30'), false);
    assert.equal(isDayKey('2026-13-01'), false);
    assert.equal(isDayKey('09/10/2026'), false);
    assert.equal(isDayKey('2026-10-09T00:00:00Z'), false);
    assert.equal(isDayKey(20261009), false);
  });
});

describe('trend', () => {
  test('a change is given only when both sides have data', () => {
    assert.equal(compareTrend(440, 400).changePct, 10);
    assert.equal(compareTrend(360, 400).changePct, -10);
    assert.deepEqual(compareTrend(null, 400), { current: null, previous: 400, changePct: null, reason: 'NO_CURRENT' });
    assert.deepEqual(compareTrend(400, null), { current: 400, previous: null, changePct: null, reason: 'NO_PREVIOUS' });
  });

  test('growth from an explicit zero is not a percentage', () => {
    const t = compareTrend(400, 0);
    assert.equal(t.changePct, null);
    assert.equal(t.reason, 'PREVIOUS_ZERO');
  });
});

describe('defect rate', () => {
  const audit = (date: string, sampleSize: number | null, defectQty: number | null, result: 'PASS' | 'FAIL' | 'PENDING' = 'PASS') =>
    ({ id: `${date}-${sampleSize}-${defectQty}`, orderId: 'o1', inspectionDate: date, sampleSize, defectQty, result });

  test('is pooled defects over pooled sample, not an average of percentages', () => {
    const s = summariseDefectRate([
      audit('2026-10-06', 80, 4),
      audit('2026-10-08', 20, 0),
    ], WEEK);
    assert.equal(s.defectRatePct, 4, '4 per 100, not the mean of 5% and 0%');
    assert.equal(s.auditCount, 2);
    assert.equal(s.countedAudits, 2);
  });

  test('defects are occurrences, so the rate can exceed one per piece and is not capped', () => {
    // Twelve defects found across a sample of ten pieces: some pieces carried
    // more than one. The figure is 120 defects per 100 inspected, and the
    // module must report it as such rather than clamp it to a share of pieces.
    const s = summariseDefectRate([audit('2026-10-06', 10, 12, 'FAIL')], WEEK);
    assert.equal(s.defectRatePct, 120);
  });

  test('an audit without a sample size is excluded and counted as excluded, not treated as zero', () => {
    const s = summariseDefectRate([
      audit('2026-10-06', 80, 4),
      audit('2026-10-07', null, null, 'PENDING'),
    ], WEEK);
    assert.equal(s.defectRatePct, 5);
    assert.equal(s.excludedAudits, 1);
    assert.equal(s.pendingCount, 1);
  });

  test('no audits in the period gives no rate and says why', () => {
    const s = summariseDefectRate([audit('2026-09-30', 80, 4)], WEEK);
    assert.equal(s.defectRatePct, null);
    assert.equal(s.reason, 'NO_AUDITS');
    const t = summariseDefectRate([audit('2026-10-06', null, null)], WEEK);
    assert.equal(t.defectRatePct, null);
    assert.equal(t.reason, 'NO_COUNTABLE_AUDITS');
  });

  test('failed audits are counted whatever their sample', () => {
    const s = summariseDefectRate([audit('2026-10-06', 80, 9, 'FAIL'), audit('2026-10-06', null, null, 'FAIL')], WEEK);
    assert.equal(s.failedCount, 2);
  });
});

describe('fabric utilisation', () => {
  const cut = (cutDate: string | null, actualCutQty: number | null, fabricUsedM: number | null) =>
    ({ id: `${cutDate}-${actualCutQty}`, orderId: 'o1', cutDate, actualCutQty, fabricUsedM });

  test('is total metres over total pieces across the period', () => {
    const s = summariseFabricUtilisation([cut('2026-10-05', 1000, 1200), cut('2026-10-06', 500, 450)], WEEK);
    assert.equal(s.metresPerPiece, 1.1);
    assert.equal(s.piecesCut, 1500);
    assert.equal(s.fabricUsedM, 1650);
  });

  test('a record missing the metres, the pieces or the date is excluded, not guessed', () => {
    const s = summariseFabricUtilisation([
      cut('2026-10-05', 1000, 1200),
      cut('2026-10-06', 500, null),
      cut('2026-10-07', null, 300),
      cut(null, 400, 400),
    ], WEEK);
    assert.equal(s.metresPerPiece, 1.2);
    assert.equal(s.recordCount, 3, 'the undated record cannot be placed in any period');
    assert.equal(s.countedRecords, 1);
    assert.equal(s.excludedRecords, 2);
  });

  test('nothing to count gives no figure and a reason', () => {
    assert.equal(summariseFabricUtilisation([], WEEK).reason, 'NO_RECORDS');
    assert.equal(summariseFabricUtilisation([cut('2026-10-05', 0, 0)], WEEK).reason, 'NO_COUNTABLE_RECORDS');
  });
});

describe('per-order drill-down', () => {
  test('groups the period\'s records by order, most sewing first', () => {
    const rows = summariseByOrder([
      rec('2026-10-05', 'SEWING', 100, 'small'),
      rec('2026-10-05', 'SEWING', 400, 'big'),
      rec('2026-10-06', 'SEWING', 300, 'big'),
      rec('2026-10-06', 'CUTTING', 50, 'cutonly'),
      rec('2026-10-01', 'SEWING', 9999, 'outside'),
    ], WEEK);
    assert.deepEqual(rows.map((r) => r.orderId), ['big', 'small', 'cutonly']);
    assert.equal(rows[0]!.primary, 700);
    assert.equal(rows[0]!.recordedDays, 2);
    assert.equal(rows[2]!.primary, null, 'cut-only order has no sewing figure, not zero');
    assert.equal(rows[2]!.byOperation.CUTTING, 50);
  });
});

describe('empty data', () => {
  test('an empty range produces nulls everywhere a figure would be, and no NaN', () => {
    const s = summariseOutput([], WEEK);
    assert.equal(s.recordedDays, 0);
    assert.equal(s.unrecordedDays, 7);
    assert.equal(s.primaryQty, null);
    assert.equal(s.primaryAvgPerRecordedDay, null);
    assert.equal(s.primaryPeakDay, null);
    for (const o of s.byOperation) {
      assert.equal(o.qty, null);
      assert.equal(o.avgPerRecordedDay, null);
    }
    assert.equal(JSON.stringify(s).includes('NaN'), false);
    assert.deepEqual(summariseByOrder([], WEEK), []);
  });
});

describe('factory overview', () => {
  const flow = [
    // One order, 100 garments, through four stages across the week.
    rec('2026-10-05', 'CUTTING', 100),
    rec('2026-10-06', 'PRINTING', 100),
    rec('2026-10-07', 'SEWING', 60),
    rec('2026-10-08', 'SEWING', 40),
    rec('2026-10-09', 'PACKING', 100),
  ];

  test('garments sewn is the unique output and is not the sum of every stage', () => {
    const f = summariseFactory(flow, WEEK);
    assert.equal(f.garmentsSewn, 100, 'sixty plus forty sewn');
    assert.equal(f.garmentsPacked, 100);
    // The five records carry 400 pieces between them, but they are the same
    // hundred garments at four stages. Nothing in the overview says 400.
    assert.equal(JSON.stringify(f).includes('400'), false);
    assert.equal('totalPieces' in f, false);
    assert.equal('total' in f, false);
  });

  test('stage throughput is in manufacturing order and says which stages were recorded', () => {
    const f = summariseFactory(flow, WEEK);
    assert.deepEqual(f.stages.map((s) => s.operation), STAGE_ORDER);
    assert.deepEqual(f.stages.map((s) => s.operation), ['CUTTING', 'PRINTING', 'EMBROIDERY', 'SEWING', 'PACKING']);
    assert.deepEqual(f.operationsRecorded, ['CUTTING', 'PRINTING', 'SEWING', 'PACKING']);
    assert.deepEqual(f.operationsUnrecorded, ['EMBROIDERY']);
    const embroidery = f.stages.find((s) => s.operation === 'EMBROIDERY')!;
    assert.equal(embroidery.qty, null, 'not recorded is null, not zero');
    assert.equal(embroidery.recorded, false);
    const sewing = f.stages.find((s) => s.operation === 'SEWING')!;
    assert.equal(sewing.recordedDays, 2);
    assert.equal(sewing.avgPerRecordedDay, 50);
  });

  test('activity counts come from the records in the range only', () => {
    const f = summariseFactory([...flow, rec('2026-10-01', 'SEWING', 999, 'other')], WEEK);
    assert.equal(f.recordCount, 5);
    assert.equal(f.activeOrders, 1);
    assert.equal(f.recordedDays, 5);
    assert.equal(f.unrecordedDays, 2);
    assert.equal(f.calendarDays, 7);
  });

  test('a period with only cutting has no garments sewn and no garments packed — unknown, not zero', () => {
    const f = summariseFactory([rec('2026-10-05', 'CUTTING', 500)], WEEK);
    assert.equal(f.garmentsSewn, null);
    assert.equal(f.sewnPerRecordedDay, null);
    assert.equal(f.garmentsPacked, null);
    assert.equal(f.recordedDays, 1);
    assert.deepEqual(f.operationsRecorded, ['CUTTING']);
  });

  test('an empty period has nulls, zero activity and no NaN', () => {
    const f = summariseFactory([], WEEK);
    assert.equal(f.garmentsSewn, null);
    assert.equal(f.garmentsPacked, null);
    assert.equal(f.recordCount, 0);
    assert.equal(f.activeOrders, 0);
    assert.deepEqual(f.operationsRecorded, []);
    assert.equal(f.operationsUnrecorded.length, 5);
    assert.equal(JSON.stringify(f).includes('NaN'), false);
  });

});

describe('operations', () => {
  test('the factory records exactly five operations; washing and finishing do not exist', () => {
    assert.deepEqual(PRODUCTION_OPERATIONS, ['CUTTING', 'SEWING', 'PRINTING', 'EMBROIDERY', 'PACKING']);
    assert.deepEqual(STAGE_ORDER, ['CUTTING', 'PRINTING', 'EMBROIDERY', 'SEWING', 'PACKING']);
    assert.equal((PRODUCTION_OPERATIONS as readonly string[]).includes('WASHING'), false);
    assert.equal((PRODUCTION_OPERATIONS as readonly string[]).includes('FINISHING'), false);
  });
});

describe('labour: line efficiency the way the floor computes it', () => {
  // The textbook example: 30 people for 8 hours (480 min), 410 pieces at a
  // 20-minute SAM → 8,200 produced minutes over 14,400 attended → 56.9%.
  const log = (date: string, operators: number | null, helpers: number | null, workingMinutes: number | null, machinesRunning: number | null = null) =>
    ({ date, operators, helpers, workingMinutes, machinesRunning });
  const sams = [{ orderId: 'o1', samMinutes: 20 }, { orderId: 'nosam', samMinutes: null }];

  test('efficiency = produced minutes over attended minutes, manpower including helpers, lost time not deducted', () => {
    const l = summariseLabour([rec('2026-10-05', 'SEWING', 410)], [log('2026-10-05', 25, 5, 480, 24)], sams, WEEK);
    assert.equal(l.producedMinutes, 8200);
    assert.equal(l.attendedMinutes, 14400);
    assert.equal(Math.round(l.efficiencyPct! * 10) / 10, 56.9);
    assert.equal(Math.round(l.producedSah! * 100) / 100, 136.67);
    assert.equal(l.piecesPerOperatorDay, 410 / 25, 'per operator, not per head');
    assert.equal(l.piecesPerMachineDay, 410 / 24);
    assert.equal(l.avgManpower, 30);
    assert.equal(l.countedDays, 1);
    assert.equal(l.reason, null);
  });

  test('the period figure is pooled, not an average of daily percentages', () => {
    const l = summariseLabour(
      [rec('2026-10-05', 'SEWING', 410), rec('2026-10-06', 'SEWING', 100)],
      [log('2026-10-05', 30, 0, 480), log('2026-10-06', 30, 0, 480)],
      sams, WEEK,
    );
    // 10,200 produced over 28,800 attended = 35.4%; the mean of 56.9% and 13.9% would be 35.4% here too,
    // so use unequal days: the big day must weigh more.
    const m = summariseLabour(
      [rec('2026-10-05', 'SEWING', 410), rec('2026-10-06', 'SEWING', 100)],
      [log('2026-10-05', 30, 0, 480), log('2026-10-06', 10, 0, 480)],
      sams, WEEK,
    );
    assert.equal(Math.round(l.efficiencyPct! * 10) / 10, 35.4);
    assert.equal(Math.round(m.efficiencyPct! * 10) / 10, Math.round((10200 / 19200) * 1000) / 10);
  });

  test('a sewing day without a day log is excluded and counted as such — never assumed', () => {
    const l = summariseLabour([rec('2026-10-05', 'SEWING', 410), rec('2026-10-06', 'SEWING', 400)], [log('2026-10-05', 30, 0, 480)], sams, WEEK);
    assert.equal(l.sewingDays, 2);
    assert.equal(l.loggedDays, 1);
    assert.equal(l.countedDays, 1);
    assert.equal(l.excluded.noLog, 1);
    assert.equal(l.producedMinutes, 8200, 'only the countable day');
  });

  test('a day with sewn pieces that have no SAM is excluded, and the order is named', () => {
    const l = summariseLabour(
      [rec('2026-10-05', 'SEWING', 410, 'o1'), rec('2026-10-05', 'SEWING', 50, 'nosam')],
      [log('2026-10-05', 30, 0, 480)], sams, WEEK,
    );
    assert.equal(l.efficiencyPct, null);
    assert.equal(l.excluded.samMissing, 1);
    assert.deepEqual(l.ordersWithoutSam, ['nosam']);
    assert.equal(l.reason, 'NO_COUNTABLE_DAYS');
    // Pieces per operator needs no SAM, so it still stands.
    assert.equal(l.piecesPerOperatorDay, 460 / 30);
  });

  test('a half-filled log — no minutes, or no operators — cannot give an efficiency', () => {
    const a = summariseLabour([rec('2026-10-05', 'SEWING', 410)], [log('2026-10-05', 30, 0, null)], sams, WEEK);
    assert.equal(a.efficiencyPct, null);
    assert.equal(a.excluded.logIncomplete, 1);
    const b = summariseLabour([rec('2026-10-05', 'SEWING', 410)], [log('2026-10-05', null, 5, 480)], sams, WEEK);
    assert.equal(b.efficiencyPct, null);
    assert.equal(b.piecesPerOperatorDay, null, 'no operator count, no per-operator figure');
  });

  test('a zero-output day with a full log is a real 0%, not a missing figure', () => {
    const l = summariseLabour([rec('2026-10-05', 'SEWING', 0)], [log('2026-10-05', 30, 0, 480)], sams, WEEK);
    assert.equal(l.efficiencyPct, 0);
    assert.equal(l.countedDays, 1);
  });

  test('no sewing, or no logs at all, say so', () => {
    assert.equal(summariseLabour([], [log('2026-10-05', 30, 0, 480)], sams, WEEK).reason, 'NO_SEWING');
    assert.equal(summariseLabour([rec('2026-10-05', 'SEWING', 10)], [], sams, WEEK).reason, 'NO_LOGS');
  });

  test('a log outside the range is ignored', () => {
    const l = summariseLabour([rec('2026-10-05', 'SEWING', 410)], [log('2026-10-04', 30, 0, 480)], sams, WEEK);
    assert.equal(l.loggedDays, 0);
  });
});

describe('right first time', () => {
  const a = (date: string, result: 'PASS' | 'FAIL' | 'PENDING', isReinspection = false) => ({ id: date + result, inspectionDate: date, result, isReinspection });

  test('is first inspections passed over first inspections decided; re-inspections are neither', () => {
    const r = summariseRft([a('2026-10-05', 'PASS'), a('2026-10-06', 'FAIL'), a('2026-10-07', 'PASS', true), a('2026-10-08', 'PENDING')], WEEK);
    assert.equal(r.rftPct, 50);
    assert.equal(r.firstInspections, 2);
    assert.equal(r.reinspections, 1);
    assert.equal(r.pending, 1);
  });

  test('nothing decided gives no figure and a reason', () => {
    assert.equal(summariseRft([], WEEK).reason, 'NO_AUDITS');
    assert.equal(summariseRft([a('2026-10-05', 'PENDING')], WEEK).reason, 'NO_DECIDED_FIRST_INSPECTIONS');
  });
});

describe('delivery', () => {
  const ship = (id: string, orderId: string, qty: number, actual: string | null, promised: string | null) =>
    ({ id, orderId, qty, actualShippingDate: actual, promisedShippingDate: promised });

  test('on time means shipped on or before the promised day', () => {
    const d = summariseDelivery([
      ship('s1', 'a', 100, '2026-10-05', '2026-10-05'),
      ship('s2', 'b', 100, '2026-10-06', '2026-10-05'),
      ship('s3', 'c', 100, '2026-10-07', '2026-10-09'),
      ship('s4', 'd', 100, '2026-10-07', null),
      ship('s5', 'e', 100, '2026-10-01', '2026-10-01'),
    ], [], WEEK);
    assert.equal(d.shipments, 4, 'the 1 October shipment is outside the week');
    assert.equal(d.onTime, 2);
    assert.equal(d.late, 1);
    assert.equal(d.noPromise, 1);
    assert.equal(Math.round(d.onTimePct!), 67);
    assert.equal(d.piecesShipped, 400);
  });

  test('cut-to-ship is total cut over total shipped for the orders shipped in the period', () => {
    const d = summariseDelivery(
      [ship('s1', 'a', 20000, '2026-10-05', '2026-10-05'), ship('s2', 'b', 100, '2026-10-06', '2026-10-06')],
      [{ orderId: 'a', cutQty: 20200, shippedQty: 20000 }, { orderId: 'b', cutQty: null, shippedQty: 100 }, { orderId: 'z', cutQty: 5, shippedQty: 1 }],
      WEEK,
    );
    assert.equal(d.cutToShipRatio, 1.01);
    assert.equal(d.cutToShipOrders, 1);
    assert.equal(d.cutToShipExcluded, 1, 'order b has no cut figure');
  });

  test('no shipments, or none with a promise, say so', () => {
    assert.equal(summariseDelivery([], [], WEEK).reason, 'NO_SHIPMENTS');
    assert.equal(summariseDelivery([ship('s', 'a', 1, '2026-10-05', null)], [], WEEK).reason, 'NO_PROMISES');
  });
});
