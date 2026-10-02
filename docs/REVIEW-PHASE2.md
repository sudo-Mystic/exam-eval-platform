# Phase 2 Review: ingestion, baseline, rubric approval

Reviewer: architecture and security pass over Phase 2 plumbing
(`lib/queue.ts`, `lib/storage.ts`, `lib/gemini/adapter.ts`,
`app/api/exams/[id]/paper/route.ts`) and the planned Phase 2 endpoints.
Date: 2026-10-02. Status: review only, no code changed.

Planned endpoints under review (only `POST /api/exams/:id/paper` exists today):
- `POST /api/exams/:id/paper` (exists)
- `GET /api/exams/:id/questions`
- `PATCH /api/exams/:id/questions` (bulk correction)
- `POST /api/exams/:id/baseline/generate`
- `PATCH /api/exams/:id/baseline/:qId`
- `POST /api/exams/:id/rubric/approve`
- `GET /api/exams/:id/rubric`

---

## 1. API contract review

### POST /api/exams/:id/paper (exists)

What is good: magic-byte sniffing (not trusting Content-Type), per-file 50 MB
cap, empty-file rejection, 25-file cap, status gate (409 unless DRAFT/PREPARED),
server-generated filenames (`upload-<i>.<ext>`, never the client filename),
202 Accepted for async work.

Gaps:
- **No idempotency on double submit.** Two rapid POSTs enqueue two
  `ingest-paper` jobs and write the same `upload-<i>.pdf` names, so the second
  upload silently overwrites the first while two jobs race. Add a guard: 409 if
  a queued/running `ingest-paper` job already exists for this exam.
- **No total request size cap.** 25 files x 50 MB = 1.25 GB buffered in memory
  by `req.formData()`. Check `Content-Length` before parsing and cap the total
  (suggested 200 MB), else one upload can OOM the server.
- **Orphaned files on failure.** Files are saved to disk before `enqueue()`.
  If the DB write throws, the files sit on disk with no record. Either delete
  saved files in a catch block or run a periodic orphan sweeper.
- **Re-upload policy is undefined.** The gate allows re-upload while PREPARED,
  but nothing says what happens to already-extracted questions, criteria, and
  baselines. Define one: (a) re-upload replaces the paper and deletes draft
  questions/criteria/baselines in the same transaction, or (b) 409 once
  questions exist unless `?replace=true` is passed.
- **No terminal error state.** If the ingest job fails, the exam sits in
  PREPARED forever with no visible error. Surface job failure in the UI via
  `queueStatus()`, or add an `Exam.paperError` field the worker sets.
- `file.name` is reflected in error messages. JSON encoding makes this safe,
  but keep filenames out of logs to avoid log injection noise.

### GET /api/exams/:id/questions (planned)

- Return the active rubric version envelope in the same response:
  `{ rubricVersion: { id, version, status }, questions: [...] }`, with each
  question carrying its draft criteria and baseline. The baseline editor needs
  all three; separate round trips invite version skew between calls.
- Question counts are small; pagination is unnecessary. Order by `sortOrder`.

### PATCH /api/exams/:id/questions (planned, bulk correction)

- Recommended body: `{ questions: [{ id?, qNo, text, maxMarks, qType, topic,
  sortOrder }] }`. Bulk replace matches the faculty "correct everything, save
  once" UI and is naturally idempotent.
- Validate: `maxMarks` finite and > 0; `qNo` trimmed and non-empty; `qType`
  within the enum; no duplicate `qNo` within the payload (else the DB unique
  constraint on `[examId, qNo]` throws a raw P2002; map it to 409).
- Status gate: allow edits while the rubric is DRAFT. Once APPROVED, question
  edits must not mutate the approved version; either 409 with "create a new
  rubric version first" or auto-fork a new DRAFT version. Pick one and document
  it, because the current schema happily lets you mutate questions under an
  approved version and silently change what "approved" means.

### POST /api/exams/:id/baseline/generate (planned)

- **Must be idempotent.** Recommended: if a DRAFT `RubricVersion` already has
  baselines (or a `generate-baseline` job is queued/running), return 200 with
  the existing version instead of enqueueing again. The worker must upsert
  baselines on `[rubricVersionId, questionId]`, never blind-insert, or the
  second run 500s on the unique constraint.
