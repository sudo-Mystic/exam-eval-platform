import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getActiveRubricVersion } from "@/lib/rubric";
import { enqueue } from "@/lib/queue";
import { prismaError, notFound, conflict } from "@/lib/api-errors";

// POST /api/sheets/:id/evaluate - start (or resume) AI evaluation.
// Requires an APPROVED rubric. Idempotent: returns the existing evaluation
// for the active version instead of duplicating work. Resume continues from
// the first incomplete question.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sheetId } = await params;
  try {
    const sheet = await db.answerSheet.findUnique({
      where: { id: sheetId },
      include: { _count: { select: { pages: true } } },
    });
    if (!sheet) return notFound("Sheet not found");
    if (sheet._count.pages === 0) {
      return NextResponse.json(
        { error: "Sheet has no pages; capture them first" },
        { status: 422 }
      );
    }

    const version = await getActiveRubricVersion(sheet.examId);
    if (!version || version.status !== "APPROVED") {
      return NextResponse.json(
        { error: "Rubric is not approved yet; approve it before grading" },
        { status: 422 }
      );
    }

    let evaluation = await db.evaluation.findFirst({
      where: { sheetId, rubricVersionId: version.id },
      orderBy: { createdAt: "desc" },
    });

    if (!evaluation) {
      evaluation = await db.evaluation.create({
        data: {
          sheetId,
          rubricVersionId: version.id,
          status: "QUEUED",
          startedAt: new Date(),
        },
      });
    }

    // Resume: enqueue question-match only if no match job is active and no
    // extracted answers exist yet.
    const [activeMatch, extractedCount] = await Promise.all([
      db.job.findFirst({
        where: {
          type: "question-match",
          status: { in: ["queued", "running", "retryable"] },
          payload: { path: ["evaluationId"], equals: evaluation.id },
        },
      }),
      db.extractedAnswer.count({ where: { sheetId } }),
    ]);

    if (!activeMatch && extractedCount === 0) {
      await enqueue("question-match", {
        examId: sheet.examId,
        sheetId,
        evaluationId: evaluation.id,
      });
      await db.evaluation.update({
        where: { id: evaluation.id },
        data: { status: "RUNNING" },
      });
    } else {
      // Resume grading for questions that have extracted answers but no evaluation.
      const extracted = await db.extractedAnswer.findMany({
        where: { sheetId },
        select: { questionId: true },
      });
      const done = await db.questionEvaluation.findMany({
        where: { evaluationId: evaluation.id },
        select: { questionId: true },
      });
      const doneIds = new Set(done.map((d) => d.questionId));
      for (const e of extracted) {
        if (!doneIds.has(e.questionId)) {
          const activeGrade = await db.job.findFirst({
            where: {
              type: "grade-question",
              status: { in: ["queued", "running", "retryable"] },
              payload: { path: ["evaluationId"], equals: evaluation.id },
            },
          });
          if (!activeGrade) {
            await enqueue("grade-question", {
              examId: sheet.examId,
              sheetId,
              evaluationId: evaluation.id,
              questionId: e.questionId,
            });
          }
        }
      }
    }

    return NextResponse.json({ evaluation: { id: evaluation.id, status: "RUNNING" } }, { status: 202 });
  } catch (e) {
    return prismaError(e);
  }
}
