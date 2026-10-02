# UI Spec: Phase 2 (Paper Ingestion, Baseline, Rubric Approval)

Scope: everything from question-paper upload through faculty approval of the
baseline solution and rubric. Ends when the exam reaches READY and grading can
begin. Nothing from Phase 3 (camera, students) or later phases is in scope.

Design posture: dense faculty ops tool. Zinc neutrals, one locked blue accent,
status colors only for grading/pipeline states. Tabular numerals for all marks.
Desktop-first; responsive collapse below 1024px but not mobile-first. Motion is
limited to fades on state change and skeleton shimmer. No decorative animation.

## 1. Screen inventory

### 1.1 Exam detail and pipeline overview

Route: `/exams/[id]`

The hub for Phase 2. Sections, top to bottom:

1. Exam header: title, subject, term, exam status badge.
2. Workflow stepper (see Components): Draft > Paper > Questions > Baseline >
   Approved. Clickable; completed steps link to their screens.
3. Two upload cards side by side: Question paper and Marking scheme. Each card
   owns its ingest state (see section 5).
4. Pipeline status panel: current RubricVersion (e.g. "Rubric v2, draft"),
   counts (questions extracted, baselines generated, baselines faculty-edited),
   token spend for this exam (from ApiUsage, small muted line).
5. Entry links: "Review questions", "Edit baselines", "Review and approve
   rubric". Each shows a completeness fraction (e.g. "9/12 baselines ready").

### 1.2 Paper upload zone

Not a separate route. Lives on `/exams/[id]` as the two upload cards above.
Rationale: upload and ingest status belong next to the pipeline overview;
a separate route adds navigation without adding clarity.

Behavior per card:
- Drag and drop plus click-to-browse. Paper accepts PDF, PNG, JPG (multi-file).
  Scheme accepts PDF, DOCX, PNG, JPG.
- Client-side validation before upload: file type and 25 MB per-file cap, with
  an inline error naming the offending file.
- On drop, files upload immediately (POST multipart). Upload progress bar per
  file, then the card flips to ingest state and polls the ingest job.
- Re-upload replaces the previous file set for that card and marks downstream
  artifacts stale (questions flagged "needs re-review" if the paper changes
  after extraction; baselines flagged likewise if the scheme changes). Stale is
  a flag, never a silent delete.

### 1.3 Question list editor

Route: `/exams/[id]/questions`

Table of extracted questions after Stage 1 ingestion. Columns: Q.No, Question
text (truncated, expands on row click), Type, Max marks, Topic, Baseline state
(not started / draft / faculty-edited). Dense rows, 13px text, 40px row height.

Row interactions:
- Click a row to expand an inline editor: qNo, full text (textarea), maxMarks
  (numeric), qType (select: MCQ, Descriptive, Numerical, Equation, Diagram,
  Code), topic (text, optional), sortOrder handled by drag handle.
- Add question (empty row, focused), delete question (confirm; blocked with a
  clear message if baselines or criteria already exist for it, offering
  cascade delete explicitly).
- Duplicate qNo is rejected inline (schema has @@unique([examId, qNo])).
- maxMarks must be > 0. Changing maxMarks after criteria exist shows a warning
  that criterion sums must be reconciled before approval.

Header actions: "Re-extract questions" (confirm; re-runs ingest-paper job,
marks existing questions for faculty re-review), "Generate baselines" (queues
generate-baseline jobs for questions missing them), link to baseline editor.

### 1.4 Per-question baseline editor

Route: `/exams/[id]/baseline/[questionId]`

Two-pane layout. Left: question rail (240px, scrollable list of all questions
with status dots: complete / incomplete / faculty-edited / error). Right: the
editor for the selected question. The rail makes this the per-question editor
without losing cross-question context.

Right pane sections:
1. Question summary card (read-only): qNo, text, maxMarks, type, topic.
   "Edited in question list" link jumps to `/exams/[id]/questions`.
2. Baseline solution: large textarea for solutionText. Monospace toggle for
   code-type questions. Character count, muted.
3. Acceptable alternatives: list editor (see interaction spec).
4. Rubric criteria: criterion cards, each with label, maxMarks input,
   descriptors textarea ("what earns full / partial / zero"). Add/remove/
   reorder criteria. Live sum indicator: "Criteria total 8 / Question 10" in
   error color when mismatched.
5. Sticky bottom save bar (appears only when dirty): "Unsaved changes",
   Save (primary), Discard (ghost).

### 1.5 Rubric review and approval

Route: `/exams/[id]/rubric`

Read-mostly review screen plus the approval action. Sections:

