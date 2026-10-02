"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/workflow";

interface Row {
  studentId: string;
  rollNo: string;
  name: string;
  result: {
    id: string;
    totalAi: number;
    totalFinal: number;
    percentage: number;
    published: boolean;
    finalizedAt: string;
    evaluationId: string;
  } | null;
}

export default function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const [examId, setExamId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [maxTotal, setMaxTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    void params.then((p) => setExamId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!examId) return;
    try {
      const res = await fetch(`/api/exams/${examId}/results`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not load results");
        return;
      }
      setRows(json.rows);
      setMaxTotal(json.maxTotal);
      setError(null);
    } catch {
      setError("Network error. Is the server running?");
    }
  }, [examId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish() {
    if (!examId || !window.confirm("Publish all finalized results?")) return;
    setPublishing(true);
    try {
      const res = await fetch(`/api/exams/${examId}/publish`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not publish");
        return;
      }
      await load();
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setPublishing(false);
    }
  }

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (
        search &&
        !r.rollNo.toLowerCase().includes(search.toLowerCase()) &&
        !r.name.toLowerCase().includes(search.toLowerCase())
      )
        return false;
      if (onlyPending && r.result) return false;
      return true;
    });
  }, [rows, search, onlyPending]);

  const finalized = rows?.filter((r) => r.result).length ?? 0;

  if (error && !rows) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }
  if (!rows || !examId) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <SkeletonList rows={6} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link href={`/exams/${examId}`} className="text-xs text-foreground/60 hover:text-foreground">
            &larr; Exam overview
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Results</h1>
          <p className="mt-1 text-sm text-foreground/60">
            {finalized} of {rows.length} finalized · max {maxTotal} marks
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/exams/${examId}/analytics`}
            className="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm font-medium hover:bg-surface-muted"
          >
            Analytics
          </Link>
          <button
            onClick={publish}
            disabled={publishing || finalized === 0}
            className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {publishing ? "Publishing..." : "Publish results"}
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={() => setError(null)} />
        </div>
      )}

      <div className="mb-4 flex gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search roll no or name"
          className="w-64 rounded-[var(--radius-sm)] border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
          aria-label="Search results"
        />
        <label className="flex items-center gap-2 text-sm text-foreground/70">
          <input
            type="checkbox"
            checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)}
          />
          Only pending
        </label>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-md)] border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-foreground/60">
              <th className="px-4 py-2 font-medium">Roll no</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 text-right font-medium">AI total</th>
              <th className="px-4 py-2 text-right font-medium">Final</th>
              <th className="px-4 py-2 text-right font-medium">%</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.studentId} className="border-b border-border last:border-0">
                <td className="mark px-4 py-2 font-medium">{r.rollNo}</td>
                <td className="px-4 py-2">{r.name}</td>
                <td className="mark px-4 py-2 text-right">{r.result ? r.result.totalAi.toFixed(1) : "-"}</td>
                <td className="mark px-4 py-2 text-right font-semibold">
                  {r.result ? r.result.totalFinal.toFixed(1) : "-"}
                </td>
                <td className="mark px-4 py-2 text-right">
                  {r.result ? r.result.percentage.toFixed(1) : "-"}
                </td>
                <td className="px-4 py-2">
                  {r.result ? (
                    <span className={`rounded-full px-2 py-0.5 text-xs ${r.result.published ? "bg-good-bg text-good" : "bg-info-bg text-info"}`}>
                      {r.result.published ? "published" : "finalized"}
                    </span>
                  ) : (
                    <span className="text-xs text-foreground/50">pending</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {r.result && (
                    <Link
                      href={`/evaluations/${r.result.evaluationId}`}
                      className="text-xs text-accent hover:underline"
                    >
                      Review
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
