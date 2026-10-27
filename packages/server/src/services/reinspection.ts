/**
 * Which failed inspection a new one is the re-inspection of.
 *
 * Right-first-time counts only first inspections, and tells them apart by
 * `QualityAudit.reinspectionOf`. Nothing ever wrote that column, so every
 * re-inspection after a FAIL counted as a fresh first inspection: an order that
 * failed once and passed on the second look scored 50% instead of 0%, and the
 * figure flattered every line that had to redo work.
 *
 * The rule: a new audit re-inspects the most recent earlier FAIL of the same
 * order and audit type that has not already been re-inspected. Each FAIL is
 * answered once; a re-inspection that fails again is itself the FAIL the next
 * one answers. Different audit types are different checkpoints, so a pass at
 * final audit is never read as the re-inspection of a failed inline check.
 */

export interface FailedAudit {
  id: string;
  inspectionDate: Date;
  createdAt: Date;
}

/**
 * Pure, so the rule can be tested by value. `fails` are the FAIL audits of the
 * same order and audit type; `answered` the ids some audit already re-inspects;
 * `at` the new audit's inspection date. A FAIL dated after the new audit is not
 * one it could have re-inspected.
 */
export function pickReinspectionTarget(
  fails: readonly FailedAudit[],
  answered: ReadonlySet<string>,
  at: Date,
): string | null {
  const open = fails
    .filter((f) => !answered.has(f.id) && f.inspectionDate.getTime() <= at.getTime())
    .sort((a, b) =>
      b.inspectionDate.getTime() - a.inspectionDate.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
  return open[0]?.id ?? null;
}
