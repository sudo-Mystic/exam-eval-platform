import { db } from "@/lib/db";
import { ExamCreator } from "./exam-creator";
import type { Exam } from "@prisma/client";

export const dynamic = "force-dynamic";

type ExamWithCounts = Exam & {
  _count: { questions: number; answerSheets: number };
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PREPARED: "Prepared",
  READY: "Ready",
  CAPTURING: "Capturing",
  GRADING: "Grading",
  REVIEW: "In review",
  PUBLISHED: "Published",
};

export default async function Dashboard() {
  const exams = await db.exam.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { questions: true, answerSheets: true } } },
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Exams</h1>
          <p className="mt-1 text-sm text-foreground/60">
            Create an exam, then upload its question paper to begin.
          </p>
        </div>
      </header>

      <section className="mb-10 rounded-[var(--radius-md)] border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-medium">New exam</h2>
        <ExamCreator />
      </section>

      <section>
        {exams.length === 0 ? (
          <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong bg-surface p-10 text-center">
            <p className="text-sm font-medium">No exams yet</p>
            <p className="mt-1 text-sm text-foreground/60">
              Create your first exam above to start the evaluation workflow.
            </p>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface">
            {(exams as ExamWithCounts[]).map((exam) => (
              <li
                key={exam.id}
                className="flex items-center justify-between gap-4 border-b border-border px-5 py-4 last:border-0"
              >
                <div>
                  <p className="text-sm font-medium">{exam.title}</p>
                  <p className="mt-0.5 text-xs text-foreground/60">
                    {exam.subject}
                    {exam.term ? ` · ${exam.term}` : ""} ·{" "}
                    {exam._count.questions} questions ·{" "}
                    {exam._count.answerSheets} sheets
                  </p>
                </div>
                <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
                  {STATUS_LABEL[exam.status] ?? exam.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
