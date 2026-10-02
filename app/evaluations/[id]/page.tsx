"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/workflow";

interface QEval {
  id: string;
  questionId: string;
  qNo: string;
  text: string;
  maxMarks: number;
  qType: string;
  aiMarks: number;
  aiJustification: string;
  criterionMarks: Array<{ criterionId: string; marks: number; note: string }>;
  evidenceRefs: string[];
  confidence: string;
  flags: string[];
  model: string | null;
  facultyMarks: number | null;
  facultyComment: string | null;
  finalMarks: number;
}
interface EvalData {
  evaluation: {
    id: string;
    status: string;
    examId: string;
    sheetId: string;
    student: { rollNo: string; name: string };
    pages: Array<{ id: string; pageNo: number }>;
  };
  questions: QEval[];
  totals: { totalAi: number; totalFinal: number; maxTotal: number };
}
interface Status {
  status: string;
  questions: number;
  matched: number;
  graded: number;
  flagged: number;
  failedJobs: Array<{ type: string; error: string | null }>;
}

const CONF_STYLE: Record<string, string> = {
  HIGH: "bg-good-bg text-good",
  MED: "bg-info-bg text-info",
  LOW: "bg-review-bg text-review",
};

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const [evalId, setEvalId] = useState<string | null>(null);
  const [data, setData] = useState<EvalData | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [editMarks, setEditMarks] = useState("");
  const [editComment, setEditComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  useEffect(() => {
    void params.then((p) => setEvalId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!evalId) return;
    try {
      const [r1, r2] = await Promise.all([
        fetch(`/api/evaluations/${evalId}`),
        fetch(`/api/evaluations/${evalId}/status`),
      ]);
      const j1 = await r1.json();
      const j2 = await r2.json();
      if (!r1.ok) {
        setError(j1.error ?? "Could not load evaluation");
        return;
      }
      setData(j1);
      if (r2.ok) setStatus(j2);
      setError(null);
    } catch {
      setError("Network error. Is the server running?");
    }
  }, [evalId]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const active = useMemo(
    () => (data && data.questions.length > 0 ? data.questions[Math.min(activeIdx, data.questions.length - 1)] : null),
    [data, activeIdx]
  );

  useEffect(() => {
    if (active) {
      setEditMarks(active.facultyMarks !== null ? String(active.facultyMarks) : "");
      setEditComment(active.facultyComment ?? "");
    }
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: j/k move between questions.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!data) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "j") setActiveIdx((i) => Math.min(i + 1, data.questions.length - 1));
      if (e.key === "k") setActiveIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [data]);

  async function saveOverride(clear = false) {
    if (!active || !evalId) return;
    setSaving(true);
    try {
      const body = clear
        ? {}
        : { facultyMarks: parseFloat(editMarks), comment: editComment || undefined };
      if (!clear && (!Number.isFinite(body.facultyMarks) || (body.facultyMarks as number) < 0)) {
        setError("Marks must be a non-negative number");
        setSaving(false);
        return;
      }
      const res = await fetch(`/api/evaluations/${evalId}/questions/${active.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not save override");
        return;
      }
      await load();
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setSaving(false);
    }
  }

  async function finalize() {
    if (!evalId || !window.confirm("Finalize this sheet? Marks lock after this.")) return;
    setFinalizing(true);
    try {
      const res = await fetch(`/api/evaluations/${evalId}/finalize`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not finalize");
        return;
      }
      await load();
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setFinalizing(false);
    }
  }

  if (error && !data) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }
  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10">
        <SkeletonList rows={6} />
      </main>
    );
  }

  const running = status && !["DONE", "NEEDS_REVIEW"].includes(status.status);

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link href={`/exams/${data.evaluation.examId}/sheets`} className="text-xs text-foreground/60 hover:text-foreground">
            &larr; All sheets
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            <span className="mark">{data.evaluation.student.rollNo}</span>
            <span className="ml-2">{data.evaluation.student.name}</span>
          </h1>
          <p className="mt-1 text-sm text-foreground/60">
            {running
              ? `Grading in progress: ${status?.graded ?? 0}/${status?.questions ?? 0} questions`
              : `AI total ${data.totals.totalAi} · Final ${data.totals.totalFinal} / ${data.totals.maxTotal}`}
            {status && status.flagged > 0 && (
              <span className="ml-2 text-review">{status.flagged} flagged for review</span>
            )}
          </p>
        </div>
        {status?.status === "DONE" && (
          <button
            onClick={finalize}
            disabled={finalizing}
            className="rounded-[var(--radius-sm)] bg-accent px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {finalizing ? "Finalizing..." : "Finalize sheet"}
          </button>
        )}
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={() => setError(null)} />
        </div>
      )}
      {status?.failedJobs.map((j, i) => (
        <div key={i} className="mb-4">
          <ErrorState message={`${j.type} failed: ${j.error ?? "unknown error"}`} />
        </div>
      ))}

      {data.questions.length === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong bg-surface p-10 text-center text-sm text-foreground/60">
          {running ? "Waiting for the first graded question..." : "No questions graded yet."}
        </div>
      ) : (
        <div className="flex gap-6">
          {/* Answer sheet pages */}
          <section className="w-[42%] shrink-0" aria-label="Answer sheet">
            <div className="max-h-[75vh] space-y-4 overflow-y-auto rounded-[var(--radius-md)] border border-border bg-surface p-3">
              {data.evaluation.pages.map((p) => (
                <figure key={p.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- dynamic /api image */}
                  <img
                    src={`/api/pages/${p.id}`}
                    alt={`Answer page ${p.pageNo}`}
                    className="w-full rounded-[var(--radius-sm)] border border-border"
                    loading="lazy"
                  />
                  <figcaption className="mark mt-1 text-xs text-foreground/50">
                    Page {p.pageNo}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>

          {/* Question evals */}
          <section className="min-w-0 flex-1" aria-label="Question evaluations">
            <div className="mb-3 flex flex-wrap gap-1">
              {data.questions.map((q, i) => (
                <button
                  key={q.id}
                  onClick={() => setActiveIdx(i)}
                  className={[
                    "mark rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-semibold",
                    i === activeIdx
                      ? "bg-accent text-white"
                      : q.flags.length > 0
                        ? "bg-review-bg text-review"
                        : "bg-surface-muted text-foreground/70 hover:bg-border",
                  ].join(" ")}
                  title={`${q.qNo}: AI ${q.aiMarks}, final ${q.finalMarks}`}
                >
                  {q.qNo}
                </button>
              ))}
            </div>

            {active && (
              <article className="rounded-[var(--radius-md)] border border-border bg-surface p-5">
                <header className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">
                      <span className="mark">{active.qNo}</span>
                      <span className="ml-2 font-normal text-foreground/60">
                        {active.maxMarks} marks · {active.qType}
                      </span>
                    </h2>
                    <p className="mt-1 text-sm text-foreground/70">{active.text}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${CONF_STYLE[active.confidence] ?? ""}`}>
                    {active.confidence.toLowerCase()} confidence
                  </span>
                </header>

                {active.flags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {active.flags.map((f) => (
                      <span key={f} className="rounded-full bg-review-bg px-2 py-0.5 text-xs font-medium text-review">
                        {f}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-[var(--radius-sm)] bg-surface-muted p-3">
                    <p className="text-xs text-foreground/60">AI marks</p>
                    <p className="mark mt-1 text-xl font-semibold">{active.aiMarks}</p>
                  </div>
                  <div className="rounded-[var(--radius-sm)] bg-accent-soft p-3">
                    <p className="text-xs text-foreground/60">Final marks</p>
                    <p className="mark mt-1 text-xl font-semibold text-accent">{active.finalMarks}</p>
                  </div>
                  <div className="rounded-[var(--radius-sm)] bg-surface-muted p-3">
                    <p className="text-xs text-foreground/60">Max</p>
                    <p className="mark mt-1 text-xl font-semibold">{active.maxMarks}</p>
                  </div>
                </div>

                {active.criterionMarks.length > 0 && (
                  <div className="mt-4">
                    <h3 className="mb-1 text-xs font-medium text-foreground/60">Per-criterion</h3>
                    <ul className="space-y-1 text-sm">
                      {(active.criterionMarks as Array<{ criterionId: string; marks: number; note: string }>).map((c, i) => (
                        <li key={i} className="flex justify-between gap-3">
                          <span className="text-foreground/70">{c.note || c.criterionId}</span>
                          <span className="mark font-medium">{c.marks}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-4">
                  <h3 className="mb-1 text-xs font-medium text-foreground/60">Justification</h3>
                  <p className="whitespace-pre-wrap text-sm">{active.aiJustification}</p>
                </div>

                {active.evidenceRefs.length > 0 && (
                  <div className="mt-3">
                    <h3 className="mb-1 text-xs font-medium text-foreground/60">Evidence</h3>
                    <p className="mark text-xs text-foreground/60">{active.evidenceRefs.join(" · ")}</p>
                  </div>
                )}

                <div className="mt-5 border-t border-border pt-4">
                  <h3 className="mb-2 text-xs font-medium">Faculty override</h3>
                  <div className="flex gap-2">
                    <input
                      value={editMarks}
                      onChange={(e) => setEditMarks(e.target.value)}
                      placeholder={`0 - ${active.maxMarks}`}
                      inputMode="decimal"
                      className="mark w-32 rounded-[var(--radius-sm)] border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
                      aria-label="Override marks"
                    />
                    <input
                      value={editComment}
                      onChange={(e) => setEditComment(e.target.value)}
                      placeholder="Comment (optional)"
                      className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
                      aria-label="Override comment"
                    />
                    <button
                      onClick={() => saveOverride(false)}
                      disabled={saving}
                      className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                    {active.facultyMarks !== null && (
                      <button
                        onClick={() => saveOverride(true)}
                        disabled={saving}
                        className="rounded-[var(--radius-sm)] px-3 py-2 text-sm text-bad hover:bg-bad-bg"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {active.facultyComment && (
                    <p className="mt-2 text-xs text-foreground/60">Note: {active.facultyComment}</p>
                  )}
                </div>
              </article>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
