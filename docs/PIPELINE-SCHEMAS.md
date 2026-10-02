# Pipeline schemas: stages 1-3 (extraction, scheme parse, baseline)

Companion to `PIPELINE.md`. This document is the contract between the Gemini
adapter (`lib/gemini/adapter.ts`), the worker jobs, and the faculty UI for
Phase 2. Schemas and prompt templates only. No implementation code.

Conventions used below:

- Model output is always a single JSON object. No markdown fences, no prose.
- `TaskKind` mapping: extraction and scheme parse use `"extract"`,
  baseline uses `"baseline"`. See `modelFor()` in the adapter.
- `purpose` values for `logUsage` / `ApiUsage`: `question-extract`,
  `scheme-parse`, `baseline`.
- All token estimates are rough planning figures, not guarantees.
  Real numbers come from the `ApiUsage` table once the pipeline runs.

---

## 1. Stage 1: question extraction

### 1.1 Input contract

- Source: question paper as PDF converted to page images, or uploaded page
  images directly.
- Images are downscaled to `config.capture.maxImageWidth` (default 1600px),
  JPEG quality ~80, before sending.
- One job per exam (`Job.type = "ingest-paper"`). Payload:
  `{ examId, sourceHash, pageCount }`. `sourceHash` makes the job idempotent:
  re-uploading the identical file does not re-run extraction.
- Page batching: at most 10 page images per model call. Papers with more
  pages are split into batches; results are merged by concatenating the
  `questions` arrays and re-sequencing `sortOrder` from 0 in paper order.

