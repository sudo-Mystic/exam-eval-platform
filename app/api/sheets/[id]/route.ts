import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { prismaError, readJsonBody, badRequest, notFound } from "@/lib/api-errors";

// GET /api/sheets/:id - sheet with pages in order and student
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const sheet = await db.answerSheet.findUnique({
      where: { id },
      include: {
        student: true,
        pages: { orderBy: { pageNo: "asc" } },
        evaluations: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, rubricVersionId: true },
        },
      },
    });
    if (!sheet) return notFound("Sheet not found");
    return NextResponse.json({ sheet });
  } catch (e) {
    return prismaError(e);
  }
}

// PATCH /api/sheets/:id - reassign to another student in the same exam
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const sheet = await db.answerSheet.findUnique({ where: { id } });
    if (!sheet) return notFound("Sheet not found");

    const parsed = await readJsonBody<{ studentId?: string }>(req);
    if (!parsed.ok) return parsed.response;
    const { studentId } = parsed.body;
    if (typeof studentId !== "string" || !studentId)
      return badRequest("studentId is required");

    const student = await db.student.findFirst({
      where: { id: studentId, examId: sheet.examId },
    });
    if (!student) return notFound("Student not found in this exam");

    // Never silently assign to the wrong student: 409 if the target already
    // has a sheet; faculty merges or deletes explicitly.
    const clash = await db.answerSheet.findUnique({
      where: { examId_studentId: { examId: sheet.examId, studentId } },
    });
    if (clash && clash.id !== sheet.id) {
      return NextResponse.json(
        { error: "Target student already has a sheet; delete or merge it first" },
        { status: 409 }
      );
    }

    const updated = await db.answerSheet.update({
      where: { id },
      data: { studentId },
    });
    return NextResponse.json({ sheet: updated });
  } catch (e) {
    return prismaError(e);
  }
}

// DELETE /api/sheets/:id - delete sheet, its pages, and files
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const sheet = await db.answerSheet.findUnique({
      where: { id },
      include: { pages: true },
    });
    if (!sheet) return notFound("Sheet not found");

    await db.answerSheet.delete({ where: { id } });
    for (const p of sheet.pages) {
      for (const rel of [p.imagePath, p.thumbPath].filter(Boolean) as string[]) {
        try {
          await storage.delete(rel);
        } catch {
          // best effort
        }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return prismaError(e);
  }
}