- **Must not clobber faculty edits.** Generate only fills questions that lack
  a baseline; rows with `facultyEdited = true` are never overwritten.
- Gate: 409/422 unless exam is PREPARED or READY and has at least one question.

### PATCH /api/exams/:id/baseline/:qId (planned)

- Scope check: `:qId` must belong to `:id`, else 404 (never 403/200 on a
  cross-exam id).
- DRAFT-only: 409 if the rubric version is already APPROVED.
- Set `facultyEdited = true` on every faculty edit.
- **Validate criterion sums now, not at grading time:** require
  `sum(criteria.maxMarks) === question.maxMarks`, else 422 naming the question.
  A mismatch here would fail every grading job for that question later.
- Accept `expectedUpdatedAt` for optimistic concurrency; 409 on mismatch
  (see edge cases).

### POST /api/exams/:id/rubric/approve (planned)

- Pre-conditions, all 422 with per-question detail on failure:
  - at least one question exists,
  - every question has at least one criterion,
  - every question has a baseline,
  - criterion sums equal question max marks.
- **Double approve is a no-op:** if the latest version is already APPROVED and
  no draft edits exist since, return 200 with the same version. Never create an
  empty v+1.
- Perform the state change in a transaction: set version status to APPROVED,
  set `approvedAt`, set exam status to READY.
- `approvedBy`: with single-token MVP auth, store the token identity or the
  literal `"faculty"`.
- Define what "active" means: recommended `active = max(version) where status =
  APPROVED`. Document it; the schema permits several APPROVED rows.

### GET /api/exams/:id/rubric (planned)

- Return the active version (latest APPROVED; if none, the latest DRAFT) with
  questions, criteria, and baselines nested. This is what the grading worker
  and the review UI both need; one canonical shape avoids drift.

---

## 2. Data-model review

**Rubric versioning works structurally.** `Evaluation.rubricVersionId` is a plain
FK with no cascade from `RubricVersion`, so approving v2 cannot rewrite
evaluations that point at v1, and a referenced version cannot be deleted
(RESTRICT). `BaselineSolution` and `RubricCriterion` are keyed per
`[rubricVersionId, questionId]`, so each version is self-contained. The one
hole is at the `Question` level: nothing stops a PATCH from editing question
text or maxMarks underneath an APPROVED version (see 1, questions PATCH).
Either gate it in the API or snapshot question text into the rubric version.

**Missing constraints and indexes:**

- The architecture doc promises check constraints ("0 <= marks <= maxMarks"),
  but the Prisma schema has none, and Prisma cannot express them. Add a raw
  SQL migration with: `Question.maxMarks > 0`,
  `RubricCriterion.maxMarks > 0`, `QuestionEvaluation.aiMarks >= 0`,
  `EvaluationOverride.facultyMarks >= 0`. The upper bound needs a join and
  stays an application-level validation at approve/finalize time.
- No "single active version" enforcement. Options: a partial unique index on
  `(examId)` where `status = 'APPROVED'` is wrong (history needs many approved
  rows). Keep history, enforce "active = max approved version" in code, and
  document it in exactly one place (`lib/rubric.ts` when it exists).
- `QuestionEvaluation` lacks `@@index([questionId])`. Class analytics
  ("question-wise score distributions") will query across evaluations per
  question; add the index.
- `Job.payload` is free-form JSON and `queueStatus()` assumes
  `payload.examId`. Type the payload per job type in `lib/queue.ts` and require
  `examId` on every variant, or progress counts silently miss jobs.
- There is no record of paper uploads after ingest. Add a `PaperUpload` model
  (or `paperUploadedAt` / `paperFileCount` on `Exam`) so re-upload UX and
  orphan-file cleanup have something to key on. Today the file list exists
  only inside the job payload, which is transient.
- `ExamStatus` has no error state. A failed ingest leaves PREPARED with no
  explanation. Either add the error to the exam row or make the UI read failed
  jobs; do not leave it implicit.
- Minor: `qNo` uniqueness is exact-match, so `"1"` vs `"1 "` collide at the DB
  with a 500. Trim and normalize in the API and map P2002 to 409.

---

## 3. Security checklist for Phase 2