### 1.2 Output JSON schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["questions"],
  "additionalProperties": false,
  "properties": {
    "questions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 200,
      "items": {
        "type": "object",
        "required": ["qNo", "text", "maxMarks", "qType", "sortOrder"],
        "additionalProperties": false,
        "properties": {
          "qNo": {
            "type": "string",
            "minLength": 1,
            "maxLength": 12,
            "pattern": "^[0-9]+[A-Za-z]?(\\([^\\)]{1,6}\\))?$",
            "description": "Full printed identifier: '1', '2a', '3(i)'. Unique per exam."
          },
          "subPart": {
            "type": ["string", "null"],
            "maxLength": 8,
            "description": "Suffix only ('a', '(i)'), or null. Display helper; qNo stays the unique key."
          },
          "text": {
            "type": "string",
            "minLength": 3,
            "maxLength": 4000,
            "description": "Full question text, transcribed exactly. MCQ options included inline."
          },
          "maxMarks": {
            "type": ["number", "null"],
            "exclusiveMinimum": 0,
            "description": "Marks as printed. Null when the paper does not print marks for this question."
          },
          "qType": {
            "type": "string",
            "enum": ["mcq", "descriptive", "numerical", "equation", "diagram", "code"]
          },
          "topic": {
            "type": ["string", "null"],
            "maxLength": 80,
            "description": "Short noun phrase, best effort, e.g. 'rotational kinematics'. Null if unclear."
          },
          "sortOrder": {
            "type": "integer",
            "minimum": 0,
            "description": "0-based paper order."
          },
          "flags": {
            "type": "array",
            "maxItems": 8,
            "items": {
              "type": "string",
              "enum": ["missing-marks", "possible-merge", "low-confidence-read", "continued-from-previous-page"]
            }
          }
        }
      }
    }
  }
}
```

### 1.3 Per-field validation rules (deterministic, in code)

- `questions` is a non-empty array. Empty array is a hard failure, not a
  valid "no questions" result.
- `qNo` values are unique within the exam after trimming whitespace and
  lowercasing for comparison. Duplicates: park for faculty review, do not
  auto-renumber.
- `text` is non-empty after trimming. Text shorter than 3 chars is treated
  as a read failure for that question.
- `maxMarks`: number > 0, or null. Null is allowed in model output but is
  never persisted: the question stays in draft state with flag
  `missing-marks` until faculty fills it in the editor. `Question.maxMarks`
  in Prisma is required, so materialization is blocked until every question
  has marks.
- `qType` must be one of the six enum values (case-insensitive input is
  normalized to lowercase, then mapped to the Prisma `QuestionType` enum on
  persist).
- `sortOrder` must be exactly `0..n-1` with no gaps after batch merging.
  The worker re-sequences; the model is asked to produce them in order.
- `topic` longer than 80 chars is truncated at a word boundary by the worker,
  not rejected.
- Unknown `flags` values are dropped with a warning log, not treated as fatal.

### 1.4 qType classification guidance (for the prompt)

- `mcq`: options A-D (or a-d, 1-4) are printed. Include the options in `text`.
- `numerical`: asks for a computed value, usually with units or significant
  figures.
- `equation`: derive, prove, or solve symbolically.
- `diagram`: draw, sketch, or label a figure.
- `code`: write a program, function, or pseudocode.
- `descriptive`: everything else. This is the default when in doubt.
- Mixed questions (e.g. "derive the expression and sketch the curve"):
  pick the type matching the highest-mark component.

### 1.5 Common extraction failures

- **Merged questions.** The model sometimes folds Q4 into Q3's text.
  Heuristic flag: if a question's `text` contains a second question number
  pattern (e.g. text of `qNo: "3"` contains "Q. 4" or "4." at line start),
  the worker sets `possible-merge` and the question goes to faculty review.
  Never auto-split: splitting changes marks and grading scope.
- **Missing marks.** Papers that say "answer any 5 of 7" or omit marks get
  `maxMarks: null` plus `missing-marks`. Faculty fills marks in the editor;
  extraction is not re-run.
- **Sub-parts 2a / 2b.** Rule: when sub-parts carry independent marks,
  emit one row per sub-part with `qNo` = full identifier (`"2a"`, `"2b"`)
  and `subPart` = suffix (`"a"`, `"b"`). When parts share a single mark
  (e.g. "2a and 2b together carry 5 marks"), emit one row with `qNo: "2"`,
  `subPart: null`, and mention the parts in `text`. This respects the
  `@@unique([examId, qNo])` constraint: `qNo` is always the unique key.
- **Question split across pages.** The model sees all pages in the batch,
  so it should join continued text itself. If it emits
  `continued-from-previous-page`, the worker concatenates that question's
  text with the previous question of the same `qNo` during merge.
- **Unreadable region.** If part of a page is illegible in the scan,
  the model uses `low-confidence-read` and transcribes what it can.
  Faculty corrects the text in the editor. The pipeline never invents
  question text.

### 1.6 Draft-before-persist rule

Extraction output is stored as draft JSON on the ingestion job result, not
written directly to `Question` rows. The faculty editor works on the draft.
Only when every question passes validation (marks filled, qNo unique) does
the worker materialize `Question` rows and move the exam to `PREPARED`.
This keeps the Prisma required-field invariants intact.

---

## 2. Stage 2: marking-scheme parse

### 2.1 Input contract

- Source: marking scheme as PDF, DOCX (converted to PDF, then images), or
  page images. Handwritten schemes are expected and supported.
- Context: the confirmed extracted questions for the exam, passed as a
  compact list: `[{qNo, maxMarks, text (truncated to 300 chars)}]`. The model
  must attach every criterion to one of these `qNo` values.
- One job per exam (`Job.type = "scheme-parse"`). Payload:
  `{ examId, sourceHash }`. Same idempotency rule as extraction.
- Images downscaled the same way as stage 1. Same 10-page batching rule.

### 2.2 Output JSON schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["questions"],
  "additionalProperties": false,
  "properties": {
    "questions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 200,
      "items": {
        "type": "object",
        "required": ["qNo", "criteria"],
        "additionalProperties": false,
        "properties": {
          "qNo": {
            "type": "string",
            "minLength": 1,
            "maxLength": 12,
            "description": "Must match an extracted question qNo exactly."
          },
          "criteria": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": {
              "type": "object",
              "required": ["label", "maxMarks", "descriptors"],
              "additionalProperties": false,
              "properties": {
                "label": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 120,
                  "description": "Short criterion name, e.g. 'Correct formula', 'Unit stated'."
                },
                "maxMarks": {
                  "type": "number",
                  "exclusiveMinimum": 0
                },
                "descriptors": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 500,
                  "description": "What earns full marks, what earns partial, what earns zero. One to two sentences."
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### 2.3 Per-field validation rules (deterministic, in code)

- Every `qNo` must match a confirmed extracted question (normalized the
  same way as stage 1). Unmatched `qNo` values produce an `orphan-criteria`
  flag; those criteria are held in the draft, not persisted, until faculty
  maps or discards them.
- `label` non-empty, unique within its question after normalization.
  Duplicates are suffixed by the worker (`"Steps shown (2)"`) and flagged
  for faculty cleanup, not rejected.
- `maxMarks` > 0. Zero or negative is a schema failure for that criterion.
- `descriptors` non-empty. Empty descriptors are filled with the placeholder
  `"Faculty to review"` and flagged, so the editor always has something to
  show.
- Questions with no criteria entry at all get a `no-criteria` flag. The
  pipeline continues: stage 3 drafts criteria-worthy notes anyway, and the
  faculty editor shows the gap.

### 2.4 Mark-sum mismatch rules

This is the critical integrity rule for the whole rubric. Let
`S = sum(criteria.maxMarks)` and `Q = question.maxMarks`.

- **S == Q.** Clean. Persist as draft rubric.
- **S < Q (under-allocated).** Common: schemes say things like "2 marks for
  method" and leave the rest implicit. Do not invent criteria to fill the
  gap. Flag `under-allocated` with the numeric gap shown in the editor
  (e.g. "criteria sum to 6 of 10 marks"). Faculty resolves by adding
  criteria or adjusting marks. The draft rubric version records the gap.
- **S > Q (over-allocated).** Never silently scale marks down: scaling
  changes the scheme's meaning and hides faculty intent. Flag
  `over-allocated` with both numbers. Faculty must fix before approval.
  The approve endpoint refuses to approve a rubric version with unresolved
  over-allocation.
- **Rounding.** Compare with a tolerance of 0.001 to absorb float noise.
  Anything beyond tolerance follows the rules above.

Faculty resolution happens in the baseline editor (Phase 2 UI). The approved
`RubricVersion` stores the final numbers; the mismatch flags are part of the
audit trail on the draft, not on the approved version.

### 2.5 Draft-before-persist rule

Same as stage 1: scheme output is draft JSON on the job result. Faculty
edits criteria in the editor. Materialization writes `RubricVersion`
(version 1, status `DRAFT`), its `RubricCriterion` rows, and empty
`BaselineSolution` shells. Approval flips the version to `APPROVED` with
`approvedAt`; that version is then frozen and referenced by all later
evaluations.

---

## 3. Stage 3: baseline generation

### 3.1 Input contract

- One job per question (`Job.type = "generate-baseline"`). Payload:
  `{ examId, rubricVersionId, questionId }`. Idempotent on the
  `@@unique([rubricVersionId, questionId])` of `BaselineSolution`: a
  completed baseline is never regenerated unless faculty explicitly asks.
- Context is the single question only: `qNo`, `text`, `maxMarks`, `qType`,
  and its criteria `[{label, maxMarks, descriptors}]`. Nothing else. No
  other questions, no full scheme, no paper context.
- This is the one stage that uses the capable model (`TaskKind "baseline"`),
  because baseline quality bounds every later grading decision.

### 3.2 Output JSON schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["solutionText", "alternatives", "criterionNotes"],
  "additionalProperties": false,
  "properties": {
    "solutionText": {
      "type": "string",
      "minLength": 20,
      "maxLength": 2000,
      "description": "Concise correct solution. Working shown for numerical, key points for descriptive."
    },
    "alternatives": {
      "type": "array",
      "maxItems": 5,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "One acceptable variant answer each. Empty array when none exist."
      },
      "description": "At most 5, each one line."
    },
    "criterionNotes": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["criterionLabel", "notes"],
        "additionalProperties": false,
        "properties": {
          "criterionLabel": {
            "type": "string",
            "description": "Must match a criterion label from the input exactly."
          },
          "notes": {
            "type": "string",
            "minLength": 1,
            "maxLength": 400,
            "description": "Grading guidance for this criterion: common errors, partial-credit boundaries."
          }
        }
      }
    }
  }
}
```

