import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, notFound } from "@/lib/api-errors";

// GET /api/evaluations/:id - evaluation with per-question results and overrides.
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
          include: {
            student: true,
            pages: { orderBy: { pageNo: "asc" } },
          },
        },
        rubricVersion: { select: { id: true, version: true, status: true } },
        questionEvals: {
          include: {
            question: true,
            overrides: { orderBy: { createdAt: "desc" }, take: 1 },
          },
          orderBy: { question: { sortOrder: "asc" } },
        },
      },
    });
    if (!evaluation) return notFound("Evaluation not found");

    // Resolve criterion labels so review shows the rubric's real labels,
    // not whatever the model wrote into the note field.
    const criteria = await db.rubricCriterion.findMany({
      where: { rubricVersionId: evaluation.rubricVersionId },
      select: { id: true, label: true, maxMarks: true },
    });
    const criterionById = new Map(criteria.map((c) => [c.id, c]));

    const questions = evaluation.questionEvals.map((qe) => {
      const override = qe.overrides[0];
      const criterionMarks = (qe.criterionMarks as Array<{ criterionId: string; marks: number; note: string }>).map((c) => ({
        ...c,
        label: criterionById.get(c.criterionId)?.label ?? null,
        maxMarks: criterionById.get(c.criterionId)?.maxMarks ?? null,
      }));
      return {
        id: qe.id,
        questionId: qe.questionId,
        qNo: qe.question.qNo,
        text: qe.question.text,
        maxMarks: qe.question.maxMarks,
        qType: qe.question.qType,
        aiMarks: qe.aiMarks,
        aiJustification: qe.aiJustification,
        criterionMarks,
        evidenceRefs: qe.evidenceRefs,
        confidence: qe.confidence,
        flags: qe.flags,
        model: qe.model,
        facultyMarks: override?.facultyMarks ?? null,
        facultyComment: override?.comment ?? null,
        finalMarks: override?.facultyMarks ?? qe.aiMarks,
      };
    });

    const totalAi = questions.reduce((s, q) => s + q.aiMarks, 0);
    const totalFinal = questions.reduce((s, q) => s + q.finalMarks, 0);
    const maxTotal = questions.reduce((s, q) => s + q.maxMarks, 0);

    return NextResponse.json({
      evaluation: {
        id: evaluation.id,
        status: evaluation.status,
        rubricVersion: evaluation.rubricVersion,
        student: evaluation.sheet.student,
        sheetId: evaluation.sheet.id,
        examId: evaluation.sheet.examId,
        pages: evaluation.sheet.pages,
      },
      questions,
      totals: { totalAi, totalFinal, maxTotal },
    });
  } catch (e) {
    return prismaError(e);
  }
}
