import { db } from "../lib/db";
import { storage } from "../lib/storage";
import {
  rasterizePdf,
  normalizePageImage,
  makeThumbnail,
  storePaperPage,
} from "../lib/ingestion/pdf";
import { GeminiProvider, isRetryable } from "../lib/gemini/provider";
import { modelFor, logUsage, withinBudget, isHardQuestion } from "../lib/gemini/adapter";
import {
  EXTRACTION_SYSTEM,
  extractionUser,
  SCHEME_SYSTEM,
  schemeUser,
  BASELINE_SYSTEM,
  baselineUser,
  MATCH_SYSTEM,
  matchUser,
  GRADE_SYSTEM,
  gradeUser,
  repairUser,
} from "../lib/gemini/prompts";
import { getOrCreateDraftVersion } from "../lib/rubric";
import type { JobPayloadMap } from "../lib/queue";
import type { QuestionType } from "@prisma/client";

const provider = new GeminiProvider();
const PAGE_BATCH = 10;

export class BudgetExhausted extends Error {
  constructor() {
    super("Token budget exhausted for this exam; pipeline paused");
  }
}

async function ensureBudget(examId: string) {
  if (!(await withinBudget(examId))) throw new BudgetExhausted();
}

// Strip markdown fences if the model adds them despite instructions.
export function parseJson(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

export interface ExtractedQuestion {
  qNo: string;
  subPart?: string | null;
  text: string;
  maxMarks: number | null;
  qType: string;
  topic?: string | null;
  sortOrder: number;
  flags?: string[];
}

export function validateExtraction(raw: unknown): ExtractedQuestion[] {
  if (typeof raw !== "object" || raw === null) throw new Error("Extraction: not an object");
  const questions = (raw as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) throw new Error("Extraction: questions is not an array");
  const seen = new Set<string>();
  return questions.map((q, i) => {
    const where = `questions[${i}]`;
    if (typeof q !== "object" || q === null) throw new Error(`${where}: not an object`);
    const o = q as Record<string, unknown>;
    if (typeof o.qNo !== "string" || o.qNo.trim().length === 0)
      throw new Error(`${where}.qNo missing`);
    const qNo = o.qNo.trim();
    if (seen.has(qNo)) throw new Error(`Duplicate qNo in extraction: ${qNo}`);
    seen.add(qNo);
    if (typeof o.text !== "string" || o.text.trim().length === 0)
      throw new Error(`${where}.text missing`);
    const qType = String(o.qType ?? "descriptive").toLowerCase();
    if (!["mcq", "descriptive", "numerical", "equation", "diagram", "code"].includes(qType))
      throw new Error(`${where}.qType invalid: ${o.qType}`);
    if (o.maxMarks !== null && o.maxMarks !== undefined) {
      if (typeof o.maxMarks !== "number" || !Number.isFinite(o.maxMarks) || o.maxMarks < 0)
        throw new Error(`${where}.maxMarks invalid`);
    }
    return {
      qNo,
      subPart: typeof o.subPart === "string" ? o.subPart : null,
      text: o.text.trim(),
      maxMarks: typeof o.maxMarks === "number" ? o.maxMarks : null,
      qType,
      topic: typeof o.topic === "string" ? o.topic : null,
      sortOrder: typeof o.sortOrder === "number" ? o.sortOrder : i,
      flags: Array.isArray(o.flags) ? o.flags.filter((f) => typeof f === "string") : [],
    };
  });
}

const QTYPE_MAP: Record<string, QuestionType> = {
  mcq: "MCQ",
  descriptive: "DESCRIPTIVE",
  numerical: "NUMERICAL",
  equation: "EQUATION",
  diagram: "DIAGRAM",
  code: "CODE",
};

// Load an uploaded file and return normalized page images.
async function loadPages(rel: string): Promise<Buffer[]> {
  const buf = await storage.read(rel);
  if (rel.endsWith(".pdf")) {
    const pages: Buffer[] = [];
    await rasterizePdf(buf, async (_n, png) => {
      pages.push(await normalizePageImage(png));
    });
    return pages;
  }
  return [await normalizePageImage(buf)];
}

async function generateWithRepair(args: {
  examId: string;
  purpose: string;
  model: string;
  system: string;
  user: string;
  images: Array<{ mimeType: string; data: Buffer }>;
  maxOutputTokens: number;
  temperature: number;
  validate: (raw: unknown) => void;
}): Promise<{ parsed: unknown }> {
  await ensureBudget(args.examId);
  let attempt = 0;
  const user = args.user;
  let lastError = "";
  while (attempt < 2) {
    const res = await provider.callModel(args.model, {
      system: args.system,
      user: lastError ? `${user}\n\n${repairUser(lastError)}` : user,
      images: args.images,
      maxOutputTokens: args.maxOutputTokens,
      temperature: args.temperature,
    });
    await logUsage({
      examId: args.examId,
      purpose: args.purpose,
      model: args.model,
      promptTokens: res.promptTokens,
      outputTokens: res.outputTokens,
      status: "ok",
    });
    try {
      const parsed = parseJson(res.text);
      args.validate(parsed);
      return { parsed };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      attempt++;
      if (attempt >= 2) {
        await logUsage({
          examId: args.examId,
          purpose: args.purpose,
          model: args.model,
          status: "failed",
          error: `schema-invalid after repair: ${lastError}`,
        });
        throw new Error(`Model output failed validation: ${lastError}`);
      }
    }
  }
  throw new Error("Unreachable");
}

export async function handleIngestPaper(payload: JobPayloadMap["ingest-paper"]) {
  const { examId, files } = payload;
  const exam = await db.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new Error(`Exam ${examId} no longer exists; skipping ingest`);

  // Rasterize all uploads into normalized page images.
  const pages: Buffer[] = [];
  for (const rel of files) {
    const loaded = await loadPages(rel);
    pages.push(...loaded);
  }
  if (pages.length === 0) throw new Error("No pages found in uploaded paper");

  // Store normalized pages for the faculty record and future stages.
  for (const [i, png] of pages.entries()) {
    await storePaperPage(examId, i + 1, png);
  }

  // Extract questions in batches. One model call per batch, then validate.
  const all: ExtractedQuestion[] = [];
  const model = modelFor("extract");
  for (let b = 0; b < pages.length; b += PAGE_BATCH) {
    const batch = pages.slice(b, b + PAGE_BATCH);
    const { parsed } = await generateWithRepair({
      examId,
      purpose: "question-extract",
      model,
      system: EXTRACTION_SYSTEM,
      user: extractionUser(b / PAGE_BATCH + 1, Math.ceil(pages.length / PAGE_BATCH)),
      images: batch.map((data) => ({ mimeType: "image/jpeg", data })),
      maxOutputTokens: 4000,
      temperature: 0.2,
      validate: (raw) => {
        all.push(...validateExtraction(raw));
      },
    });
    void parsed;
  }

  // Rebase sortOrder across batches and persist. Null marks become 0 and are
  // flagged in the UI; approval is blocked until faculty fills them.
  const version = await getOrCreateDraftVersion(examId);
  await db.$transaction(async (tx) => {
    for (const [i, q] of all.entries()) {
      await tx.question.upsert({
        where: { examId_qNo: { examId, qNo: q.qNo } },
        create: {
          examId,
          qNo: q.qNo,
          subPart: q.subPart,
          text: q.text,
          maxMarks: q.maxMarks ?? 0,
          qType: QTYPE_MAP[q.qType],
          topic: q.topic,
          sortOrder: i,
        },
        update: {
          text: q.text,
          maxMarks: q.maxMarks ?? 0,
          qType: QTYPE_MAP[q.qType],
          topic: q.topic,
          sortOrder: i,
        },
      });
    }
  });

  await db.exam.update({ where: { id: examId }, data: { status: "PREPARED" } });
  void version;
}

export interface SchemeCriterion {
  qNo: string;
  label: string;
  maxMarks: number;
  descriptors: string;
}

export function validateScheme(raw: unknown, knownQNos: Set<string>): SchemeCriterion[] {
  if (typeof raw !== "object" || raw === null) throw new Error("Scheme: not an object");
  const criteria = (raw as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria)) throw new Error("Scheme: criteria is not an array");
  return criteria.map((c, i) => {
    const where = `criteria[${i}]`;
    if (typeof c !== "object" || c === null) throw new Error(`${where}: not an object`);
    const o = c as Record<string, unknown>;
    if (typeof o.qNo !== "string" || o.qNo.trim().length === 0)
      throw new Error(`${where}.qNo missing`);
    if (typeof o.label !== "string" || o.label.trim().length === 0)
      throw new Error(`${where}.label missing`);
    if (typeof o.maxMarks !== "number" || !Number.isFinite(o.maxMarks) || o.maxMarks <= 0)
      throw new Error(`${where}.maxMarks invalid`);
    if (typeof o.descriptors !== "string" || o.descriptors.trim().length === 0)
      throw new Error(`${where}.descriptors missing`);
    return {
      qNo: o.qNo.trim(),
      label: o.label.trim(),
      maxMarks: o.maxMarks,
      descriptors: o.descriptors.trim(),
      _known: knownQNos.has(o.qNo.trim()),
    } as SchemeCriterion & { _known: boolean };
  });
}