### 3.3 Validation rules (deterministic, in code)

- `solutionText` between 20 and 2000 chars. Shorter is treated as a
  degenerate answer and retried once.
- `alternatives`: at most 5, each deduplicated against `solutionText` and
  against each other (normalized comparison). Duplicates are dropped, not
  fatal.
- `criterionNotes` must cover every input criterion label exactly once.
  Labels are matched exactly as sent; a missing or extra label is a schema
  failure for the repair retry. After a successful repair, any still-missing
  label gets `notes: "Faculty to review"` and a flag.
- No marks are emitted in this stage. If the model includes marks anyway,
  the worker strips numeric mark claims from `notes` and logs a warning.
  Marks live only in the rubric criteria.

### 3.4 How criterion notes merge

`RubricCriterion.descriptors` is the single persisted home for grading
guidance (the Prisma schema has no separate notes column). The worker
appends the baseline `notes` to the existing `descriptors` for the matching
criterion, separated by a blank line, on the draft rubric version only.
The faculty editor shows the merged text and can edit freely. Nothing is
written to an `APPROVED` version: if faculty regenerates a baseline after
approval, the worker creates a new draft `RubricVersion` instead.

### 3.5 Compactness rules

- Prompt carries one question and its criteria. Target under 800 input
  tokens per call.
