import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, notFound } from "@/lib/api-errors";

// GET /api/exams/:id/export.csv - downloadable results CSV.
// Columns: roll_no, name, ai_total, final_total, max_total, percentage,
// published, then one column per question (Q<qNo>_ai, Q<qNo>_final).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const questions = await db.question.findMany({
      where: { examId },
      orderBy: { sortOrder: "asc" },
    });
    const results = await db.finalResult.findMany({
      where: { examId },
      include: { student: true },
      orderBy: { student: { rollNo: "asc" } },
    });

    const qevals =
      results.length > 0
        ? await db.questionEvaluation.findMany({
            where: { evaluationId: { in: results.map((r) => r.evaluationId) } },
            include: {
              overrides: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          })
        : [];
    const byEvalQ = new Map(qevals.map((qe) => [`${qe.evaluationId}:${qe.questionId}`, qe]));

    const maxTotal = questions.reduce((s, q) => s + q.maxMarks, 0);
    const header = [
      "roll_no",
      "name",
      "ai_total",
      "final_total",
      "max_total",
      "percentage",
      "published",
      ...questions.flatMap((q) => [`Q${q.qNo}_ai`, `Q${q.qNo}_final`]),
    ];

    const lines = [header.join(",")];
    for (const r of results) {
      const perQ = questions.flatMap((q) => {
        const qe = byEvalQ.get(`${r.evaluationId}:${q.id}`);
        const ai = qe?.aiMarks ?? "";
        const fin = qe ? (qe.overrides[0]?.facultyMarks ?? qe.aiMarks) : "";
        return [ai, fin];
      });
      lines.push(
        [
          csv(r.student.rollNo),
          csv(r.student.name),
          r.totalAi,
          r.totalFinal,
          maxTotal,
          r.percentage.toFixed(2),
          r.published ? "yes" : "no",
          ...perQ,
        ].join(",")
      );
    }

    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="results-${examId}.csv"`,
      },
    });
  } catch (e) {
    return prismaError(e);
  }
}

function csv(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
