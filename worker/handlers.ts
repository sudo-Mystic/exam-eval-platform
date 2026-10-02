import { db } from "../lib/db";
import { storage } from "../lib/storage";
import {
  rasterizePdf,
  normalizePageImage,
  storePaperPage,
} from "../lib/ingestion/pdf";
import { GeminiProvider, isRetryable } from "../lib/gemini/provider";
import { modelFor, logUsage, withinBudget } from "../lib/gemini/adapter";
import {
  EXTRACTION_SYSTEM,
  extractionUser,
  SCHEME_SYSTEM,
  schemeUser,
  BASELINE_SYSTEM,
  baselineUser,
  repairUser,
} from "../lib/gemini/prompts";
import { getOrCreateDraftVersion } from "../lib/rubric";
import type { JobPayloadMap } from "../lib/queue";
import { QuestionType } from "@prisma/client";

const provider = new GeminiProvider();
const QTYPES = new Set(Object.values(QuestionType));
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
  let user = args.user;
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
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}