- `maxOutputTokens` capped at 2000 for this stage.
- Alternatives capped at 5, one line each. Notes capped at 400 chars per
  criterion. The prompt states these caps explicitly so the model does not
  ramble.
- Baseline is generated once per question per rubric version and cached in
  `BaselineSolution`. Grading reuses it without re-calling.

---

## 4. Prompt skeletons

All prompts are plain text. Placeholders use `{{name}}`. System prompts are
kept short: role, task, output contract, and the two or three domain rules
that matter. Temperature guidance: 0.2 for stages 1-2 (deterministic
extraction), 0.4 for stage 3 (allows varied alternatives).

### 4.1 Stage 1: question extraction

System:

```
You extract questions from a college exam paper image into strict JSON.
Return ONLY the JSON object, no markdown fences, no commentary.
Follow the schema exactly. Transcribe text faithfully; never invent content.
If a region is illegible, transcribe what you can and set "low-confidence-read".
```

User template:

```
Extract every question from these paper pages (page {{n}} of {{total}} in this batch).

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
{{extraction_json_schema}}

Return only the JSON object.
[images: page batch]
```

### 4.2 Stage 2: marking-scheme parse

System:

```
You parse a college marking scheme into per-question grading criteria as strict JSON.
Return ONLY the JSON object, no markdown fences, no commentary.
Attach every criterion to one of the provided question numbers.
Never invent criteria. Never rescale marks.
```

User template:

```
Parse this marking scheme. The confirmed questions for this exam are:

{{questions_compact_list}}
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
{{scheme_json_schema}}

Return only the JSON object.
[images: scheme pages]
```

### 4.3 Stage 3: baseline generation

System:

```
You are a subject-matter tutor writing a grading reference for a college exam.
Return ONLY the JSON object, no markdown fences, no commentary.
Be concise. Do not include marks anywhere in your answer.
```

User template:

```
Write the baseline solution and grading notes for this one question.

Question {{qNo}} ({{maxMarks}} marks, type: {{qType}}):
{{question_text}}

Grading criteria:
{{criteria_list}}
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
{{baseline_json_schema}}

Return only the JSON object.
```

### 4.4 Repair prompt (schema-invalid output, all stages)

```
Your last output was not valid against the required schema.
Validation error: {{validation_error}}
Original input is repeated below. Return ONLY the corrected JSON object,
no markdown fences, no commentary.

{{original_user_prompt}}
```

---

## 5. Deterministic validation, retry policy, park-vs-retry

### 5.1 Validation layers (in code, no model trust)

1. Parse: output must be valid JSON. Strip a single pair of surrounding
   markdown fences if present before failing; anything more is invalid.
2. Schema: validate against the stage schema above (use a JSON Schema
   validator, e.g. ajv). Collect all errors, not just the first.
3. Cross-field: qNo uniqueness, criterion label coverage, mark-sum
   comparison (stage 2), alternatives deduplication (stage 3).
4. Cross-stage: stage 2 qNo values exist in confirmed questions; stage 3
   criterion labels match the rubric version's criteria.

### 5.2 Retry policy

- Transport errors (429, 5xx, timeout after `config.gemini.timeoutMs`):
  retry up to `config.gemini.maxRetries` with exponential backoff
  (2s, 8s). Then the job moves to `retryable` with `runAfter` set by
  backoff. The UI shows a banner; resume continues from the first
  incomplete job. Each attempt is logged to `ApiUsage` with status
  `retry`, the terminal state with `failed`.