1. Version header: "Rubric v2 (draft)". Version history list below it:
   each prior version with status, approved timestamp, and how many
   evaluations still pin to it.
2. Approval checklist (all must pass):
   - Every question has a non-empty baseline solution.
   - Every question has at least one criterion.
   - Criterion marks sum to the question maxMarks for every question.
   - No unresolved validation errors.
   Each item shows a live count, e.g. "11/12 questions have baselines", and
   links directly to the failing question in the baseline editor.
3. Full rubric table: per question, criteria with marks and descriptors, plus
   faculty-edited badges where BaselineSolution.facultyEdited is true. This is
   the "what am I approving" view. Dense but complete; collapsed by question
   with expand-all.
4. Approve button (primary, disabled until the checklist passes, with the
   blocking reason as helper text). Opens the approval confirm dialog.
5. Pinning notice: "N evaluations grade against v1. Approving v2 does not
   change them. New evaluations will use v2." This is always visible, not
   buried in the dialog.

## 2. Component inventory

New reusable components under `components/` (feature) and
`components/ui/` (primitives). Props listed where they shape the contract.

- `WorkflowStepper({ steps: { key, label, href?, state: done|current|todo }[] })`
  Horizontal stepper for the exam detail page. Done steps show a check in
  accent-soft; current step is accent text. Todo steps are muted and not
  clickable.
- `UploadCard({ title, accept, multiple, maxSizeMB, hint, onUpload, ingest })`
  Wraps `UploadZone` and `IngestProgress`. Owns file validation messages.
- `UploadZone({ accept, multiple, onFiles })` Drag-drop plus browse. Visual
  drag-over state (accent border). No upload logic inside; it only yields files.
- `IngestProgress({ job, onRetry })` job: `{ status, processed, total,
  error }`. Queued: muted "Queued". Running: progress bar with counts
  ("Extracting questions, 4 of 12 pages"). Done: good-tone "12 questions
  extracted". Failed/retryable: bad-tone error line plus Retry button.
- `QuestionTable({ questions, onSelect, onAdd, onDelete, onReorder })`
  Dense table with expandable rows and drag handles.
- `QuestionRowEditor({ question, onSave, onCancel })` Inline form for one
  question. Validates qNo uniqueness (server round-trip), maxMarks > 0.
- `QuestionTypeBadge({ type })` Small muted badge; color does not vary by
  type (type is metadata, not status).
- `BaselineEditor({ question, baseline, criteria, dirty, onChange })`
  The right-pane editor from 1.4. Pure presentational; state lives in the
  page.
- `AlternativesList({ items: string[], onChange })` Add input plus list rows
  with edit, delete, and up/down reorder. Empty-string items are rejected
  with an inline hint.
- `CriterionCard({ criterion, onChange, onDelete })` Label input, marks
  numeric input, descriptors textarea, delete with confirm if it has content.
- `MarksInput({ value, max, onChange })` Numeric input, tabular numerals,
  clamps visually and flags out-of-range in bad tone. Props make the allowed
  range explicit.
- `DirtyBar({ dirtyCount, onSave, onDiscard, saving })` Sticky bottom bar.
  Rendered only when dirtyCount > 0.
- `VersionBadge({ version, status })` "v2 draft" (review tone) vs "v1
  approved" (good tone).
- `ApprovalChecklist({ items: { label, passed, detail, href? }[] })`
  Checklist with pass/fail icons and deep links to fix failures.
- `ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel, danger })`
  Generic modal used for approve, delete, and re-extract confirmations.
  Focus trap, Esc to cancel, primary action autofocused only when not danger.
- `ApiUsageMeter({ promptTokens, outputTokens, budget })` Muted single line:
  "12.4k / 50k prompt tokens". Hidden entirely when no budget is configured.
- Shared states: `EmptyState({ title, hint, action? })`,
  `ErrorState({ message, onRetry })`, `SkeletonList({ rows })`.

Keyboard shortcut hints use `<kbd>` styling (1px border, radius 4px, muted
background, mono font) wherever shortcuts are advertised.

## 3. Baseline editor interaction spec

### 3.1 Editing solution text

- Plain textarea, auto-growing to a max height then scrolling. No rich text;
  faculty paste plain solutions. A mono toggle exists for code questions.
- Edits update local page state immediately and mark the question dirty (dot
  in the rail, DirtyBar appears). Nothing is sent to the server until Save.
- Save is per question (PUT baseline + criteria in one request). Saving state
  disables the bar buttons and shows "Saving...".
- On successful save: facultyEdited set true, dirty cleared, rail dot updates,
  toast "Baseline saved for Q3" (transient, success tone).

