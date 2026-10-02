import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, notFound } from "@/lib/api-errors";

// GET /api/evaluations/:id/status - progress for the evaluation queue UI.
// Resumable: counts derive from persisted rows, not worker memory.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const evaluation = await db.evaluation.findUnique({
      where: { id },
      include: {
        sheet: {
          include: { _count: { select: { pages: true } } },
        },
      },
    });
    if (!evaluation) return notFound("Evaluation not found");

    const questionCount = await db.question.count({
      where: { examId: evaluation.sheet.examId },
    });
    const [extractedCount, gradedCount, flaggedCount] = await Promise.all([
      db.extractedAnswer.count({ where: { sheetId: evaluation.sheetId } }),
      db.questionEvaluation.count({ where: { evaluationId: id } }),
      db.questionEvaluation.count({
        where: {
          evaluationId: id,
          OR: [{ confidence: "LOW" }, { flags: { isEmpty: false } }],
        },
      }),
    ]);

    const jobs = await db.job.findMany({
      where: {
        status: { in: ["queued", "running", "retryable", "failed"] },
        payload: { path: ["evaluationId"], equals: id },
      },
      select: { type: true, status: true, lastError: true },
    });

    const failed = jobs.filter((j) => j.status === "failed");
    const active = jobs.some((j) => ["queued", "running", "retryable"].includes(j.status));

    let status = evaluation.status;
    if (failed.length > 0 && !active) status = "NEEDS_REVIEW";
    else if (gradedCount >= questionCount && questionCount > 0) status = "DONE";
    else if (active || gradedCount > 0) status = "RUNNING";

    if (status !== evaluation.status) {
      await db.evaluation.update({
        where: { id },
        data: {
          status,
          ...(status === "DONE" ? { finishedAt: new Date() } : {}),
        },
      });
    }

    return NextResponse.json({
      status,
      questions: questionCount,
      matched: extractedCount,
      graded: gradedCount,
      flagged: flaggedCount,
      failedJobs: failed.map((j) => ({ type: j.type, error: j.lastError })),
    });
  } catch (e) {
    return prismaError(e);
  }
}