**File upload abuse**
- [x] Magic-byte sniffing present; client Content-Type ignored.
- [ ] Polyglot PDFs (valid magic, embedded JS/launch actions) still pass the
  sniff. The ingest worker must render with a non-executing parser and never
  honor embedded actions.
- [ ] Decompression bombs: a few-KB PDF can declare thousands of pages.
  Worker must cap page count (suggest 50) and render resolution before
  rasterizing.
- [ ] Total request cap missing (see 1). Add `Content-Length` pre-check.
- [ ] Image decode bombs: cap dimensions when thumbnailing with sharp.
- [ ] No rate limiting on the upload endpoint. Low risk for faculty-only MVP,
  but a token bucket is cheap insurance.

**Path traversal**
- [x] `lib/storage.ts` resolves and verifies the prefix. Good.
- [ ] `examId` from the URL is used in storage paths, but this route looks the
  exam up first, so only real cuid ids reach the path builder. Future routes
  that build paths from params without a DB lookup must validate the param
  format.
- [ ] TOCTOU symlink race between the prefix check and write. Negligible for a
  single-faculty local deployment; noted, not blocking.

**JSON body limits**
- [ ] `POST /api/exams` and all planned JSON routes call `req.json()` with no
  size cap. Enforce a `Content-Length` ceiling (suggest 1 MB for JSON routes)
  and return 413 above it.

**Faculty auth (known gap)**
- [ ] There is currently no authentication on any route. The MVP plan calls
  for a single faculty token; it is not implemented yet. **Do not ship Phase 2
  to the college network without it.** Recommended: `Authorization: Bearer`
  checked in `middleware.ts`, token from env, constant-time compare. Note the
  residual risk: one shared token cannot distinguish faculty members and
  cannot be revoked per person; acceptable for single-college MVP, document it.

**Gemini key handling**
- [x] Key lives in env, server-side only, never sent to the browser.
- [ ] `logUsage()` persists `error` strings from the provider. Confirm the
  Gemini SDK never interpolates the key into error text (it does not today),
  and keep it that way when swapping providers.

**Error message safety**
- [x] Paper route returns generic messages, no stack traces.
- [ ] Planned routes will hit Prisma errors (P2002 unique, P2025 not found).
  Add a shared error mapper (`lib/api-errors.ts`): P2002 -> 409, P2025 ->
  404, everything else -> 500 with a generic message and server-side logging.
  Never serialize raw Prisma errors to the client; they leak table and column
  names.

**Other**
- [x] No SSRF surface: the app never fetches client-supplied URLs.
- [x] Filenames are server-generated; no user input reaches the filesystem.
- [ ] `NextResponse.json({ error })` messages that include `exam.status`
  (e.g. "Cannot upload paper while exam is X") are fine; statuses are not
  sensitive.

---

## 4. Edge-case matrix

| # | Case | What happens today / if built naively | Required behavior |
|---|------|----------------------------------------|-------------------|
| 1 | Double-click paper upload | Two ingest jobs race; second overwrites `upload-0.pdf` | UI disables while 202 in flight; server 409 if an ingest job is queued/running |
| 2 | Re-upload after questions extracted | Allowed; worker behavior undefined, old questions may duplicate or orphan | Defined replace policy: delete draft questions/criteria/baselines in the same transaction as enqueue, or 409 requiring `?replace=true` |
| 3 | `baseline/generate` called twice | Two jobs; second blind-insert 500s on `@@unique([rubricVersionId, questionId])` | Idempotent: return existing draft on re-call; worker upserts |
| 4 | Approve with zero questions | Would approve an empty rubric | 422 "cannot approve a rubric with no questions" |
| 5 | Approve with a question missing criteria or baseline | Ungradeable question ships to the pipeline | 422 listing each offending `qNo` and what is missing |
| 6 | Approve twice in a row | Ambiguous; risk of empty v+1 | Second call returns 200 with the same version, no new version |
| 7 | Criterion max marks do not sum to question max | Every grading job for the question fails validation later | 422 at baseline PATCH and at approve, naming the question |
| 8 | Concurrent faculty edits (two tabs) | Last write wins silently | Accept `expectedUpdatedAt`, 409 on mismatch; or document last-write-wins as the MVP rule |
| 9 | Exam deleted mid-pipeline | `Job` has no FK to exam; orphaned jobs keep running and fail on missing rows | Worker checks exam existence at job start and marks the job done/failed with a clear message |
| 10 | Quota exhausted mid `generate-baseline` | Partial baselines; remaining jobs retry then fail | `withinBudget()` gate before each job; park the rest as retryable with a UI banner |
| 11 | `qNo` variants (`"1"` vs `"1 "`) | P2002 surfaces as 500 | Trim/normalize `qNo`; map P2002 to 409 |
| 12 | Truncated/corrupt PDF passes magic sniff | Worker parser throws | Catch parse errors; mark job failed with a faculty-readable message; keep exam in PREPARED with the error visible |
| 13 | Baseline edited after approval | Schema allows mutating criteria under an APPROVED version | 409 on DRAFT-only routes, or auto-fork a new DRAFT version (copy-on-write); document the chosen rule |
| 14 | `GET /rubric` before any version exists | Would 404 or return null shape | Return 404 with `{"error": "no rubric yet"}` so the UI can show the generate CTA |

