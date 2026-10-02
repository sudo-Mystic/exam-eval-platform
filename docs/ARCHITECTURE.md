# Architecture

Modular monolith. One repo, one deployable, clear module boundaries.

## Stack

- Next.js 14 App Router + TypeScript (web UI + API routes)
- Prisma + PostgreSQL (schema in `prisma/schema.prisma`)
- Tailwind CSS + shadcn/ui (design system)
- Gemini API via a provider adapter (`lib/gemini/`) - model names and budgets in config, never hardcoded
- Sharp for image prep (rotation, QC thumbnails)
- Local disk storage for answer-sheet images (`storage/`, free). S3-compatible backend later behind the same interface.
- Postgres-backed job queue (no Redis in MVP) - resumable, idempotent grading jobs

## Module boundaries

```
app/                    Next.js routes (faculty UI)
components/             Design system + feature components
lib/
  db/                   Prisma client, queries
  config.ts             Model names, token budgets, QC thresholds (env-driven)
  ingestion/            PDF to images, question extraction
  capture/             Image QC (blur, glare, skew, duplicate detection), page ordering
  pipeline/            Job runner, deterministic validators, evidence refs
  gemini/              Provider interface, model router, retry, usage logger
  analytics/           Aggregations, CSV export
  storage/             Local-disk backend behind a storage interface
prisma/                 Schema + migrations + seeds
worker/                 Queue poller + job handlers
storage/                Gitignored local image store
tests/                  Unit + integration
docs/                   This file, runbook, pipeline spec
```

## Data flow: grading one answer

1. `POST /api/sheets/:id/evaluate` creates one `Job` row per question (idempotent on evaluationId + questionId).
2. Worker picks up jobs, fetches only that question's rubric criteria + approved baseline + relevant page crops.
3. Gemini adapter calls the configured model with a compact, schema-strict prompt.
4. Deterministic validator checks: marks within [0, maxMarks], criterion sums match, required fields present. Malformed output retries once, then parks as `NEEDS_REVIEW`.
5. `QuestionEvaluation` stored with evidence refs, confidence, flags. UI polls `GET /api/evaluations/:id/status`.
6. Faculty overrides create `EvaluationOverride` rows; AI marks preserved separately.
7. `POST /api/exams/:id/finalize` validates totals and writes `FinalResult` linked to the rubric version + evaluation.

## Key invariants

- Every evaluation links to exactly one approved `RubricVersion`. New approvals never rewrite old evaluations.
- Check constraints: 0 <= marks <= maxMarks per question and per criterion.
- Answer-sheet pages are never auto-deleted or silently reassigned. QC flags them; faculty decides.
- Re-running evaluation never duplicates completed question evals.
- API keys live in env vars, server-side only. Nothing secret reaches the browser.

## Failure handling

- Schema-invalid model output: 1 retry, then `NEEDS_REVIEW` with the raw output attached.
- 429 / 5xx / timeout: bounded retries with backoff, then job parked as `retryable`. Banner in UI, resume continues from first incomplete job.
- Quota exhaustion: pipeline pauses, usage log shows spend, resume later.
- Unreadable or ambiguous handwriting: flagged, never silently zeroed.

## Cost strategy

- Two-tier model routing: light model for extraction, question matching, MCQs; capable model only for baseline drafting and hard descriptive/code/diagram grading.
- Extract once, reuse: questions, rubric, baseline cached per exam. Grading prompts carry only the single question context.
- Image discipline: downscale crops to minimum readable size, send only relevant pages per question.
- Every call logged in `ApiUsage` (purpose, model, tokens, status). Per-exam spend visible on dashboard. Configurable token budgets pause the pipeline at cap.
