# Runbook

## Prerequisites

- Node 20+
- Postgres 16 (or use Docker Compose)
- A Gemini API key (server-side only)

## First-time setup

```bash
cp .env.example .env
# edit .env: DATABASE_URL, GEMINI_API_KEY

# start Postgres
docker compose up -d db

# create tables
npx prisma migrate dev --name init

# run the app
npm run dev
```

Open http://localhost:3000. Create an exam from the dashboard.

## Environment variables

See `.env.example`. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `GEMINI_API_KEY` | Gemini API key, never exposed to the browser |
| `GEMINI_MODEL_LIGHT` | Model for extraction, matching, MCQs |
| `GEMINI_MODEL_CAPABLE` | Model for baseline drafting and hard grading |
| `EXAM_TOKEN_BUDGET_PROMPT` / `EXAM_TOKEN_BUDGET_OUTPUT` | Per-exam token caps, 0 = unlimited |
| `STORAGE_BACKEND` / `STORAGE_DIR` | `local` disk storage (free) |

## Useful commands

```bash
npx prisma studio        # inspect the database
npx prisma migrate dev   # apply schema changes in dev
npm run build            # production build check
```

## Storage layout

Answer-sheet images live under `storage/uploads/<examId>/<sheetId>/`,
thumbnails under `storage/thumbs/`. Both are gitignored. Back up the
`storage/` directory alongside the database.