export async function handleSchemeParse(payload: JobPayloadMap["scheme-parse"]) {
  const { examId, files } = payload;
  const exam = await db.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new Error(`Exam ${examId} no longer exists; skipping scheme parse`);

  const questions = await db.question.findMany({
    where: { examId },
    orderBy: { sortOrder: "asc" },
  });
  if (questions.length === 0) {
    throw new Error("No questions extracted yet; upload and ingest the paper first");
  }
  const knownQNos = new Set(questions.map((q) => q.qNo));
  const compact = questions
    .map((q) => `${q.qNo} | ${q.maxMarks} | ${q.text.slice(0, 300)}`)
    .join("\n");

  const pages: Buffer[] = [];
  for (const rel of files) pages.push(...(await loadPages(rel)));
  if (pages.length === 0) throw new Error("No pages found in uploaded scheme");

  const model = modelFor("extract");
  const collected: SchemeCriterion[] = [];
  for (let b = 0; b < pages.length; b += PAGE_BATCH) {
    const batch = pages.slice(b, b + PAGE_BATCH);
    await generateWithRepair({
      examId,
      purpose: "scheme-parse",
      model,
      system: SCHEME_SYSTEM,
      user: schemeUser(compact),
      images: batch.map((data) => ({ mimeType: "image/jpeg", data })),
      maxOutputTokens: 4000,
      temperature: 0.2,
      validate: (raw) => {
        collected.push(...validateScheme(raw, knownQNos));
      },
    });
  }

  const version = await getOrCreateDraftVersion(examId);
  const byQNo = new Map(questions.map((q) => [q.qNo, q]));
  let attached = 0;
  let orphaned = 0;
  await db.$transaction(async (tx) => {
    let sort = 0;
    for (const c of collected) {
      const q = byQNo.get(c.qNo);
      if (!q) {
        orphaned++;
        continue; // flagged in UI via the job result; never silently dropped
      }
      await tx.rubricCriterion.create({
        data: {
          rubricVersionId: version.id,
          questionId: q.id,
          label: c.label,
          maxMarks: c.maxMarks,
          descriptors: c.descriptors,
          sortOrder: sort++,
        },
      });
      attached++;
    }
  });
  if (orphaned > 0) {
    console.warn(
      `[scheme-parse] exam ${examId}: ${orphaned} criteria matched no known question; faculty must map them`
    );
  }
  void attached;
}

