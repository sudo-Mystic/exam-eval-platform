"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/workflow";

interface RubricData {
  rubricVersion: { id: string; version: number; status: string; approvedAt: string | null };
  history: Array<{ id: string; version: number; status: string; approvedAt: string | null }>;
  questions: Array<{
    id: string;
    qNo: string;
    text: string;
    maxMarks: number;
    qType: string;
    criteria: Array<{ id: string; label: string; maxMarks: number; descriptors: string }>;
    baseline: { solutionText: string; alternatives: string[]; facultyEdited: boolean } | null;
  }>;
}

export default function RubricPage({ params }: { params: Promise<{ id: string }> }) {
  const [examId, setExamId] = useState<string | null>(null);
  const [data, setData] = useState<RubricData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Array<{ qNo: string; issue: string }> | null>(null);
  const [approving, setApproving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void params.then((p) => setExamId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!examId) return;
    try {
      const res = await fetch(`/api/exams/${examId}/rubric`);
      const json = await res.json();
      if (res.status === 404) {
        setError("No rubric yet. Generate baselines from the questions page first.");
        return;
      }
      if (!res.ok) {
        setError(json.error ?? "Could not load rubric");
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

  async function approve() {
    if (!examId) return;
    setApproving(true);
    setProblems(null);
    try {
      const res = await fetch(`/api/exams/${examId}/rubric/approve`, { method: "POST" });
      const json = await res.json();
      if (res.status === 422) {
        setProblems(json.detail ?? []);
        setError(json.error ?? "Rubric is not ready");
        return;
      }
      if (!res.ok) {
        setError(json.error ?? "Approval failed");
        return;
      }
      setConfirming(false);
      await load();
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setApproving(false);
    }
  }

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

  const approved = data.rubricVersion.status === "APPROVED";
  const checklist = data.questions.map((q) => {
    const sum = q.criteria.reduce((s, c) => s + c.maxMarks, 0);
    return {
      q,
      hasCriteria: q.criteria.length > 0,
      hasBaseline: !!q.baseline,
      sumOk: Math.abs(sum - q.maxMarks) < 0.001,
      marksOk: q.maxMarks > 0,
    };
  });
  const allOk = checklist.every((c) => c.hasCriteria && c.hasBaseline && c.sumOk && c.marksOk);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <Link href={`/exams/${examId}`} className="text-xs text-foreground/60 hover:text-foreground">
          &larr; Exam overview
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Rubric v{data.rubricVersion.version}
        </h1>
        <p className="mt-1 text-sm text-foreground/60">
          {approved
            ? `Approved${data.rubricVersion.approvedAt ? ` on ${new Date(data.rubricVersion.approvedAt).toLocaleString()}` : ""}. This version is frozen; grading uses it.`
            : "Review everything below, then approve to freeze this rubric for grading."}
        </p>
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
          {problems && problems.length > 0 && (
            <ul className="mt-2 rounded-[var(--radius-md)] border border-bad/30 bg-bad-bg p-4 text-sm text-bad">
              {problems.map((p, i) => (
                <li key={i}>
                  <span className="mark font-semibold">{p.qNo}</span>: {p.issue}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="mb-6 rounded-[var(--radius-md)] border border-border bg-surface p-5">
        <h2 className="text-sm font-medium">Approval checklist</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {checklist.map(({ q, hasCriteria, hasBaseline, sumOk, marksOk }) => {
            const ok = hasCriteria && hasBaseline && sumOk && marksOk;
            return (
              <li key={q.id} className="flex items-center gap-3">
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                    ok ? "bg-good-bg text-good" : "bg-review-bg text-review"
                  }`}
                  aria-label={ok ? "ready" : "needs attention"}
                >
                  {ok ? "✓" : "!"}
                </span>
                <span className="mark font-medium">{q.qNo}</span>
                <span className="text-foreground/60">
                  {!marksOk && "marks missing; "}
                  {!hasCriteria && "no criteria; "}
                  {!hasBaseline && "no baseline; "}
                  {hasCriteria && !sumOk && "criterion sum mismatch; "}
                  {ok && "ready"}
                </span>
                <Link
                  href={`/exams/${examId}/baseline`}
                  className="ml-auto text-xs text-accent hover:underline"
                >
                  Edit
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {!approved && (
        <div className="mb-6 rounded-[var(--radius-md)] border border-info/30 bg-info-bg p-4 text-sm text-info">
          <p className="font-medium">Freezing notice</p>
          <p className="mt-1 text-info/80">
            Approving freezes this rubric version. Every later evaluation is pinned to it;
            post-approval edits create a new draft version instead of changing this one.
          </p>
        </div>
      )}

      {!approved && (
        <button
          onClick={() => setConfirming(true)}
          disabled={!allOk}
          className="rounded-[var(--radius-sm)] bg-accent px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          title={allOk ? "Approve this rubric" : "Fix checklist items first"}
        >
          Approve rubric v{data.rubricVersion.version}
        </button>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Confirm approval">
          <div className="w-full max-w-md rounded-[var(--radius-md)] bg-surface p-6">
            <h2 className="text-lg font-semibold">Approve this rubric?</h2>
            <p className="mt-2 text-sm text-foreground/70">
              Version {data.rubricVersion.version} will be frozen and used for all grading.
              This cannot be undone; further edits create a new version.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={approve}
                disabled={approving}
                className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {approving ? "Approving..." : "Yes, approve"}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium">Full rubric</h2>
        <div className="space-y-4">
          {data.questions.map((q) => (
            <details
              key={q.id}
              className="rounded-[var(--radius-md)] border border-border bg-surface"
            >
              <summary className="cursor-pointer px-5 py-3 text-sm font-medium">
                <span className="mark">{q.qNo}</span>
                <span className="ml-2 font-normal text-foreground/60">
                  {q.maxMarks} marks · {q.criteria.length} criteria
                  {q.baseline?.facultyEdited && " · edited by faculty"}
                </span>
              </summary>
              <div className="border-t border-border px-5 py-4">
                <p className="text-sm">{q.text}</p>
                {q.baseline && (
                  <div className="mt-3 rounded-[var(--radius-sm)] bg-surface-muted p-3 text-sm">
                    <p className="text-xs font-medium text-foreground/60">Baseline solution</p>
                    <p className="mt-1 whitespace-pre-wrap">{q.baseline.solutionText}</p>
                    {q.baseline.alternatives.length > 0 && (
                      <>
                        <p className="mt-2 text-xs font-medium text-foreground/60">Alternatives</p>
                        <ul className="mt-1 list-disc pl-5">
                          {q.baseline.alternatives.map((a, i) => (
                            <li key={i}>{a}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
                <ul className="mt-3 space-y-2">
                  {q.criteria.map((c) => (
                    <li key={c.id} className="text-sm">
                      <p>
                        <span className="font-medium">{c.label}</span>{" "}
                        <span className="mark text-foreground/60">{c.maxMarks} marks</span>
                      </p>
                      <p className="mt-0.5 text-foreground/70">{c.descriptors}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ))}
        </div>
      </section>

      {data.history.length > 1 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium">Version history</h2>
          <ul className="text-sm text-foreground/60">
            {data.history.map((h) => (
              <li key={h.id}>
                v{h.version} · {h.status}
                {h.approvedAt ? ` · approved ${new Date(h.approvedAt).toLocaleDateString()}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
