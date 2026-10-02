import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, notFound } from "@/lib/api-errors";

// GET /api/exams/:id/results - results table data.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const [results, maxTotal, students] = await Promise.all([
      db.finalResult.findMany({
        where: { examId },
        include: { student: { select: { rollNo: true, name: true } } },
        orderBy: { student: { rollNo: "asc" } },
      }),
      db.question.aggregate({
        where: { examId },
        _sum: { maxMarks: true },
      }),
      db.student.findMany({
        where: { examId },
        select: { id: true, rollNo: true, name: true },
        orderBy: { rollNo: "asc" },
      }),
    ]);

    const byStudent = new Map(results.map((r) => [r.studentId, r]));
    return NextResponse.json({
      maxTotal: maxTotal._sum.maxMarks ?? 0,
      rows: students.map((s) => ({
        studentId: s.id,
        rollNo: s.rollNo,
        name: s.name,
        result: byStudent.get(s.id) ?? null,
      })),
    });
  } catch (e) {
    return prismaError(e);
  }
}
