import { db } from "./db";

// Active version rule (documented in exactly one place):
// active = the highest version with status APPROVED; if none is approved,
// the latest DRAFT. History is kept; approvals never rewrite old versions.
export async function getActiveRubricVersion(examId: string) {
  const approved = await db.rubricVersion.findFirst({
    where: { examId, status: "APPROVED" },
    orderBy: { version: "desc" },
  });
  if (approved) return approved;
  return db.rubricVersion.findFirst({
    where: { examId },
    orderBy: { version: "desc" },
  });
}

export async function getDraftRubricVersion(examId: string) {
  return db.rubricVersion.findFirst({
    where: { examId, status: "DRAFT" },
    orderBy: { version: "desc" },
  });
}

// Get the current draft version, creating v1 (or v+1) when none exists.
export async function getOrCreateDraftVersion(examId: string) {
  const existing = await getDraftRubricVersion(examId);
  if (existing) return existing;
  const max = await db.rubricVersion.aggregate({
    where: { examId },
    _max: { version: true },
  });
  return db.rubricVersion.create({
    data: { examId, version: (max._max.version ?? 0) + 1, status: "DRAFT" },
  });
}

export interface RubricCheck {
  ok: boolean;
  problems: Array<{ qNo: string; issue: string }>;
}

// Approve-time validation. 422 with per-question detail on failure.
export async function checkRubricApprovable(
  rubricVersionId: string
): Promise<RubricCheck> {
  const version = await db.rubricVersion.findUnique({
    where: { id: rubricVersionId },
    include: { exam: { include: { questions: true } } },
  });
  if (!version) return { ok: false, problems: [{ qNo: "-", issue: "Rubric version not found" }] };

  const problems: Array<{ qNo: string; issue: string }> = [];
  if (version.exam.questions.length === 0) {
    problems.push({ qNo: "-", issue: "Cannot approve a rubric with no questions" });
  }

  const criteria = await db.rubricCriterion.findMany({ where: { rubricVersionId } });
  const baselines = await db.baselineSolution.findMany({ where: { rubricVersionId } });
  const byQuestion = new Map<string, typeof criteria>();
  for (const c of criteria) {
    const list = byQuestion.get(c.questionId) ?? [];
    list.push(c);
    byQuestion.set(c.questionId, list);
  }
  const baselineIds = new Set(baselines.map((b) => b.questionId));

  for (const q of version.exam.questions) {
    const crits = byQuestion.get(q.id) ?? [];
    if (crits.length === 0) {
      problems.push({ qNo: q.qNo, issue: "No marking criteria defined" });
      continue;
    }
    const sum = crits.reduce((s, c) => s + c.maxMarks, 0);
    if (Math.abs(sum - q.maxMarks) > 0.001) {
      problems.push({
        qNo: q.qNo,
        issue: `Criterion marks sum to ${sum}, question max is ${q.maxMarks}`,
      });
    }
    if (!baselineIds.has(q.id)) {
      problems.push({ qNo: q.qNo, issue: "No baseline solution generated" });
    }
  }

  return { ok: problems.length === 0, problems };
}
