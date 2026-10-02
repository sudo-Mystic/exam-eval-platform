import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getActiveRubricVersion } from "@/lib/rubric";
import { prismaError, notFound } from "@/lib/api-errors";

// GET /api/exams/:id - exam detail with pipeline status for the hub page.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const version = await getActiveRubricVersion(examId);
    const [questionCount, baselineCount, criterionCount, sheetCount, usage] =
      await Promise.all([
        db.question.count({ where: { examId } }),
        version
          ? db.baselineSolution.count({ where: { rubricVersionId: version.id } })
          : 0,
        version
          ? db.rubricCriterion.count({ where: { rubricVersionId: version.id } })
          : 0,
        db.answerSheet.count({ where: { examId } }),
        db.apiUsage.aggregate({
          where: { examId },
          _sum: { promptTokens: true, outputTokens: true },
          _count: true,
        }),
      ]);

    const jobs = await db.job.findMany({
      where: {
        status: { in: ["queued", "running", "retryable", "failed"] },
        OR: [
          { payload: { path: ["examId"], equals: examId } },
          { payload: { path: ["rubricVersionId"], equals: version?.id ?? "__none" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, type: true, status: true, lastError: true },
    });

    return NextResponse.json({
      exam,
      rubricVersion: version
        ? { id: version.id, version: version.version, status: version.status }
        : null,
      counts: {
        questions: questionCount,
        baselines: baselineCount,
        criteria: criterionCount,
        sheets: sheetCount,
      },
      usage: {
        calls: usage._count,
        promptTokens: usage._sum.promptTokens ?? 0,
        outputTokens: usage._sum.outputTokens ?? 0,
      },
      jobs,
    });
  } catch (e) {
    if (e instanceof NextResponse) throw e;
    return prismaError(e);
  }
}
