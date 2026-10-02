import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, readJsonBody, badRequest, notFound } from "@/lib/api-errors";

// GET /api/exams/:id/students - list students with sheet status
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");
    const students = await db.student.findMany({
      where: { examId },
      orderBy: { rollNo: "asc" },
      include: {
        answerSheets: {
          select: {
            id: true,
            status: true,
            _count: { select: { pages: true } },
          },
        },
      },
    });
    return NextResponse.json({ students });
  } catch (e) {
    return prismaError(e);
  }
}

interface StudentInput {
  rollNo: string;
  name: string;
}

// POST /api/exams/:id/students - bulk upsert by rollNo (idempotent).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const parsed = await readJsonBody<{ students?: StudentInput[] }>(req);
    if (!parsed.ok) return parsed.response;
    const list = parsed.body.students;
    if (!Array.isArray(list) || list.length === 0) {
      return badRequest("students must be a non-empty array");
    }

    const seen = new Set<string>();
    for (const [i, s] of list.entries()) {
      if (typeof s.rollNo !== "string" || !s.rollNo.trim())
        return badRequest(`students[${i}].rollNo is required`);
      if (typeof s.name !== "string" || !s.name.trim())
        return badRequest(`students[${i}].name is required`);
      const roll = s.rollNo.trim();
      if (seen.has(roll)) return badRequest(`Duplicate roll number: ${roll}`);
      seen.add(roll);
    }

    const saved = await db.$transaction(async (tx) => {
      const out = [];
      for (const s of list) {
        out.push(
          await tx.student.upsert({
            where: { examId_rollNo: { examId, rollNo: s.rollNo.trim() } },
            create: { examId, rollNo: s.rollNo.trim(), name: s.name.trim() },
            update: { name: s.name.trim() },
          })
        );
      }
      return out;
    });

    return NextResponse.json({ students: saved }, { status: 201 });
  } catch (e) {
    return prismaError(e);
  }
}
