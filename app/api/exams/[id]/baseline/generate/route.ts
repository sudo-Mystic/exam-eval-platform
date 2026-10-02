import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateDraftVersion } from "@/lib/rubric";
import { enqueue } from "@/lib/queue";
import { prismaError, notFound } from "@/lib/api-errors";

// POST /api/exams/:id/baseline/generate
// Idempotent: if a DRAFT version already has baselines (or a generate job is
// queued/running), returns 200 with the existing version instead of
// enqueueing again. The worker upserts and never overwrites facultyEdited rows.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const questionCount = await db.question.count({ where: { examId } });
    if (questionCount === 0) {
      return NextResponse.json(
        { error: "No questions to generate baselines for" },
        { status: 422 }
      );
    }

    const version = await getOrCreateDraftVersion(examId);

    const activeJob = await db.job.findFirst({
      where: {
        type: "generate-baseline",
        status: { in: ["queued", "running", "retryable"] },
        payload: { path: ["rubricVersionId"], equals: version.id },
      },
    });

    const baselineCount = await db.baselineSolution.count({
      where: { rubricVersionId: version.id },
    });

    if (activeJob || baselineCount > 0) {
      // Idempotent re-call: report existing state, do not duplicate work.
      return NextResponse.json({
        ok: true,
        deduped: true,
        rubricVersion: { id: version.id, version: version.version, status: version.status },
        baselines: baselineCount,
        jobRunning: !!activeJob,
      });
    }

    await enqueue("generate-baseline", { examId, rubricVersionId: version.id });

    return NextResponse.json(
      {
        ok: true,
        deduped: false,
        rubricVersion: { id: version.id, version: version.version, status: version.status },
      },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof NextResponse) throw e;
    return prismaError(e);
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Thin alias so the UI can poll generation progress without knowing job ids.
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");
    const version = await getOrCreateDraftVersion(examId);
    const [baselines, questions] = await Promise.all([
      db.baselineSolution.count({ where: { rubricVersionId: version.id } }),
      db.question.count({ where: { examId } }),
    ]);
    const activeJob = await db.job.findFirst({
      where: {
        type: "generate-baseline",
        status: { in: ["queued", "running", "retryable", "failed"] },
        payload: { path: ["rubricVersionId"], equals: version.id },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      rubricVersion: { id: version.id, version: version.version, status: version.status },
      total: questions,
      baselines,
      jobStatus: activeJob?.status ?? (baselines >= questions && questions > 0 ? "done" : "idle"),
      lastError: activeJob?.lastError ?? null,
    });
  } catch (e) {
    if (e instanceof NextResponse) throw e;
    return prismaError(e);
  }
}