---

## 5. Recommended fixes, ordered by severity

**High (ship-blockers for a college deployment)**
1. Add single-token faculty auth in `middleware.ts` and enforce on all
   `app/api/**` routes. Gap: zero auth today.
2. Total upload size cap via `Content-Length` pre-check in
   `app/api/exams/[id]/paper/route.ts` (suggest 200 MB total). One 1.25 GB
   `formData()` parse can OOM the server.
3. Ingest worker safety: page-count cap, render-resolution cap, non-executing
   PDF parser. Touches: `worker/` ingest handler and `lib/ingestion/`
   (to be written).
4. Duplicate ingest guard: 409 in the paper route when a queued/running
   `ingest-paper` job exists for the exam, plus a defined re-upload policy
   (replace vs reject).

**Medium (correctness of the Phase 2 workflow)**
5. Idempotent `POST /api/exams/[id]/baseline/generate`: return the existing
   DRAFT version on re-call; worker upserts baselines; never overwrite
   `facultyEdited = true` rows.
6. Approve-time validation in `POST /api/exams/[id]/rubric/approve`: non-zero
   questions, criteria and baseline present per question, criterion sums equal
   question max. 422 with per-question detail.
7. Criterion-sum validation in `PATCH /api/exams/[id]/baseline/:qId` (422).
8. Shared Prisma error mapper (`lib/api-errors.ts`): P2002 -> 409, P2025 ->
   404, generic 500 otherwise. Apply to the questions and baseline routes.
9. JSON body `Content-Length` ceiling (~1 MB, 413 above) on `app/api/exams/
   route.ts` and every planned JSON route.
10. DRAFT-only enforcement on baseline/question edits after approval, with the
    fork-or-reject rule documented in one place.

**Low (hardening, can follow Phase 2)**
11. Raw-SQL migration adding CHECK constraints (`maxMarks > 0`,
    `aiMarks >= 0`, `facultyMarks >= 0`). Touches: `prisma/migrations/`.
12. `@@index([questionId])` on `QuestionEvaluation` for class analytics.
    Touches: `prisma/schema.prisma`.
13. `PaperUpload` model (or fields on `Exam`) recording uploaded files for
    re-upload UX and orphan cleanup. Touches: schema, paper route.
14. Optimistic concurrency (`expectedUpdatedAt` -> 409) on PATCH routes, or an
    explicit documented last-write-wins rule.
15. Worker defensively handles deleted exams at job start. Touches: `worker/`
    handlers.
16. Type job payloads per job type in `lib/queue.ts` and require `examId` on
    all of them so `queueStatus()` counts are complete.
17. Surface ingest failure on the exam (error field or failed-job UI) instead
    of leaving PREPARED silent.

---

## Verdict

The plumbing is sound: path traversal guard, magic-byte sniffing,
SKIP LOCKED claiming, idempotent-by-design queue, and a provider adapter that
keeps Gemini replaceable. Rubric versioning is modeled correctly for the core
invariant (approvals never rewrite old evaluations).

Do not ship Phase 2 to the college network until items 1 and 2 are fixed
(auth, upload size cap). Items 3 through 10 are correctness issues that will
bite during real faculty use (double submits, re-uploads, bad criterion sums)
and should land with the Phase 2 endpoints, not after.
