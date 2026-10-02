"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/workflow";

interface Analytics {
  exam: { id: string; title: string; subject: string };
  finalizedCount: number;
  maxTotal: number;
  questions: Array<{
    questionId: string;
    qNo: string;
    maxMarks: number;
    topic: string | null;
    n: number;
    avg: number;
    avgPct: number;
    min: number;
    max: number;
    buckets: number[];
    overridden: number;
    avgAiDelta: number;
    flagged: number;
    lowConf: number;
  }>;
  topics: Array<{ topic: string; avgPct: number; n: number }>;
  overall: { avg: number; avgPct: number; min: number; max: number } | null;
}

function Bar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 text-foreground/60">{label}</span>
      <div className="h-4 flex-1 rounded-sm bg-surface-muted">
        <div className="h-4 rounded-sm bg-accent" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="mark w-12 shrink-0 text-right">{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const [examId, setExamId] = useState<string | null>(null);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void params.then((p) => setExamId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!examId) return;
    try {
      const res = await fetch(`/api/exams/${examId}/analytics`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not load analytics");
        return;
      }
      setData(json);
      setError(null);
    } catch {
      setError("Network error. Is the server running?");
    }
  }, [examId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }
  if (!data || !examId) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <SkeletonList rows={5} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link href={`/exams/${examId}/results`} className="text-xs text-foreground/60 hover:text-foreground">
            &larr; Results
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Class analytics</h1>
          <p className="mt-1 text-sm text-foreground/60">
            {data.exam.title} · {data.finalizedCount} finalized sheets
          </p>
        </div>
        <a
          href={`/api/exams/${examId}/export.csv`}
          className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          Download CSV
        </a>
      </header>

      {data.finalizedCount === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong bg-surface p-10 text-center text-sm text-foreground/60">
          No finalized results yet. Analytics appear after sheets are finalized.
        </div>
      ) : (
        <>
          {data.overall && (
            <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: "Class average", value: `${data.overall.avg} / ${data.maxTotal}` },
                { label: "Average %", value: `${data.overall.avgPct}%` },
                { label: "Highest", value: `${data.overall.max}` },
                { label: "Lowest", value: `${data.overall.min}` },
              ].map((s) => (
                <div key={s.label} className="rounded-[var(--radius-md)] border border-border bg-surface p-4">
                  <p className="text-xs text-foreground/60">{s.label}</p>
                  <p className="mark mt-1 text-xl font-semibold">{s.value}</p>
                </div>
              ))}
            </section>
          )}

          {data.topics.length > 0 && (
            <section className="mb-6 rounded-[var(--radius-md)] border border-border bg-surface p-5">
              <h2 className="mb-3 text-sm font-medium">Topic performance</h2>
              <div className="space-y-2">
                {data.topics.map((t) => (
                  <Bar key={t.topic} pct={t.avgPct} label={t.topic} />
                ))}
              </div>
            </section>
          )}

          <section className="rounded-[var(--radius-md)] border border-border bg-surface p-5">
            <h2 className="mb-3 text-sm font-medium">Question-wise performance</h2>
            <div className="space-y-5">
              {data.questions.map((q) => (
                <div key={q.questionId}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <p>
                      <span className="mark font-semibold">{q.qNo}</span>
                      <span className="ml-2 text-foreground/60">
                        avg {q.avg}/{q.maxMarks} ({q.avgPct}%)
                      </span>
                    </p>
                    <p className="text-xs text-foreground/50">
                      {q.n} sheets
                      {q.flagged > 0 && <span className="ml-2 text-review">{q.flagged} flagged</span>}
                      {q.overridden > 0 && <span className="ml-2">{q.overridden} overridden</span>}
                      {q.avgAiDelta > 0 && (
                        <span className="ml-2" title="Average |faculty - AI| marks">
                          AI delta {q.avgAiDelta}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex h-6 overflow-hidden rounded-sm bg-surface-muted">
                    {q.buckets.map((b, i) => {
                      const total = q.buckets.reduce((s, x) => s + x, 0) || 1;
                      const shades = ["#fecaca", "#fed7aa", "#fde68a", "#bbf7d0", "#86efac"];
                      return (
                        <div
                          key={i}
                          className="h-6"
                          style={{ width: `${(b / total) * 100}%`, background: shades[i] }}
                          title={`${i * 20}-${i * 20 + 20}%: ${b} sheets`}
                        />
                      );
                    })}
                  </div>
                  <p className="mt-0.5 text-[11px] text-foreground/50">
                    Score bands 0-20 / 20-40 / 40-60 / 60-80 / 80-100%
                  </p>
                </div>
              ))}
            </div>
          </section>

          <p className="mt-4 text-xs text-foreground/50">
            Bands and averages come from finalized faculty-reviewed marks. AI-vs-faculty
            delta shows where the model needed the most correction.
          </p>
        </>
      )}
    </main>
  );
}
