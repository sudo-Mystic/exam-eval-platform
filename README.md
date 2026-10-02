# AI Examination Evaluation Platform

Faculty-facing web app for AI-assisted grading of handwritten answer sheets.
Built for a single college: create an exam, upload the paper and marking
scheme, let AI draft the baseline and rubric, capture answer sheets with a
camera, grade question-wise with evidence, review and override, then publish
reports and class analytics.

## Status

MVP complete: all 7 phases built (foundation, ingestion, capture, grading,
review, reports, hardening). Live AI stages need `GEMINI_API_KEY` and
Postgres; everything else runs without them.

## Stack

- Next.js 16 (App Router) + TypeScript: modular monolith (UI + API)
- Prisma 6 + PostgreSQL, Postgres-backed job queue (no Redis)
- Tailwind CSS v4, design tokens in `app/globals.css`
- Gemini API via a replaceable provider adapter (`lib/gemini/`)
- Sharp for image prep, poppler (`pdftoppm`) for PDF rasterization
- Vitest for tests

## Quick start

```bash
cp .env.example .env
# set DATABASE_URL, GEMINI_API_KEY, FACULTY_TOKEN

docker compose up -d db        # local Postgres
npx prisma migrate dev         # create tables
npm run dev                    # web app on :3000
npm run worker                 # background job worker (separate terminal)
```

Open http://localhost:3000, create an exam, and follow the workflow stepper.

## Workflow

1. **Exam setup**: create exam, upload question paper (PDF/images) and marking scheme.
2. **Questions**: AI extracts questions; faculty corrects in the table editor.
3. **Baseline**: AI drafts per-question solutions and criteria; faculty edits, then approves the rubric (frozen version).
4. **Capture**: add students, capture multi-page sheets with the camera; QC flags blur/duplicates; pages keep order.
5. **Evaluate**: per-sheet AI grading with per-criterion marks, justification, evidence refs, confidence and flags. Resumable.
6. **Review**: side-by-side sheet and marks; faculty overrides stored separately from AI suggestions; finalize per sheet.
7. **Results**: table with filters, publish, per-student printable reports, class analytics, CSV export.

## Configuration

See `.env.example`. Highlights:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `GEMINI_API_KEY` | Server-side only, never reaches the browser |
| `GEMINI_MODEL_LIGHT` / `GEMINI_MODEL_CAPABLE` | Model routing; change without code edits |
| `EXAM_TOKEN_BUDGET_PROMPT` / `EXAM_TOKEN_BUDGET_OUTPUT` | Per-exam caps, 0 = unlimited |
| `FACULTY_TOKEN` | Bearer token for `/api/**`; unset = dev mode (open) |
| `STORAGE_BACKEND` / `STORAGE_DIR` | Local disk (`local`) |

Set `FACULTY_TOKEN` before exposing this to the college network.

## Project layout

```
app/                 Routes: dashboard, exams/[id]/*, evaluations/[id], API
components/          Design-system and feature components
lib/
  config.ts          All tunable settings (env-driven)
  db.ts              Prisma singleton
  gemini/            Provider interface, REST client, prompts, model routing
  ingestion/         PDF rasterize, image normalize/thumbnail
  capture/           QC checks (blur, duplicates)
  queue.ts           Job queue (SKIP LOCKED claiming)
  rubric.ts          Active-version rule, approve-time validation
  storage.ts         Storage interface (local disk)
prisma/              Schema + migrations
worker/              Job handlers (ingest, baseline, match, grade) + runner
tests/               Vitest: 24 unit + 8 DB-gated integration
docs/                Architecture, pipeline, runbook, Phase 2 specs
```

## Docs

- `docs/ARCHITECTURE.md`: system design, data flow, failure handling, cost strategy
- `docs/PIPELINE.md`: the six AI stages and reliability notes per question type
- `docs/PIPELINE-SCHEMAS.md`: JSON schemas and prompt templates
- `docs/RUNBOOK.md`: setup, worker, deployment
- `docs/REVIEW-PHASE2.md`: security review and edge-case matrix

## Deployment

```bash
docker build -t exam-eval .
docker run -p 3000:3000 --env-file .env -v exam-storage:/app/storage exam-eval
# run the worker as a second container with: npx tsx worker/run.ts
```

`docker-compose.yml` provides Postgres for local dev. Back up `storage/` alongside the database.

## Testing

```bash
npm test              # unit tests (always) + integration (needs DATABASE_URL)
npx tsc --noEmit && npm run build   # type + build check
```

## License

MIT
