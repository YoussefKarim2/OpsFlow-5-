/**
 * Quality audit — the R02 Final Inspection report, sheet `Audit_Quality Manger`.
 *
 * The sheet carries its own AQL sampling table in C11:L16. That table is the
 * inspection rule, so it is encoded here rather than left as a printed
 * reference the auditor is trusted to read correctly.
 */

import { safePct } from './num.js';

export interface AqlBand {
  minQty: number;
  maxQty: number;
  sampleSize: number;
  acceptCount: number;
  rejectCount: number;
}

/** Verbatim from Audit_Quality Manger!C11:L16. */
export const AQL_TABLE: AqlBand[] = [
  { minQty: 16,    maxQty: 25,        sampleSize: 5,   acceptCount: 0,  rejectCount: 1 },
  { minQty: 26,    maxQty: 50,        sampleSize: 8,   acceptCount: 0,  rejectCount: 1 },
  { minQty: 51,    maxQty: 90,        sampleSize: 13,  acceptCount: 0,  rejectCount: 1 },
  { minQty: 91,    maxQty: 150,       sampleSize: 20,  acceptCount: 1,  rejectCount: 2 },
  { minQty: 151,   maxQty: 280,       sampleSize: 32,  acceptCount: 2,  rejectCount: 3 },
  { minQty: 281,   maxQty: 500,       sampleSize: 50,  acceptCount: 3,  rejectCount: 4 },
  { minQty: 501,   maxQty: 1200,      sampleSize: 80,  acceptCount: 5,  rejectCount: 6 },
  { minQty: 1201,  maxQty: 3200,      sampleSize: 125, acceptCount: 7,  rejectCount: 8 },
  { minQty: 3201,  maxQty: 10000,     sampleSize: 200, acceptCount: 10, rejectCount: 11 },
  { minQty: 10001, maxQty: Infinity,  sampleSize: 315, acceptCount: 14, rejectCount: 15 },
];

export function lookupAql(availableQty: number): AqlBand | null {
  return AQL_TABLE.find((b) => availableQty >= b.minQty && availableQty <= b.maxQty) ?? null;
}

export const DEFECT_CATEGORIES = [
  'COLOR_COMBINATION',
  'FABRIC_DEFECT',
  'CONSTRUCTION_STITCHING',
  'TRIMMING',
  'PRINT_EMBROIDERY',
  'CLEANLINESS',
  'PACKING',
  'MEASUREMENTS',
] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

export const DEFECT_LABEL: Record<DefectCategory, string> = {
  COLOR_COMBINATION: 'Colour combination',
  FABRIC_DEFECT: 'Fabric defect',
  CONSTRUCTION_STITCHING: 'Construction & stitching',
  TRIMMING: 'Trimming',
  PRINT_EMBROIDERY: 'Print & embroidery',
  CLEANLINESS: 'Cleanliness',
  PACKING: 'Packing',
  MEASUREMENTS: 'Measurements',
};

export interface AuditInput {
  availableQty: number;
  sampleSize?: number | null;
  defects: ReadonlyArray<{ category: DefectCategory; qty: number; comment?: string | null }>;
  /** Set only on a manual override by the quality manager. */
  manualResult?: 'PASS' | 'FAIL' | null;
}

export interface AuditResult {
  availableQty: number;
  band: AqlBand | null;
  /** The sample actually inspected, defaulting to the AQL requirement. */
  sampleSize: number | null;
  totalDefects: number;
  acceptedQty: number | null;
  rejectedQty: number;
  /** Verdict from the AQL table, before any override. */
  computedResult: 'PASS' | 'FAIL' | 'PENDING';
  /** What the audit actually says, override included. */
  result: 'PASS' | 'FAIL' | 'PENDING';
  overridden: boolean;
  defectRatePct: number | null;
  passRatePct: number | null;
  /** Populated on FAIL — becomes the corrective-action task body. */
  correctiveActionRequired: boolean;
  worstCategory: DefectCategory | null;
}

export function computeAudit(input: AuditInput): AuditResult {
  const band = lookupAql(input.availableQty);
  const sampleSize = input.sampleSize ?? band?.sampleSize ?? null;
  const totalDefects = input.defects.reduce((a, d) => a + d.qty, 0);

  let computedResult: 'PASS' | 'FAIL' | 'PENDING' = 'PENDING';
  if (band && sampleSize != null && sampleSize > 0) {
    computedResult = totalDefects >= band.rejectCount ? 'FAIL' : 'PASS';
  }

  const result = input.manualResult ?? computedResult;
  const rejectedQty = totalDefects;
  const acceptedQty = sampleSize != null ? Math.max(0, sampleSize - totalDefects) : null;

  let worstCategory: DefectCategory | null = null;
  let worstQty = 0;
  for (const d of input.defects) {
    if (d.qty > worstQty) { worstQty = d.qty; worstCategory = d.category; }
  }

  return {
    availableQty: input.availableQty,
    band,
    sampleSize,
    totalDefects,
    acceptedQty,
    rejectedQty,
    computedResult,
    result,
    overridden: input.manualResult != null && input.manualResult !== computedResult,
    defectRatePct: safePct(totalDefects, sampleSize),
    passRatePct: acceptedQty != null ? safePct(acceptedQty, sampleSize) : null,
    correctiveActionRequired: result === 'FAIL',
    worstCategory,
  };
}

/** Human summary for the corrective-action task the API auto-creates on FAIL. */
export function correctiveActionBody(a: AuditResult, defects: AuditInput['defects']): string {
  const lines = defects
    .filter((d) => d.qty > 0)
    .sort((x, y) => y.qty - x.qty)
    .map((d) => `• ${DEFECT_LABEL[d.category]}: ${d.qty}${d.comment ? ` — ${d.comment}` : ''}`);
  return [
    `Audit FAILED: ${a.totalDefects} defects in a sample of ${a.sampleSize ?? '—'} ` +
      `(AQL allows ${a.band?.acceptCount ?? '—'}, rejects at ${a.band?.rejectCount ?? '—'}).`,
    '',
    'Defects recorded:',
    ...lines,
    '',
    'Rework the affected pieces and request re-inspection before packing continues.',
  ].join('\n');
}
