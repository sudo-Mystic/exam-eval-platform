# AI Examination Evaluation Platform

Faculty-facing web app for AI-assisted grading of handwritten answer sheets.

**Status:** Phase 1 - Project foundation (in progress)

## What this does

1. Faculty creates an exam, uploads question paper + marking scheme
2. AI drafts baseline solution + rubric, faculty reviews and approves
3. Faculty captures multi-page answer sheets via camera
4. AI grades question-wise with evidence, confidence flags, and justifications
5. Faculty reviews, overrides, finalizes results
6. Student reports + class analytics, CSV export

## Stack

- Next.js 14 (App Router) + TypeScript - modular monolith
- Prisma + PostgreSQL
- Tailwind CSS + shadcn/ui
- Gemini API (configurable models, free-tier first)
- Sharp for image prep, Docker Compose for deploy

## Quick start

See `.env.example` for config. Full setup docs in `docs/`.

```bash
cp .env.example .env
# fill in DATABASE_URL, GEMINI_API_KEY
docker compose up -d
npx prisma migrate dev
npm run dev
```

## Project structure

See `docs/ARCHITECTURE.md` for the full plan.

## License

MIT
