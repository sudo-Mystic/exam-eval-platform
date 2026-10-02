import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getActiveRubricVersion } from "@/lib/rubric";
import {
  prismaError,
  readJsonBody,
  badRequest,
  notFound,
  conflict,
} from "@/lib/api-errors";
import { QuestionType } from "@prisma/client";

const QTYPES = Object.values(QuestionType);

async function loadExam(id: string) {
  const exam = await db.exam.findUnique({ where: { id } });
  if (!exam) throw notFound("Exam not found");
  return exam;
}

// GET /api/exams/:id/questions
// Returns the active rubric version envelope plus questions, each carrying
// its draft criteria and baseline. One round trip avoids version skew.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    await loadExam(examId);
    const version = await getActiveRubricVersion(examId);
    const questions = await db.question.findMany({
      where: { examId },
      orderBy: { sortOrder: "asc" },
      include: {
        criteria: version
          ? { where: { rubricVersionId: version.id }, orderBy: { sortOrder: "asc" } }
          : false,
        baselineSolutions: version
          ? { where: { rubricVersionId: version.id } }
          : false,
      },
    });
    return NextResponse.json({
      rubricVersion: version
        ? { id: version.id, version: version.version, status: version.status }
        : null,
      questions: questions.map((q) => ({
        id: q.id,
        qNo: q.qNo,
        subPart: q.subPart,
        text: q.text,
        maxMarks: q.maxMarks,
        qType: q.qType,
        topic: q.topic,
        sortOrder: q.sortOrder,
        criteria: q.criteria ?? [],
        baseline: q.baselineSolutions?.[0] ?? null,
      })),
    });
  } catch (e) {
    if (e instanceof NextResponse) throw e;
    return prismaError(e);
  }
}

interface QuestionInput {
  id?: string;
  qNo: string;
  subPart?: string;
  text: string;
  maxMarks: number;
  qType: string;
  topic?: string;
  sortOrder?: number;
}

// PATCH /api/exams/:id/questions - bulk replace (idempotent).
// DRAFT-only: 409 once a rubric version is APPROVED, because edits would
// silently redefine what "approved" means.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    await loadExam(examId);

    const approved = await db.rubricVersion.findFirst({
      where: { examId, status: "APPROVED" },
    });
    if (approved) {
      return conflict(
        "Rubric already approved; questions are frozen. Faculty can review the approved version."
      );
    }

    const parsed = await readJsonBody<{ questions?: QuestionInput[] }>(req);
    if (!parsed.ok) return parsed.response;
    const list = parsed.body.questions;
    if (!Array.isArray(list)) return badRequest("questions must be an array");

    // Validate everything before touching the DB.
    const seen = new Set<string>();
    for (const [i, q] of list.entries()) {
      const where = `questions[${i}]`;
      if (typeof q.qNo !== "string" || q.qNo.trim().length === 0) {
        return badRequest(`${where}.qNo is required`);
      }
      const qNo = q.qNo.trim();
      if (seen.has(qNo)) return badRequest(`Duplicate question number: ${qNo}`);
      seen.add(qNo);
      if (typeof q.text !== "string" || q.text.trim().length === 0) {
        return badRequest(`${where}.text is required`);
      }
      if (typeof q.maxMarks !== "number" || !Number.isFinite(q.maxMarks) || q.maxMarks <= 0) {
        return badRequest(`${where}.maxMarks must be a positive number`);
      }
      if (!QTYPES.includes(q.qType as QuestionType)) {
        return badRequest(`${where}.qType must be one of ${QTYPES.join(", ")}`);
      }
      if (q.id !== undefined && typeof q.id !== "string") {
        return badRequest(`${where}.id must be a string`);
      }
    }

    // Full replace in one transaction. Draft-only, so nothing approved
    // references these rows yet.
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.question.findMany({ where: { examId } });
      const existingById = new Map(existing.map((q) => [q.id, q]));
      const keepIds = new Set(
        list.map((q) => q.id).filter((id): id is string => !!id && existingById.has(id))
      );
      await tx.question.deleteMany({
        where: { examId, id: { notIn: [...keepIds] } },
      });
      const saved = [];
      for (const [i, q] of list.entries()) {
        const data = {
          qNo: q.qNo.trim(),
          subPart: q.subPart?.trim() || null,
          text: q.text.trim(),
          maxMarks: q.maxMarks,
          qType: q.qType as QuestionType,
          topic: q.topic?.trim() || null,
          sortOrder: q.sortOrder ?? i,
        };
        if (q.id && existingById.has(q.id)) {
          saved.push(await tx.question.update({ where: { id: q.id }, data }));
        } else {
          saved.push(await tx.question.create({ data: { ...data, examId } }));
        }
      }
      return saved;
    });

    return NextResponse.json({ questions: result });
  } catch (e) {
    if (e instanceof NextResponse) throw e;
    return prismaError(e);
  }
}
