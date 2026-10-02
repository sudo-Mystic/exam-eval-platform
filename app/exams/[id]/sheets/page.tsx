"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/workflow";

interface Sheet {
  id: string;
  status: string;
  student: { id: string; rollNo: string; name: string };
  _count: { pages: number };
  evaluations?: Array<{ id: string; status: string }>;
}

export default function SheetsPage({ params }: { params: Promise<{ id: string }> }) {
  const [examId, setExamId] = useState<string | null>(null);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void params.then((p) => setExamId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!examId) return;
    try {
      const res = await fetch(`/api/exams/${examId}/sheets`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not load sheets");
        return;
      }
      // Enrich with latest evaluation per sheet.
      const enriched: Sheet[] = await Promise.all(
        json.sheets.map(async (s: Sheet) => {
          try {
            const r = await fetch(`/api/sheets/${s.id}`);
            const j = await r.json();
            return { ...s, evaluations: j.sheet?.evaluations ?? [] };
          } catch {
            return s;
          }
        })
      );
      setSheets(enriched);
      setError(null);
    } catch {
      setError("Network error. Is the server running?");
    }
  }, [examId]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function evaluate(sheetId: string) {
    setBusy(sheetId);
    setError(null);
    try {
      const res = await fetch(`/api/sheets/${sheetId}/evaluate`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not start evaluation");
        return;
      }
      await load();
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setBusy(null);
    }
  }

  if (error && !sheets) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }
  if (!sheets || !examId) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <SkeletonList rows={5} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <Link href={`/exams/${examId}`} className="text-xs text-foreground/60 hover:text-foreground">
            &larr; Exam overview
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Answer sheets</h1>
          <p className="mt-1 text-sm text-foreground/60">
            Run AI evaluation per sheet, then review question-wise marks.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/exams/${examId}/capture`}
            className="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm font-medium hover:bg-surface-muted"
          >
            Capture
          </Link>
          <Link
            href={`/exams/${examId}/results`}
            className="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm font-medium hover:bg-surface-muted"
          >
            Results
          </Link>
        </div>
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={() => setError(null)} />
        </div>
      )}

      {sheets.length === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong bg-surface p-10 text-center text-sm text-foreground/60">
          No sheets yet. Capture them from the Capture workspace first.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface">
          {sheets.map((s) => {
            const ev = s.evaluations?.[0];
            return (
              <li
                key={s.id}
                className="flex items-center gap-4 border-b border-border px-5 py-3 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    <span className="mark">{s.student.rollNo}</span>
                    <span className="ml-2">{s.student.name}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-foreground/60">
                    {s._count.pages} pages · sheet {s.status.toLowerCase()}
                    {ev ? ` · eval ${ev.status.toLowerCase()}` : " · not evaluated"}
                  </p>
                </div>
                {ev && (
                  <Link
                    href={`/evaluations/${ev.id}`}
                    className="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-muted"
                  >
                    Review
                  </Link>
                )}
                <button
                  onClick={() => evaluate(s.id)}
                  disabled={busy === s.id || s._count.pages === 0}
                  className="rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {busy === s.id ? "Starting..." : ev ? "Resume" : "Evaluate"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
