import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, notFound } from "@/lib/api-errors";

// POST /api/evaluations/:id/finalize - lock a sheet's result.
// Recomputes totals from AI marks + latest overrides, writes FinalResult
// pinned to the evaluation and rubric version, marks the sheet FINALIZED.
// The published result is distinct from the unreviewed AI result.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: evaluationId } = await params;
  try {
    const evaluation = await db.evaluation.findUnique({
      where: { id: evaluationId },
      include: {
        sheet: { include: { student: true } },
        questionEvals: {
          include: {
            question: true,
            overrides: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
      },
    });
    if (!evaluation) return notFound("Evaluation not found");
    if (evaluation.status !== "DONE") {
      return NextResponse.json(
        { error: `Cannot finalize while evaluation is ${evaluation.status}` },
        { status: 422 }
      );
    }

    let totalAi = 0;
    let totalFinal = 0;
    let maxTotal = 0;
    for (const qe of evaluation.questionEvals) {
      totalAi += qe.aiMarks;
      totalFinal += qe.overrides[0]?.facultyMarks ?? qe.aiMarks;
      maxTotal += qe.question.maxMarks;
    }
    if (maxTotal <= 0) {
      return NextResponse.json({ error: "Nothing to finalize" }, { status: 422 });
    }

    const result = await db.$transaction(async (tx) => {
      const final = await tx.finalResult.upsert({
        where: { evaluationId },
        create: {
          examId: evaluation.sheet.examId,
          studentId: evaluation.sheet.studentId,
          evaluationId,
          totalAi,
          totalFinal,
          percentage: (totalFinal / maxTotal) * 100,
        },
        update: {
          totalAi,
          totalFinal,
          percentage: (totalFinal / maxTotal) * 100,
          finalizedAt: new Date(),
        },
      });
      await tx.answerSheet.update({
        where: { id: evaluation.sheetId },
        data: { status: "FINALIZED" },
      });
      return final;
    });

    return NextResponse.json({ result });
  } catch (e) {
    return prismaError(e);
  }
}