export interface BaselineOutput {
  solutionText: string;
  alternatives: string[];
  criterionNotes: Array<{ label: string; note: string }>;
}

export function validateBaseline(raw: unknown): BaselineOutput {
  if (typeof raw !== "object" || raw === null) throw new Error("Baseline: not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.solutionText !== "string" || o.solutionText.trim().length === 0)
    throw new Error("Baseline: solutionText missing");
  if (!Array.isArray(o.alternatives) || o.alternatives.some((a) => typeof a !== "string"))
    throw new Error("Baseline: alternatives must be string array");
  if (!Array.isArray(o.criterionNotes))
    throw new Error("Baseline: criterionNotes must be an array");
  for (const [i, n] of o.criterionNotes.entries()) {
    if (
      typeof n !== "object" ||
      n === null ||
      typeof (n as Record<string, unknown>).label !== "string" ||
      typeof (n as Record<string, unknown>).note !== "string"
    ) {
      throw new Error(`Baseline: criterionNotes[${i}] invalid`);
    }
  }
  return {
    solutionText: o.solutionText.trim(),
    alternatives: (o.alternatives as string[]).map((a) => a.trim()).filter(Boolean).slice(0, 5),
    criterionNotes: (o.criterionNotes as Array<{ label: string; note: string }>).map((n) => ({
      label: n.label.trim(),
      note: n.note.trim(),
    })),
  };
}

export async function handleGenerateBaseline(
  payload: JobPayloadMap["generate-baseline"]
) {
  const { examId, rubricVersionId, questionIds } = payload;
  const exam = await db.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new Error(`Exam ${examId} no longer exists; skipping baseline`);

  const version = await db.rubricVersion.findUnique({
    where: { id: rubricVersionId },
  });
  if (!version || version.status !== "DRAFT") {
    throw new Error("Rubric version is not a draft; skipping baseline generation");
  }

  const questions = await db.question.findMany({
    where: {
      examId,
      ...(questionIds ? { id: { in: questionIds } } : {}),
    },
    orderBy: { sortOrder: "asc" },
  });

  const model = modelFor("baseline");
  for (const q of questions) {
    await ensureBudget(examId);
    const existing = await db.baselineSolution.findUnique({
      where: { rubricVersionId_questionId: { rubricVersionId, questionId: q.id } },
    });
    if (existing?.facultyEdited) continue; // never overwrite faculty work

    const criteria = await db.rubricCriterion.findMany({
      where: { rubricVersionId, questionId: q.id },
      orderBy: { sortOrder: "asc" },
    });
    const criteriaList =
      criteria.length > 0
        ? criteria.map((c) => `- ${c.label} (${c.maxMarks} marks): ${c.descriptors}`).join("\n")
        : "- (no criteria defined yet; write general grading notes)";

    let out: BaselineOutput;
    try {
      const { parsed } = await generateWithRepair({
        examId,
        purpose: "baseline",
        model,
        system: BASELINE_SYSTEM,
        user: baselineUser(q.qNo, q.maxMarks, q.qType, q.text, criteriaList),
        images: [],
        maxOutputTokens: 2000,
        temperature: 0.4,
        validate: (raw) => validateBaseline(raw),
      });
      out = validateBaseline(parsed);
    } catch (e) {
      if (e instanceof BudgetExhausted || isRetryable(e)) throw e;
      // Semantic failure for this question: park it, keep going with the rest.
      console.warn(`[baseline] question ${q.qNo}: ${e instanceof Error ? e.message : e}`);
      continue;
    }

    // Merge criterion notes into descriptors on the DRAFT version only.
    await db.$transaction(async (tx) => {
      await tx.baselineSolution.upsert({
        where: { rubricVersionId_questionId: { rubricVersionId, questionId: q.id } },
        create: {
          rubricVersionId,
          questionId: q.id,
          solutionText: out.solutionText,
          alternatives: out.alternatives,
          facultyEdited: false,
        },
        update: {
          solutionText: out.solutionText,
          alternatives: out.alternatives,
        },
      });
      const noteByLabel = new Map(
        out.criterionNotes.map((n) => [n.label.toLowerCase(), n.note])
      );
      for (const c of criteria) {
        const note = noteByLabel.get(c.label.toLowerCase());
        if (note) {
          await tx.rubricCriterion.update({
            where: { id: c.id },
            data: { descriptors: `${c.descriptors}\n\nGrading notes: ${note}` },
          });
        }
      }
    });
  }
}

export async function dispatch(job: { type: string; payload: unknown }) {
  const p = job.payload as Record<string, unknown>;
  switch (job.type) {
    case "ingest-paper":
      return handleIngestPaper(p as JobPayloadMap["ingest-paper"]);
    case "scheme-parse":
      return handleSchemeParse(p as JobPayloadMap["scheme-parse"]);
    case "generate-baseline":
      return handleGenerateBaseline(p as JobPayloadMap["generate-baseline"]);
    case "question-match":
      return handleQuestionMatch(p as JobPayloadMap["question-match"]);
    case "grade-question":
      return handleGradeQuestion(p as JobPayloadMap["grade-question"]);
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: question matching and grading
// ---------------------------------------------------------------------------

export interface MatchMapping {
  questionId: string;
  pageNos: number[];
  regions: string[];
  confidence: "high" | "med" | "low";
  flags: string[];
}

export function validateMatch(raw: unknown, knownIds: Set<string>): MatchMapping[] {
  if (typeof raw !== "object" || raw === null) throw new Error("Match: not an object");
  const mappings = (raw as { mappings?: unknown }).mappings;
  if (!Array.isArray(mappings)) throw new Error("Match: mappings is not an array");
  return mappings.map((m, i) => {
    const where = `mappings[${i}]`;
    if (typeof m !== "object" || m === null) throw new Error(`${where}: not an object`);
    const o = m as Record<string, unknown>;
    if (typeof o.questionId !== "string" || !knownIds.has(o.questionId))
      throw new Error(`${where}.questionId is not a known question`);
    if (!Array.isArray(o.pageNos) || o.pageNos.some((n) => !Number.isInteger(n) || n < 1))
      throw new Error(`${where}.pageNos invalid`);
    if (!Array.isArray(o.regions) || o.regions.some((r) => typeof r !== "string"))
      throw new Error(`${where}.regions invalid`);
    const confidence = String(o.confidence ?? "med");
    if (!["high", "med", "low"].includes(confidence))
      throw new Error(`${where}.confidence invalid`);
    return {
      questionId: o.questionId,
      pageNos: o.pageNos as number[],
      regions: o.regions as string[],
      confidence: confidence as MatchMapping["confidence"],
      flags: Array.isArray(o.flags) ? (o.flags as unknown[]).filter((f): f is string => typeof f === "string") : [],
    };
  });
}

export async function handleQuestionMatch(payload: JobPayloadMap["question-match"]) {
  const { examId, sheetId, evaluationId } = payload;
  const sheet = await db.answerSheet.findUnique({
    where: { id: sheetId },
    include: { pages: { orderBy: { pageNo: "asc" } } },
  });
  if (!sheet) throw new Error(`Sheet ${sheetId} no longer exists; skipping match`);
  if (sheet.pages.length === 0) throw new Error("Sheet has no pages to match");

  const evaluation = await db.evaluation.findUnique({ where: { id: evaluationId } });
  if (!evaluation) throw new Error(`Evaluation ${evaluationId} gone; skipping match`);

  const questions = await db.question.findMany({
    where: { examId },
    orderBy: { sortOrder: "asc" },
  });
  if (questions.length === 0) throw new Error("Exam has no questions");

  await ensureBudget(examId);
  const model = modelFor("match");
  const compact = questions
    .map((q) => `${q.id} | ${q.qNo} | ${q.text.slice(0, 200)}`)
    .join("\n");

  const images: Array<{ mimeType: string; data: Buffer }> = [];
  const pageByNo = new Map<number, string>();
  for (const p of sheet.pages) {
    const data = await storage.read(p.imagePath);
    const thumb = await makeThumbnail(data);
    images.push({ mimeType: "image/jpeg", data: thumb });
    pageByNo.set(p.pageNo, p.id);
  }

  const knownIds = new Set(questions.map((q) => q.id));
  let mappings: MatchMapping[];
  {
    const { parsed } = await generateWithRepair({
      examId,
      purpose: "question-match",
      model,
      system: MATCH_SYSTEM,
      user: matchUser(compact),
      images,
      maxOutputTokens: 4000,
      temperature: 0.2,
      validate: (raw) => validateMatch(raw, knownIds),
    });
    mappings = validateMatch(parsed, knownIds);
  }

  // Persist mappings; then enqueue one grade job per mapped question.
  // Questions with no mapped answer get a zero-mark evaluation flagged
  // no-answer-found so faculty sees them explicitly.
  const { enqueue: enqueueJob } = await import("../lib/queue");
  await db.$transaction(async (tx) => {
    for (const m of mappings) {
      const pageIds = m.pageNos
        .map((n) => pageByNo.get(n))
        .filter((id): id is string => !!id);
      await tx.extractedAnswer.upsert({
        where: { sheetId_questionId: { sheetId, questionId: m.questionId } },
        create: {
          sheetId,
          questionId: m.questionId,
          pageIds,
          regionRefs: m.regions,
          interpretationFlags:
            m.confidence === "low" ? [...m.flags, "low-confidence"] : m.flags,
        },
        update: {
          pageIds,
          regionRefs: m.regions,
          interpretationFlags:
            m.confidence === "low" ? [...m.flags, "low-confidence"] : m.flags,
        },
      });
    }
  });

  const mappedIds = new Set(mappings.map((m) => m.questionId));
  for (const q of questions) {
    if (!mappedIds.has(q.id)) {
      await db.questionEvaluation.upsert({
        where: { evaluationId_questionId: { evaluationId, questionId: q.id } },
        create: {
          evaluationId,
          questionId: q.id,
          aiMarks: 0,
          aiJustification: "No answer found on the answer sheet for this question.",
          criterionMarks: [],
          evidenceRefs: [],
          confidence: "LOW",
          flags: ["no-answer-found"],
          model,
        },
        update: {},
      });
    } else {
      await enqueueJob("grade-question", {
        examId,
        sheetId,
        evaluationId,
        questionId: q.id,
      });
    }
  }

  await db.answerSheet.update({ where: { id: sheetId }, data: { status: "GRADING" } });
}

export interface GradeOutput {
  interpretedSummary: string;
  criterionMarks: Array<{ criterionId: string; marks: number; note: string }>;
  total: number;
  justification: string;
  evidenceRefs: string[];
  confidence: "high" | "med" | "low";
  flags: string[];
}

export function validateGradeOutput(raw: unknown): GradeOutput {
  if (typeof raw !== "object" || raw === null) throw new Error("Grade: not an object");
  const o = raw as Record<string, unknown>;
  for (const f of ["interpretedSummary", "justification"] as const) {
    if (typeof o[f] !== "string" || (o[f] as string).trim().length === 0)
      throw new Error(`Grade: ${f} missing`);
  }
  if (!Array.isArray(o.criterionMarks))
    throw new Error("Grade: criterionMarks is not an array");
  const criterionMarks = (o.criterionMarks as unknown[]).map((c, i) => {
    if (typeof c !== "object" || c === null) throw new Error(`Grade: criterionMarks[${i}] invalid`);
    const cc = c as Record<string, unknown>;
    if (typeof cc.criterionId !== "string") throw new Error(`Grade: criterionMarks[${i}].criterionId missing`);
    if (typeof cc.marks !== "number" || !Number.isFinite(cc.marks) || cc.marks < 0)
      throw new Error(`Grade: criterionMarks[${i}].marks invalid`);
    return {
      criterionId: cc.criterionId,
      marks: cc.marks,
      note: typeof cc.note === "string" ? cc.note : "",
    };
  });
  if (typeof o.total !== "number" || !Number.isFinite(o.total) || o.total < 0)
    throw new Error("Grade: total invalid");
  if (!Array.isArray(o.evidenceRefs) || o.evidenceRefs.some((r) => typeof r !== "string"))
    throw new Error("Grade: evidenceRefs invalid");
  const confidence = String(o.confidence ?? "med");
  if (!["high", "med", "low"].includes(confidence)) throw new Error("Grade: confidence invalid");
  return {
    interpretedSummary: (o.interpretedSummary as string).trim(),
    criterionMarks,
    total: o.total,
    justification: (o.justification as string).trim(),
    evidenceRefs: o.evidenceRefs as string[],
    confidence: confidence as GradeOutput["confidence"],
    flags: Array.isArray(o.flags)
      ? (o.flags as unknown[]).filter((f): f is string => typeof f === "string")
      : [],
  };
}

export async function handleGradeQuestion(payload: JobPayloadMap["grade-question"]) {
  const { examId, sheetId, evaluationId, questionId } = payload;

  const evaluation = await db.evaluation.findUnique({ where: { id: evaluationId } });
  if (!evaluation) throw new Error(`Evaluation ${evaluationId} gone; skipping grade`);

  const [question, extracted] = await Promise.all([
    db.question.findUnique({ where: { id: questionId } }),
    db.extractedAnswer.findUnique({
      where: { sheetId_questionId: { sheetId, questionId } },
    }),
  ]);
  if (!question) throw new Error(`Question ${questionId} gone; skipping grade`);
  if (!extracted) throw new Error(`No extracted answer for ${questionId}; skipping grade`);

  const [criteria, baseline] = await Promise.all([
    db.rubricCriterion.findMany({
      where: { rubricVersionId: evaluation.rubricVersionId, questionId },
      orderBy: { sortOrder: "asc" },
    }),
    db.baselineSolution.findUnique({
      where: {
        rubricVersionId_questionId: {
          rubricVersionId: evaluation.rubricVersionId,
          questionId,
        },
      },
    }),
  ]);
  if (criteria.length === 0) throw new Error(`No criteria for question ${question.qNo}`);

  await ensureBudget(examId);
  const taskKind = isHardQuestion(question.qType) ? "grade-hard" : "mcq";
  const model = modelFor(taskKind);

  // Only the relevant pages for this question, never the whole sheet.
  const pages = await db.sheetPage.findMany({
    where: { id: { in: extracted.pageIds } },
    orderBy: { pageNo: "asc" },
  });
  const images: Array<{ mimeType: string; data: Buffer }> = [];
  for (const p of pages) {
    images.push({ mimeType: "image/jpeg", data: await storage.read(p.imagePath) });
  }
  if (images.length === 0) throw new Error("Mapped pages have no images");

  const criteriaList = criteria
    .map((c) => `${c.id} | ${c.label} (${c.maxMarks} marks): ${c.descriptors}`)
    .join("\n");

  const { parsed } = await generateWithRepair({
    examId,
    purpose: "grade",
    model,
    system: GRADE_SYSTEM,
    user: gradeUser(
      question.qNo,
      question.maxMarks,
      question.text,
      criteriaList,
      baseline?.solutionText ?? "(no baseline solution)",
      baseline && baseline.alternatives.length > 0
        ? baseline.alternatives.join("\n")
        : "(none listed)"
    ),
    images,
    maxOutputTokens: 2000,
    temperature: 0.2,
    validate: (raw) => validateGradeOutput(raw),
  });
  const out = validateGradeOutput(parsed);

  // Deterministic validation: trust nothing from the model.
  const critById = new Map(criteria.map((c) => [c.id, c]));
  for (const cm of out.criterionMarks) {
    const c = critById.get(cm.criterionId);
    if (!c) throw new Error(`Unknown criterion ${cm.criterionId} in model output`);
    if (cm.marks - c.maxMarks > 0.001)
      throw new Error(`Criterion ${c.label}: ${cm.marks} exceeds max ${c.maxMarks}`);
  }
  // Every criterion must be scored; missing ones fail the job for faculty review.
  const scored = new Set(out.criterionMarks.map((cm) => cm.criterionId));
  for (const c of criteria) {
    if (!scored.has(c.id)) throw new Error(`Criterion ${c.label} was not scored`);
  }
  const sum = out.criterionMarks.reduce((s, cm) => s + cm.marks, 0);
  if (Math.abs(sum - out.total) > 0.01)
    throw new Error(`Total ${out.total} does not match criterion sum ${sum}`);
  if (out.total - question.maxMarks > 0.001)
    throw new Error(`Total ${out.total} exceeds question max ${question.maxMarks}`);

  const flags = [...out.flags];
  if (out.confidence === "low" && !flags.includes("low-confidence")) {
    flags.push("low-confidence");
  }

  await db.questionEvaluation.upsert({
    where: { evaluationId_questionId: { evaluationId, questionId } },
    create: {
      evaluationId,
      questionId,
      aiMarks: out.total,
      aiJustification: `${out.interpretedSummary}\n\n${out.justification}`,
      criterionMarks: out.criterionMarks,
      evidenceRefs: out.evidenceRefs,
      confidence: out.confidence.toUpperCase() as "HIGH" | "MED" | "LOW",
      flags,
      model,
    },
    update: {
      aiMarks: out.total,
      aiJustification: `${out.interpretedSummary}\n\n${out.justification}`,
      criterionMarks: out.criterionMarks,
      evidenceRefs: out.evidenceRefs,
      confidence: out.confidence.toUpperCase() as "HIGH" | "MED" | "LOW",
      flags,
      model,
    },
  });
}
