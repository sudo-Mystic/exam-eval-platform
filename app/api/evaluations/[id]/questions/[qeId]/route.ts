import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, readJsonBody, badRequest, notFound } from "@/lib/api-errors";

// PATCH /api/evaluations/:id/questions/:qeId - faculty override.
// Stores the override separately; the AI suggestion is never mutated.
// Totals are recalculated by readers from finalMarks.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; qeId: string }> }
) {
  const { id: evaluationId, qeId } = await params;
  try {
    const qe = await db.questionEvaluation.findFirst({
      where: { id: qeId, evaluationId },
      include: { question: true, evaluation: { include: { sheet: true } } },
    });
    if (!qe) return notFound("Question evaluation not found");

    // Frozen once the sheet is finalized.
    if (qe.evaluation.sheet.status === "FINALIZED") {
      return NextResponse.json(
        { error: "Sheet is finalized; overrides are locked" },
        { status: 409 }
      );
    }

    const parsed = await readJsonBody<{ facultyMarks?: number; comment?: string }>(req);
    if (!parsed.ok) return parsed.response;
    const { facultyMarks, comment } = parsed.body;

    if (facultyMarks !== undefined) {
      if (typeof facultyMarks !== "number" || !Number.isFinite(facultyMarks)) {
        return badRequest("facultyMarks must be a number");
      }
      if (facultyMarks < 0 || facultyMarks - qe.question.maxMarks > 0.001) {
        return badRequest(
          `facultyMarks must be between 0 and ${qe.question.maxMarks}`
        );
      }
    }

    // Clearing the override: facultyMarks null removes the latest override.
    if (facultyMarks === undefined || facultyMarks === null) {
      const latest = await db.evaluationOverride.findFirst({
        where: { questionEvalId: qeId },
        orderBy: { createdAt: "desc" },
      });
      if (latest) await db.evaluationOverride.delete({ where: { id: latest.id } });
      return NextResponse.json({ ok: true, cleared: true });
    }

    const override = await db.evaluationOverride.create({
      data: {
        questionEvalId: qeId,
        facultyMarks,
        comment: typeof comment === "string" ? comment.trim() || null : null,
      },
    });

    return NextResponse.json({ override });
  } catch (e) {
    return prismaError(e);
  }
}