### 3.2 Alternatives list

- "Add alternative" input at the bottom of the list; Enter commits it.
- Each row: text (inline editable on click), up/down arrows, delete (no
  confirm for empty rows; confirm for rows with text).
- Validation: blank entries rejected with "Alternative cannot be empty";
  exact duplicates flagged with a review-tone hint "Duplicate of alternative
  2" but not blocked.

### 3.3 Per-criterion descriptors and marks

- Criterion card fields: label (text input, required), maxMarks (MarksInput,
  required, > 0), descriptors (textarea, required, placeholder: "Full marks
  when... Partial when... Zero when...").
- Add criterion appends an empty card and focuses its label input. Delete
  asks for confirm only if the card has content. Drag handle reorders and
  persists sortOrder on save.
- Live sum bar under the criteria list: "Criteria total: 8 of 10 marks".
  Matches: muted. Mismatch: bad tone plus "Adjust criterion marks so they
  total 10 before approval."

### 3.4 Keyboard shortcuts (baseline editor only)

- `[` / `]` or `j` / `k`: previous / next question in the rail. If dirty, the
  DirtyBar stays visible and the target question loads; unsaved edits are kept
  in local state per question (dirty map keyed by questionId), never dropped.
- `Ctrl/Cmd+S`: save current question (preventDefault; works from anywhere
  in the editor).
- `e`: focus the solution textarea.
- `Esc`: close any open dialog, or blur the focused field.
- Shortcuts are listed in a "Keyboard" popover in the editor header and do
  not fire while a modal dialog is open. All shortcuts are discoverable;
  none are required to complete the workflow.

### 3.5 Dirty and unsaved state

- Dirty tracking is per question: `{ [questionId]: true }`. The rail shows a
  dot per dirty question; the header shows the total count.
- DirtyBar (sticky bottom): "2 questions have unsaved changes", Save all
  (primary), Discard (ghost, confirm). Save all processes questions in rail
  order and reports per-question failures without aborting the rest.
- `beforeunload` guard when any question is dirty: "You have unsaved baseline
  edits."
- In-app navigation (rail clicks, Next Link) does not use beforeunload; the
  dirty state simply travels with the page component, so switching questions
  never loses edits. Leaving the baseline route entirely with dirty state
  triggers a ConfirmDialog ("Leave without saving?").

### 3.6 Validation feedback

- Inline, next to the field: required-field errors ("Solution is required"),
  marks range errors ("Must be between 0 and 10"), duplicate qNo handled in
  the question editor.
- The criteria sum mismatch is a page-level error bar above the DirtyBar and
  blocks Save with the message naming the expected total.
- Server errors on save (e.g. stale version conflict): ErrorState inline at
  the top of the editor with Retry; local edits are preserved.
- Approval checklist (section 4) aggregates the same rules; the editor is
  where faculty fix them.

## 4. Rubric approval flow

### 4.1 What faculty sees before approving

The rubric screen (1.5) presents, in order: version header and history, the
live approval checklist with counts and deep links, the full collapsible
rubric table with faculty-edited badges, the pinning notice, and the Approve
button. Nothing about the approval is hidden behind the dialog; the dialog
only asks for explicit confirmation.

The confirm dialog states: "Approve rubric v2? This freezes the baseline
solutions and criteria. N evaluations currently grade against v1 and will keep
using v1. New evaluations will use v2." Confirm label: "Approve v2".

### 4.2 Version display

- Draft versions: "Rubric v2 (draft)", review tone badge, created date,
  counts of complete vs incomplete questions.
- Approved versions: "Rubric v1, approved 2 Oct 2026, 14:30 IST", good tone
  badge. Approved versions are read-only everywhere; the rubric screen shows
  a "Create v3 draft" button instead of edit controls when viewing an old
  version.
- Version history lists every version with status and approved timestamp.
  Clicking a version shows its frozen rubric table (read-only).

### 4.3 What happens to existing evaluations

They stay pinned. The schema links every Evaluation to one RubricVersion, and
approval never mutates old rows. Concretely:

- Approving v2 sets v2 status to APPROVED with approvedAt; v1 remains
  APPROVED and untouched.
- Evaluations created before approval keep rubricVersionId pointing at v1,
  including their QuestionEvaluations, overrides, and FinalResults.
- New evaluations after approval use v2.
- If faculty edits the baseline after approval, the app creates v3 as a new
  DRAFT (copying v2 content), leaving v1 and v2 frozen. The exam status
  returns to the Baseline step until v3 is approved.
- The rubric screen always shows the pinning notice with live counts:
  "3 evaluations grade against v1, 0 against v2."

### 4.4 Post-approval

Exam status moves to READY. The exam detail stepper shows all steps done.
The dashboard badge changes to "Ready". Phase 3 entry points (student and
capture screens, out of scope here) unlock; this spec does not design them.

## 5. Loading, empty, error, and processing states

### 5.1 Exam detail (`/exams/[id]`)

- Loading: skeleton cards for the header, stepper, and both upload cards.
- Empty (fresh exam): upload cards in idle state with format hints; pipeline
  panel shows "No rubric yet"; entry links disabled with muted helper text
  ("Upload a question paper first").
- Uploading: per-file progress bar inside the card; other UI stays usable.
- Ingest running: IngestProgress with live counts, polled every 2 seconds;
  the "Review questions" link is disabled until extraction completes.
- Ingest failed: card shows the error ("Could not read page 4 of the PDF"),
  keeps the uploaded files listed, offers Retry and "Upload different files".
- Quota exhausted mid-ingest: persistent review-tone banner ("Gemini quota
  exhausted. Ingest paused; resume when quota resets."), Resume button.

### 5.2 Question list (`/exams/[id]/questions`)

- Loading: SkeletonList with 8 rows.
- Empty (no extraction yet): EmptyState "No questions yet. Upload a question
  paper on the exam page to extract them." with a link back.
- Extraction produced zero questions: review-tone EmptyState "The paper was
  read but no questions were found." with "Add manually" and "Re-extract".
- Row save error: inline ErrorState in the expanded editor, edits preserved.
- Delete blocked: message "Q2 has a baseline and 3 criteria. Delete them too?"
  with explicit cascade confirm.

### 5.3 Baseline editor (`/exams/[id]/baseline/[questionId]`)

- Loading: skeleton rail plus skeleton editor panes.
- Baseline not generated for this question: EmptyState in the right pane,
  "No baseline yet", with "Generate baseline" (queues one job) and a note
  that faculty can also write it manually.
- Generation running: right pane shows IngestProgress ("Drafting baseline
  for Q3..."); the rail remains navigable.
- Generation failed: ErrorState with the model error summary and Retry.
  Manual writing stays available; AI failure never blocks faculty.
- Invalid questionId in the URL: ErrorState "Question not found" with a link
  to the question list, not a blank page.

### 5.4 Rubric approval (`/exams/[id]/rubric`)

- Loading: skeleton checklist plus skeleton table.
- Empty (no draft version): EmptyState "No rubric draft yet. Generate
  baselines first." linking to the baseline editor.
- Checklist failing: Approve disabled; each failing item links to the exact
  question to fix. This is the primary "error" state of the screen and it is
  always actionable.
- Approval request fails (server error): ErrorState above the checklist with
  Retry; no partial approval is possible (single transaction server-side).

## 6. What NOT to build

Phase 2 stays inside ingestion, baseline, and approval. Explicitly out:

- Student management, roll lists, CSV import of students (Phase 3).
- Camera capture and page management (Phase 3).
- Any grading, evaluation queue, or marks UI (Phase 4 and 5).
- Analytics, reports, CSV export (Phase 6).
- Rich-text or Markdown editing for solutions and descriptors; plain
  textareas are the spec.
- Autosave-to-server on every keystroke; explicit Save with dirty tracking
  is the spec (fewer writes, clearer audit of facultyEdited).
- PDF annotation or region highlighting on the paper.
- Side-by-side paper viewer next to the baseline editor; the question text
  card is enough context.
- AI chat or "ask about this question" assistant.
- Version-to-version diff view beyond the faculty-edited badges and the
  version history list.
- Multi-user editing, presence, or conflict resolution beyond the stale-write
  error on save.
- Anything requiring RBAC; the MVP is faculty-only by decision.
- Mobile-first layouts; the 1024px collapse keeps tables usable on small
  laptops, nothing more.

## 7. Acceptance checklist for Phase 2 UI

1. Faculty can upload a paper and scheme, watch ingest progress, and retry
   failures without losing uploaded files.
2. Extracted questions are listed, editable, addable, deletable, and
   re-extractable.
3. Every question has an editable baseline: solution text, alternatives,
   criteria with marks and descriptors, with live sum validation.
4. Dirty state is never lost by navigation; keyboard shortcuts work as
   specified.
5. The rubric screen shows a live checklist, the full freezable rubric,
   version history, and the evaluation-pinning notice.
6. Approval is explicit, confirmed, versioned, and moves the exam to READY;
   old evaluations stay pinned to their version.
7. Every screen has loading, empty, error, and processing states as specified
   above; no dead ends or blank pages.