- Schema-invalid output: exactly 1 repair retry using the repair prompt
  in 4.4. If it still fails, park for faculty review with the raw output
  attached. Log `retry` then `failed`.
- Truncated output (finish reason `MAX_TOKENS`): 1 retry with
  `maxOutputTokens` raised by 50 percent, then park.
- Budget: `withinBudget(examId)` is checked before every call. When the
  budget is exceeded, the pipeline pauses, `ApiUsage` logs status `quota`,
  and the dashboard shows spend vs cap. No automatic retry; faculty raises
  the cap or resumes.

### 5.3 Park vs retry matrix

| Failure | Retry | Park for faculty |
|---|---|---|
| Invalid JSON | 1 repair retry | Yes, with raw output attached |
| Truncated output | 1 retry, higher token cap | Yes |
| 429 / 5xx / timeout | Backoff up to maxRetries | Job to `retryable`, UI banner |
| Quota / budget exceeded | No | Pipeline paused, spend shown |
| Missing marks (null maxMarks) | No | `missing-marks`, faculty fills in editor |
| Merged questions | No | `possible-merge`, faculty splits |
| Mark sum under-allocated (S < Q) | No | `under-allocated`, faculty adds criteria |
| Mark sum over-allocated (S > Q) | No | `over-allocated`, approval blocked until fixed |
| Orphan criteria (qNo unmatched) | No | `orphan-criteria`, faculty maps or discards |
| Question with no criteria | No | `no-criteria`, pipeline continues, editor shows gap |

Principle: the pipeline retries transient failures and parks semantic
ones. Anything involving marks is never auto-fixed; faculty decides.

---

## 6. Cost notes

### 6.1 Model tier per stage

| Stage | TaskKind | Tier | Why |
|---|---|---|---|
| 1. Question extraction | `extract` | Light (`GEMINI_MODEL_LIGHT`) | Transcription and classification, no reasoning depth needed |
| 2. Scheme parse | `extract` | Light | Structure extraction from a rubric document |
| 3. Baseline generation | `baseline` | Capable (`GEMINI_MODEL_CAPABLE`) | Solution quality bounds all later grading; the one place to spend |

### 6.2 Token estimates per call (rough)

| Stage | Calls | Input / call | Output / call | Notes |
|---|---|---|---|---|
| 1. Extraction | 1 per 10-page batch | ~1.2k per page image + ~0.5k prompt | ~150 per question | A 3-page, 10-question paper: ~4k in, ~1.5k out |
| 2. Scheme parse | 1 per 10-page batch | ~1.2k per page image + ~1k prompt (includes question list) | ~120 per criterion | Handwritten schemes read slightly worse; no extra cost, just more flags |
| 3. Baseline | 1 per question | ~0.5-0.8k (question + criteria) | ~0.7-1.2k | 10 questions: ~6-8k in, ~8-12k out on the capable model |

These are planning figures. The `ApiUsage` table records actuals per
`purpose`, and the dashboard aggregates per-exam spend from it.

### 6.3 Caching rules (extract once, reuse)

- Extraction draft JSON is cached on the ingestion job result, keyed by
  `sourceHash`. Re-uploading the same file never re-calls the model.
- Scheme draft JSON is cached the same way on the scheme-parse job.
- `BaselineSolution` rows are cached per `(rubricVersionId, questionId)`.
  Regeneration is per-question and only on explicit faculty request.
- Grading (Phase 4) reuses all three artifacts without any re-extraction.
  Its prompts carry only the single question, its criteria, and the
  approved baseline.
- If the paper is re-uploaded (new `sourceHash`), extraction re-runs and
  faculty re-confirms; existing approved rubric versions and evaluations
  are untouched.

### 6.4 Budget enforcement

- `GEMINI_MAX_RETRIES` (default 2) and `GEMINI_TIMEOUT_MS` (default 60000)
  bound every call.
- `EXAM_TOKEN_BUDGET_PROMPT` / `EXAM_TOKEN_BUDGET_OUTPUT` (default 0 =
  unlimited) set per-exam caps. `withinBudget()` gates each call; the
  pipeline pauses with a clear dashboard state when a cap is hit.
- `maxOutputTokens` per stage: extraction 4000, scheme parse 4000,
  baseline 2000. Caps are set on the adapter call, not just suggested in
  the prompt.
