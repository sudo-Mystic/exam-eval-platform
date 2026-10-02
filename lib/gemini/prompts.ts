// Prompt builders for the Phase 2 pipeline stages.
// Token-frugal: short system prompts, JSON-only, caps stated in-prompt.
// Placeholders are filled by the worker handlers.

export const EXTRACTION_SYSTEM = `You extract questions from a college exam paper image into strict JSON.
Return ONLY the JSON object, no markdown fences, no commentary.
Follow the schema exactly. Transcribe text faithfully; never invent content.
If a region is illegible, transcribe what you can and set "low-confidence-read".`;

export function extractionUser(page: number, total: number): string {
  return `Extract every question from these paper pages (page ${page} of ${total} in this batch).

Rules:
- qNo is the full printed identifier ("1", "2a", "3(i)"). Keep sub-parts separate
  when they carry their own marks.
- maxMarks is the printed mark value. Use null when the paper prints no marks
  for a question. Never guess marks.
- qType is one of: mcq, descriptive, numerical, equation, diagram, code.
  Default to descriptive when unsure.
- topic is a short noun phrase (max 6 words) or null.
- sortOrder is 0-based paper order within this batch.
- For MCQs include the options in text.

Schema:
{"type":"object","required":["questions"],"properties":{"questions":{"type":"array","items":{"type":"object","required":["qNo","text","maxMarks","qType","sortOrder"],"properties":{"qNo":{"type":"string"},"subPart":{"type":["string","null"]},"text":{"type":"string"},"maxMarks":{"type":["number","null"]},"qType":{"type":"string","enum":["mcq","descriptive","numerical","equation","diagram","code"]},"topic":{"type":["string","null"]},"sortOrder":{"type":"integer"},"flags":{"type":"array","items":{"type":"string"}}}}}}}}

Return only the JSON object.`;
}

export const SCHEME_SYSTEM = `You parse a college marking scheme into per-question grading criteria as strict JSON.
Return ONLY the JSON object, no markdown fences, no commentary.
Attach every criterion to one of the provided question numbers.
Never invent criteria. Never rescale marks.`;

export function schemeUser(questionsCompact: string): string {
  return `Parse this marking scheme. The confirmed questions for this exam are:

${questionsCompact}
(format: "qNo | maxMarks | first 300 chars of text", one per line)

Rules:
- Every criterion's qNo must match one of the listed questions exactly.
- label is a short criterion name (e.g. "Correct formula", "Unit stated").
- maxMarks is the mark value from the scheme. Never adjust or normalize it.
- descriptors: one or two sentences on what earns full, partial, and zero.
- If the scheme has no criteria for a listed question, omit that question.
- If a scheme entry matches no listed question, still include it; it will be
  flagged for faculty mapping.

Schema:
{"type":"object","required":["criteria"],"properties":{"criteria":{"type":"array","items":{"type":"object","required":["qNo","label","maxMarks","descriptors"],"properties":{"qNo":{"type":"string"},"label":{"type":"string"},"maxMarks":{"type":"number"},"descriptors":{"type":"string"}}}}}}

Return only the JSON object.`;
}

export const BASELINE_SYSTEM = `You are a subject-matter tutor writing a grading reference for a college exam.
Return ONLY the JSON object, no markdown fences, no commentary.
Be concise. Do not include marks anywhere in your answer.`;

export function baselineUser(
  qNo: string,
  maxMarks: number,
  qType: string,
  questionText: string,
  criteriaList: string
): string {
  return `Write the baseline solution and grading notes for this one question.

Question ${qNo} (${maxMarks} marks, type: ${qType}):
${questionText}

Grading criteria:
${criteriaList}
(format: "- label (maxMarks marks): descriptors", one per line)

Rules:
- solutionText: concise correct solution, max ~300 words. Show working for
  numerical questions, key points for descriptive ones.
- alternatives: up to 5 acceptable variant answers, one line each.
  Empty array if none exist.
- criterionNotes: one entry per criterion label above, label copied exactly.
  Each note max ~60 words: common student errors and partial-credit boundaries.
- Do not award or mention marks.

Schema:
{"type":"object","required":["solutionText","alternatives","criterionNotes"],"properties":{"solutionText":{"type":"string"},"alternatives":{"type":"array","items":{"type":"string"},"maxItems":5},"criterionNotes":{"type":"array","items":{"type":"object","required":["label","note"],"properties":{"label":{"type":"string"},"note":{"type":"string"}}}}}}

Return only the JSON object.`;
}

export function repairUser(validationError: string): string {
  return `Your last output was not valid against the required schema.
Validation error: ${validationError}
Return ONLY the corrected JSON object, no markdown fences, no commentary.`;
}
