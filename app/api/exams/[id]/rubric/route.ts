import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getActiveRubricVersion,
  checkRubricApprovable,
} from "@/lib/rubric";
import { prismaError, notFound, unprocessable } from "@/lib/api-errors";

// GET /api/exams/:id/rubric - the active version (latest APPROVED, else latest
// DRAFT) with questions, criteria and baselines nested. One canonical shape
// for the review UI and the grading worker.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const version = await getActiveRubricVersion(examId);
    if (!version) {
      return notFound("No rubric yet; generate baselines first");
    }

    const [questions, criteria, baselines, history] = await Promise.all([
      db.question.findMany({ where: { examId }, orderBy: { sortOrder: "asc" } }),
      db.rubricCriterion.findMany({
        where: { rubricVersionId: version.id },
        orderBy: { sortOrder: "asc" },
      }),
      db.baselineSolution.findMany({ where: { rubricVersionId: version.id } }),
      db.rubricVersion.findMany({
        where: { examId },
        orderBy: { version: "desc" },
        select: { id: true, version: true, status: true, approvedAt: true },
      }),
    ]);

    const critByQ = new Map<string, typeof criteria>();
    for (const c of criteria) {
      const list = critByQ.get(c.questionId) ?? [];
      list.push(c);
      critByQ.set(c.questionId, list);
    }
    const baseByQ = new Map(baselines.map((b) => [b.questionId, b]));

    return NextResponse.json({
      rubricVersion: {
        id: version.id,
        version: version.version,
        status: version.status,
        approvedAt: version.approvedAt,
      },
      history,
      questions: questions.map((q) => ({
        id: q.id,
        qNo: q.qNo,
        text: q.text,
        maxMarks: q.maxMarks,
        qType: q.qType,
        topic: q.topic,
        criteria: critByQ.get(q.id) ?? [],
        baseline: baseByQ.get(q.id) ?? null,
      })),
    });
  } catch (e) {
    if (e instanceof NextResponse) throw e;
    return prismaError(e);
  }
}

// POST /api/exams/:id/rubric/approve - faculty approves the draft rubric.
// Validates everything (422 with per-question detail), then freezes the
// version in a transaction and moves the exam to READY.
// Double approve is a 200 no-op; approvals never rewrite old evaluations.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const draft = await db.rubricVersion.findFirst({
      where: { examId, status: "DRAFT" },
      orderBy: { version: "desc" },
    });

    if (!draft) {
      // Nothing to approve: either already approved or nothing generated.
      const active = await getActiveRubricVersion(examId);
      if (active && active.status === "APPROVED") {
        return NextResponse.json({
          ok: true,
          deduped: true,
          rubricVersion: {
            id: active.id,
            version: active.version,
            status: active.status,
          },
        });
      }
      return NextResponse.json(
        { error: "No draft rubric to approve; generate baselines first" },
        { status: 422 }
      );
    }

    const check = await checkRubricApprovable(draft.id);
    if (!check.ok) {
      return unprocessable("Rubric is not ready for approval", check.problems);
    }

    const approved = await db.$transaction(async (tx) => {
      const v = await tx.rubricVersion.update({
        where: { id: draft.id },
        data: { status: "APPROVED", approvedAt: new Date() },
      });
      await tx.exam.update({
        where: { id: examId },
        data: { status: "READY" },
      });
      return v;
    });

    return NextResponse.json({
      ok: true,
      rubricVersion: {
        id: approved.id,
        version: approved.version,
        status: approved.status,
        approvedAt: approved.approvedAt,
      },
    });
  } catch (e) {
    if (e instanceof NextResponse) throw e;
    return prismaError(e);
  }
}
