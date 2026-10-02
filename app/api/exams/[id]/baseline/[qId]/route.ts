import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDraftRubricVersion } from "@/lib/rubric";
import {
  prismaError,
  readJsonBody,
  badRequest,
  notFound,
  conflict,
  unprocessable,
} from "@/lib/api-errors";

interface CriterionInput {
  id?: string;
  label: string;
  maxMarks: number;
  descriptors: string;
  sortOrder?: number;
}

interface BaselineBody {
  solutionText?: string;
  alternatives?: string[];
  criteria?: CriterionInput[];
}

// PATCH /api/exams/:id/baseline/:qId - faculty edits a question's baseline.
// DRAFT-only (409 when approved). Validates criterion sums against the
// question max now, so grading jobs never fail on it later. Always marks the
// baseline facultyEdited so regeneration never overwrites it.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; qId: string }> }
) {
  const { id: examId, qId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const question = await db.question.findFirst({
      where: { id: qId, examId },
    });
    if (!question) return notFound("Question not found in this exam");

    const approved = await db.rubricVersion.findFirst({
      where: { examId, status: "APPROVED" },
    });
    if (approved) {
      return conflict("Rubric already approved; baselines are frozen");
    }
    const version = await getDraftRubricVersion(examId);
    if (!version) {
      return badRequest("No draft rubric version; generate baselines first");
    }

    const parsed = await readJsonBody<BaselineBody>(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    if (
      body.solutionText !== undefined &&
      (typeof body.solutionText !== "string" || body.solutionText.trim().length === 0)
    ) {
      return badRequest("solutionText must be a non-empty string");
    }
    if (body.alternatives !== undefined) {
      if (
        !Array.isArray(body.alternatives) ||
        body.alternatives.some((a) => typeof a !== "string")
      ) {
        return badRequest("alternatives must be an array of strings");
      }
    }

    let criteria: CriterionInput[] | undefined;
    if (body.criteria !== undefined) {
      if (!Array.isArray(body.criteria)) return badRequest("criteria must be an array");
      criteria = body.criteria;
      const seen = new Set<string>();
      for (const [i, c] of criteria.entries()) {
        const where = `criteria[${i}]`;
        if (typeof c.label !== "string" || c.label.trim().length === 0) {
          return badRequest(`${where}.label is required`);
        }
        if (typeof c.maxMarks !== "number" || !Number.isFinite(c.maxMarks) || c.maxMarks <= 0) {
          return badRequest(`${where}.maxMarks must be a positive number`);
        }
        if (typeof c.descriptors !== "string" || c.descriptors.trim().length === 0) {
          return badRequest(`${where}.descriptors is required`);
        }
        const key = c.label.trim().toLowerCase();
        if (seen.has(key)) return badRequest(`Duplicate criterion label: ${c.label}`);
        seen.add(key);
      }
      const sum = criteria.reduce((s, c) => s + c.maxMarks, 0);
      if (Math.abs(sum - question.maxMarks) > 0.001) {
        return unprocessable(
          `Criterion marks sum to ${sum}, but question ${question.qNo} is worth ${question.maxMarks}`,
          { qNo: question.qNo, sum, maxMarks: question.maxMarks }
        );
      }
    }

    const updated = await db.$transaction(async (tx) => {
      const baseline = await tx.baselineSolution.upsert({
        where: {
          rubricVersionId_questionId: {
            rubricVersionId: version.id,
            questionId: question.id,
          },
        },
        create: {
          rubricVersionId: version.id,
          questionId: question.id,
          solutionText: (body.solutionText ?? "").trim(),
          alternatives: (body.alternatives ?? []).map((a) => a.trim()).filter(Boolean),
          facultyEdited: true,
        },
        update: {
          ...(body.solutionText !== undefined
            ? { solutionText: body.solutionText.trim() }
            : {}),
          ...(body.alternatives !== undefined
            ? { alternatives: body.alternatives.map((a) => a.trim()).filter(Boolean) }
            : {}),
          facultyEdited: true,
        },
      });

      let savedCriteria = null;
      if (criteria !== undefined) {
        const existing = await tx.rubricCriterion.findMany({
          where: { rubricVersionId: version.id, questionId: question.id },
        });
        const existingIds = new Set(existing.map((c) => c.id));
        const keepIds = new Set(
          criteria.map((c) => c.id).filter((id): id is string => !!id && existingIds.has(id))
        );
        await tx.rubricCriterion.deleteMany({
          where: {
            rubricVersionId: version.id,
            questionId: question.id,
            id: { notIn: [...keepIds] },
          },
        });
        savedCriteria = [];
        for (const [i, c] of criteria.entries()) {
          const data = {
            label: c.label.trim(),
            maxMarks: c.maxMarks,
            descriptors: c.descriptors.trim(),
            sortOrder: c.sortOrder ?? i,
          };
          if (c.id && existingIds.has(c.id)) {
            savedCriteria.push(
              await tx.rubricCriterion.update({ where: { id: c.id }, data })
            );
          } else {
            savedCriteria.push(
              await tx.rubricCriterion.create({
                data: {
                  ...data,
                  rubricVersionId: version.id,
                  questionId: question.id,
                },
              })
            );
          }
        }
      }

      return { baseline, criteria: savedCriteria };
    });

    return NextResponse.json(updated);
  } catch (e) {
    if (e instanceof NextResponse) throw e;
    return prismaError(e);
  }
}
