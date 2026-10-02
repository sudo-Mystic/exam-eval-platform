# Runbook

## Prerequisites

- Node 24+
- Postgres 16 (or `docker compose up -d db`)
- poppler-utils (`pdftoppm`, `pdfinfo`) for paper ingestion
- A Gemini API key (server-side only)

## First-time setup

```bash
cp .env.example .env
# edit .env: DATABASE_URL, GEMINI_API_KEY, FACULTY_TOKEN

docker compose up -d db
npx prisma migrate dev --name init
npm run dev          # terminal 1: web app
npm run worker       # terminal 2: background job worker
```

Open http://localhost:3000. Create an exam from the dashboard.

## The worker

AI stages run in `worker/run.ts`, polling the Postgres job queue:

```bash
npm run worker
```

- One worker per machine is enough for a college; run more for throughput.
- Jobs are idempotent: re-running never duplicates completed work.
- `BudgetExhausted` and rate limits park jobs as `retryable`; semantic
  failures mark them `failed` with a faculty-readable message.
- Watch progress on the exam hub and sheets pages (2-5s polling).

## Environment variables

See `.env.example`. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `GEMINI_API_KEY` | Gemini API key, never exposed to the browser |
| `GEMINI_MODEL_LIGHT` | Model for extraction, matching, MCQs |
| `GEMINI_MODEL_CAPABLE` | Model for baseline drafting and hard grading |
| `EXAM_TOKEN_BUDGET_PROMPT` / `EXAM_TOKEN_BUDGET_OUTPUT` | Per-exam token caps, 0 = unlimited |
| `FACULTY_TOKEN` | Bearer token for `/api/**`; unset = dev mode |
| `STORAGE_BACKEND` / `STORAGE_DIR` | `local` disk storage (free) |
| `WORKER_CONCURRENCY` / `WORKER_POLL_MS` | Worker tuning |

## Useful commands

```bash
npx prisma studio        # inspect the database
npx prisma migrate dev   # apply schema changes in dev
npm test                 # vitest (integration skips without DATABASE_URL)
npm run build            # production build check
```

## Storage layout

Answer-sheet images live under `storage/uploads/sheets/<examId>/<sheetId>/`,
paper pages under `storage/uploads/papers/<examId>/`, thumbnails under
`storage/thumbs/`. All gitignored. Back up `storage/` alongside the database.

## Deployment

Single Docker image (app + migrations). Run the worker as a second container.

```bash
docker build -t exam-eval .
docker run -d --name exam-eval -p 3000:3000 --env-file .env \
  -v exam-storage:/app/storage exam-eval
docker run -d --name exam-eval-worker --env-file .env \
  -v exam-storage:/app/storage exam-eval npx tsx worker/run.ts
```

Before college-network deployment:
1. Set `FACULTY_TOKEN` (auth is open without it).
2. Put the app behind HTTPS (reverse proxy).
3. Back up Postgres and `storage/` on a schedule.
4. Set token budgets per exam if free-tier quotas matter.

## Applying CHECK constraints (optional hardening)

Prisma cannot express CHECK constraints; apply them once with psql:

```sql
ALTER TABLE "Question" ADD CONSTRAINT q_maxmarks_pos CHECK ("maxMarks" > 0);
ALTER TABLE "RubricCriterion" ADD CONSTRAINT rc_maxmarks_pos CHECK ("maxMarks" > 0);
ALTER TABLE "QuestionEvaluation" ADD CONSTRAINT qe_aimarks_nonneg CHECK ("aiMarks" >= 0);
ALTER TABLE "EvaluationOverride" ADD CONSTRAINT eo_marks_nonneg CHECK ("facultyMarks" >= 0);
```

Note: `Question.maxMarks` uses 0 as a "marks missing" sentinel until faculty
fills it in, so apply the first constraint only if you change that convention.

## Troubleshooting

- **Jobs stuck in queued**: is the worker running? Check `Job` rows in Studio.
- **429 / quota errors**: jobs park as `retryable`; raise budgets or wait for quota reset, the pipeline resumes.
- **Upload rejected**: 200 MB total cap, 50 MB per paper file, 20 MB per page photo.
- **Blurry captures flagged**: retake the page; flags never auto-delete anything.
