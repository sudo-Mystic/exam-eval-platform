import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, readJsonBody, badRequest, notFound, conflict } from "@/lib/api-errors";

// GET /api/exams/:id/sheets - list sheets with student, page count, status
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");
    const sheets = await db.answerSheet.findMany({
      where: { examId },
      include: {
        student: { select: { id: true, rollNo: true, name: true } },
        _count: { select: { pages: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ sheets });
  } catch (e) {
    return prismaError(e);
  }
}

// POST /api/exams/:id/sheets - create a sheet for a student.
// Idempotent on (examId, studentId): returns the existing sheet.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const parsed = await readJsonBody<{ studentId?: string }>(req);
    if (!parsed.ok) return parsed.response;
    const { studentId } = parsed.body;
    if (typeof studentId !== "string" || !studentId)
      return badRequest("studentId is required");

    const student = await db.student.findFirst({ where: { id: studentId, examId } });
    if (!student) return notFound("Student not found in this exam");

    const existing = await db.answerSheet.findUnique({
      where: { examId_studentId: { examId, studentId } },
    });
    if (existing) {
      return NextResponse.json({ sheet: existing, deduped: true });
    }

    const sheet = await db.answerSheet.create({
      data: { examId, studentId },
    });
    return NextResponse.json({ sheet, deduped: false }, { status: 201 });
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as { code: string }).code === "P2002"
    ) {
      return conflict("A sheet already exists for this student");
    }
    return prismaError(e);
  }
}
