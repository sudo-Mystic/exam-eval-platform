# AI evaluation pipeline

Structured stages. Each stage has its own compact prompt and strict JSON schema.
No giant prompts. No whole-paper context in grading calls.

## Stage 1: Ingest paper

Input: PDF or page images of the question paper.
Model: light (configurable, default gemini-2.0-flash).
Output per question: qNo, text, maxMarks, qType (mcq/descriptive/numerical/equation/diagram/code), topic guess, sortOrder.
Faculty corrects in UI. Result cached on the exam. Never re-extracted unless paper re-uploaded.

## Stage 2: Parse marking scheme

Input: scheme PDF/DOCX/images.
Model: light.
Output per question: list of criteria {label, maxMarks, descriptors}.
Faculty corrects. This becomes RubricVersion v1 draft.

## Stage 3: Baseline solution

Input per question: question text + criteria.
Model: capable (default gemini-2.5-pro) - this is the one place quality matters most.
Output: solutionText, alternatives[] (acceptable variants), per-criterion grading notes.
Faculty edits freely. On approval, RubricVersion status -> APPROVED with timestamp.
The approved version is frozen and referenced by every later evaluation.

## Stage 4: Question matching

Input per answer sheet: page thumbnails in order.
Model: light vision.
Output per page region: questionId, confidence, flags (continued-across-pages, out-of-order, uncertain).
Low-confidence mappings surface in the capture workspace for faculty correction.
Manual correction always allowed. ExtractedAnswer rows store pageIds in reading order + normalized region refs.

## Stage 5: Grading

One request per question per student.
Context (only this): question text, its criteria, approved baseline + alternatives, the relevant page crops + interpreted text.
Output (strict JSON):
- interpretedSummary: concise reading of what the student wrote
- criterionMarks: [{criterionId, marks, note}]
- total: sum, must equal criterion sum
- justification: brief, tied to the student's actual answer
- evidenceRefs: ["page3:12,40,88,70", ...]
- confidence: high | med | low
- flags: unreadable | ambiguous | unsupported-conclusion | question-match-uncertain | ...

Deterministic validation (no model trust):
- 0 <= each mark <= criterion maxMarks
- sum(criterionMarks) == total, total <= question maxMarks
- required fields present, evidenceRefs non-empty unless flagged unreadable
- fail -> 1 retry -> park as NEEDS_REVIEW with raw output attached

## Stage 6: Review and finalize

Faculty edits marks per question/criterion. Overrides stored as EvaluationOverride rows;
QuestionEvaluation.aiMarks never mutated. Totals recalculated. Finalize writes
FinalResult linked to evaluationId + rubricVersionId, with finalizedAt timestamp.
Published results are distinct from unreviewed AI output in the UI.

## Reliability notes per question type

- MCQ: exact match, high reliability.
- Numerical: working checked against baseline; unit and tolerance per rubric.
- Descriptive: rubric-driven partial credit; vague answers flagged med/low confidence.
- Equation: interpreted form shown to faculty for verification; transcription risk flagged.
- Diagram: labeled parts and structure checked; missing/unclear labels flagged, never invented.
- Code: logic vs syntax separated per rubric; no execution in MVP, so runtime behavior is not verified.

Model confidence is surfaced as a review signal, not a calibrated probability.
