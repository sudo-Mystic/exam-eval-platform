import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, notFound } from "@/lib/api-errors";

// POST /api/exams/:id/publish - mark all finalized results as published.
// Published results are the faculty-approved record; unreviewed AI output
// is never presented as final.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const { count } = await db.finalResult.updateMany({
      where: { examId, published: false },
      data: { published: true },
    });

    await db.exam.update({
      where: { id: examId },
      data: { status: "PUBLISHED" },
    });

    return NextResponse.json({ ok: true, published: count });
  } catch (e) {
    return prismaError(e);
  }
}
