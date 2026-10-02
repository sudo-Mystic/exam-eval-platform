import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, notFound } from "@/lib/api-errors";

// GET /api/exams/:id/reports/:studentId - individual student report.
// Only from finalized results: unreviewed AI output is never presented as final.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; studentId: string }> }
) {
  const { id: examId, studentId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");
    const student = await db.student.findFirst({ where: { id: studentId, examId } });
    if (!student) return notFound("Student not found");

    const result = await db.finalResult.findUnique({
      where: { examId_studentId: { examId, studentId } },
    });
    if (!result) {
      return NextResponse.json(
        { error: "No finalized result for this student yet" },
        { status: 404 }
      );
    }

    const qevals = await db.questionEvaluation.findMany({
      where: { evaluationId: result.evaluationId },
      include: {
        question: true,
        overrides: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { question: { sortOrder: "asc" } },
    });

    const maxTotal = qevals.reduce((s, qe) => s + qe.question.maxMarks, 0);

    return NextResponse.json({
      exam: { title: exam.title, subject: exam.subject, term: exam.term },
      student: { rollNo: student.rollNo, name: student.name },
      result: {
        totalAi: result.totalAi,
        totalFinal: result.totalFinal,
        maxTotal,
        percentage: result.percentage,
        published: result.published,
        finalizedAt: result.finalizedAt,
      },
      questions: qevals.map((qe) => ({
        qNo: qe.question.qNo,
        text: qe.question.text,
        maxMarks: qe.question.maxMarks,
        aiMarks: qe.aiMarks,
        finalMarks: qe.overrides[0]?.facultyMarks ?? qe.aiMarks,
        overridden: qe.overrides.length > 0,
        justification: qe.aiJustification,
        facultyComment: qe.overrides[0]?.comment ?? null,
      })),
    });
  } catch (e) {
    return prismaError(e);
  }
}
