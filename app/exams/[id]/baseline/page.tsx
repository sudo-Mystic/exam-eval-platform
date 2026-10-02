"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/workflow";

interface Criterion {
  id: string;
  label: string;
  maxMarks: number;
  descriptors: string;
}
interface Baseline {
  id: string;
  solutionText: string;
  alternatives: string[];
  facultyEdited: boolean;
}
interface Question {
  id: string;
  qNo: string;
  text: string;
  maxMarks: number;
  qType: string;
  criteria: Criterion[];
  baseline: Baseline | null;
}
interface RubricData {
  rubricVersion: { id: string; version: number; status: string };
  questions: Question[];
}

type Draft = {
  solutionText: string;
  alternatives: string[];
  criteria: Array<{ id?: string; label: string; maxMarks: number; descriptors: string }>;
};

export default function BaselinePage({ params }: { params: Promise<{ id: string }> }) {
  const [examId, setExamId] = useState<string | null>(null);
  const [data, setData] = useState<RubricData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Dirty drafts keyed by questionId so rail navigation never loses edits.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);

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
      setDrafts({});
      if (!activeId && json.questions.length > 0) setActiveId(json.questions[0].id);
    } catch {
      setError("Network error. Is the server running?");
    }
  }, [examId, activeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(
    () => data?.questions.find((q) => q.id === activeId) ?? null,
    [data, activeId]
  );
  const frozen = data?.rubricVersion.status === "APPROVED";
  const dirtyCount = Object.keys(drafts).length;

  // Warn on leaving with unsaved edits.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirtyCount]);

  // Keyboard: j/k navigate, e focus solution, Ctrl+S save all.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!data) return;
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void saveAll();
        return;
      }
      if (typing) return;
      const idx = data.questions.findIndex((q) => q.id === activeId);
      if (e.key === "j" && idx < data.questions.length - 1) {
        setActiveId(data.questions[idx + 1].id);
      } else if (e.key === "k" && idx > 0) {
        setActiveId(data.questions[idx - 1].id);
      } else if (e.key === "e") {
        document.getElementById("solution-text")?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  function draftFor(q: Question): Draft {
    return (
      drafts[q.id] ?? {
        solutionText: q.baseline?.solutionText ?? "",
        alternatives: q.baseline?.alternatives ?? [],
        criteria: q.criteria.map((c) => ({ ...c })),
      }
    );
  }

  function setDraft(qid: string, d: Draft) {
    setDrafts((prev) => ({ ...prev, [qid]: d }));
  }

  async function saveAll() {
    if (!examId || !data || dirtyCount === 0) return;
    setSaving(true);
    setError(null);
    try {
      for (const [qid, d] of Object.entries(drafts)) {
        const res = await fetch(`/api/exams/${examId}/baseline/${qid}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(d),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(`Question save failed: ${json.error ?? res.status}`);
          return; // keep remaining drafts; nothing silently lost
        }
      }
      await load();
    } catch {
      setError("Network error while saving");
    } finally {
      setSaving(false);
    }
  }

  if (error && !data) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10">
        <ErrorState message={error} onRetry={load} />
        <Link href={examId ? `/exams/${examId}` : "/"} className="mt-4 inline-block text-sm text-foreground/60">
          &larr; Back to exam
        </Link>
      </main>
    );
  }
  if (!data || !examId) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10">
        <SkeletonList rows={5} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link href={`/exams/${examId}`} className="text-xs text-foreground/60 hover:text-foreground">
            &larr; Exam overview
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Baseline &amp; rubric{" "}
            <span className="text-sm font-normal text-foreground/50">
              v{data.rubricVersion.version} · {data.rubricVersion.status}
            </span>
          </h1>
          <p className="mt-1 text-xs text-foreground/60">
            j/k move between questions · e focuses the solution · Ctrl+S saves all
          </p>
        </div>
        <Link
          href={`/exams/${examId}/rubric`}
          className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          Review &amp; approve
        </Link>
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={() => setError(null)} />
        </div>
      )}

      <div className="flex gap-6">
        {/* Question rail */}
        <nav aria-label="Questions" className="w-60 shrink-0">
          <ul className="space-y-1">
            {data.questions.map((q) => {
              const dirty = !!drafts[q.id];
              const ready = !!q.baseline;
              return (
                <li key={q.id}>
                  <button
                    onClick={() => setActiveId(q.id)}
                    className={[
                      "flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm",
                      q.id === activeId ? "bg-accent-soft font-medium" : "hover:bg-surface-muted",
                    ].join(" ")}
                    aria-current={q.id === activeId}
                  >
                    <span
                      className={[
                        "h-2 w-2 shrink-0 rounded-full",
                        dirty ? "bg-review" : ready ? "bg-good" : "bg-border-strong",
                      ].join(" ")}
                      title={dirty ? "Unsaved edits" : ready ? "Baseline ready" : "No baseline"}
                    />
                    <span className="mark font-semibold">{q.qNo}</span>
                    <span className="truncate text-foreground/60">{q.maxMarks} marks</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Editor */}
        <section className="min-w-0 flex-1">
          {active ? (
            <BaselineEditor
              key={active.id}
              question={active}
              draft={draftFor(active)}
              disabled={!!frozen}
              onChange={(d) => setDraft(active.id, d)}
            />
          ) : (
            <p className="text-sm text-foreground/60">Select a question.</p>
          )}
        </section>
      </div>

      {/* Sticky dirty bar */}
      {dirtyCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface px-6 py-3">
          <div className="mx-auto flex max-w-6xl items-center justify-between">
            <p className="text-sm">
              <span className="font-medium text-review">{dirtyCount} unsaved</span>
              <span className="text-foreground/60"> question{dirtyCount > 1 ? "s" : ""}</span>
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDrafts({})}
                className="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm"
              >
                Discard all
              </button>
              <button
                onClick={saveAll}
                disabled={saving}
                className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function BaselineEditor({
  question,
  draft,
  disabled,
  onChange,
}: {
  question: Question;
  draft: Draft;
  disabled: boolean;
  onChange: (d: Draft) => void;
}) {
  const [mono, setMono] = useState(question.qType === "CODE");
  const inputCls =
    "w-full rounded-[var(--radius-sm)] border border-border bg-background px-3 py-2 text-sm " +
    "focus:border-accent focus:outline-none disabled:opacity-60";

  const sum = draft.criteria.reduce((s, c) => s + (c.maxMarks || 0), 0);
  const sumOk = Math.abs(sum - question.maxMarks) < 0.001;

  function setCrit(i: number, patch: Partial<Draft["criteria"][number]>) {
    const criteria = draft.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c));
    onChange({ ...draft, criteria });
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-surface p-5">
      <div className="rounded-[var(--radius-sm)] bg-surface-muted p-4">
        <p className="text-sm font-semibold">
          <span className="mark">{question.qNo}</span>
          <span className="ml-2 font-normal text-foreground/60">
            {question.maxMarks} marks · {question.qType}
          </span>
        </p>
        <p className="mt-2 text-sm">{question.text}</p>
      </div>

      <div className="mt-5">
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="solution-text" className="text-xs font-medium">
            Baseline solution
          </label>
          <label className="flex items-center gap-1 text-xs text-foreground/60">
            <input type="checkbox" checked={mono} onChange={(e) => setMono(e.target.checked)} />
            Monospace
          </label>
        </div>
        <textarea
          id="solution-text"
          value={draft.solutionText}
          onChange={(e) => onChange({ ...draft, solutionText: e.target.value })}
          rows={8}
          disabled={disabled}
          className={`${inputCls} ${mono ? "font-mono text-[13px]" : ""}`}
        />
      </div>

      <div className="mt-5">
        <label className="mb-1 block text-xs font-medium">
          Acceptable alternatives <span className="font-normal text-foreground/50">(one per line)</span>
        </label>
        <textarea
          value={draft.alternatives.join("\n")}
          onChange={(e) =>
            onChange({ ...draft, alternatives: e.target.value.split("\n") })
          }
          rows={3}
          disabled={disabled}
          className={inputCls}
        />
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium">Marking criteria</h3>
          <span className={`mark text-xs font-semibold ${sumOk ? "text-good" : "text-bad"}`}>
            {sum} of {question.maxMarks} marks
          </span>
        </div>
        {!sumOk && (
          <p role="alert" className="mb-2 text-xs text-bad">
            Criterion marks must sum to {question.maxMarks}. Saving is blocked until they do.
          </p>
        )}
        <div className="space-y-3">
          {draft.criteria.map((c, i) => (
            <div key={c.id ?? i} className="rounded-[var(--radius-sm)] border border-border p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_110px]">
                <input
                  value={c.label}
                  onChange={(e) => setCrit(i, { label: e.target.value })}
                  placeholder="Criterion name"
                  disabled={disabled}
                  className={inputCls}
                  aria-label="Criterion label"
                />
                <input
                  value={c.maxMarks}
                  onChange={(e) => setCrit(i, { maxMarks: parseFloat(e.target.value) || 0 })}
                  disabled={disabled}
                  className={`${inputCls} mark`}
                  inputMode="decimal"
                  aria-label="Criterion marks"
                />
              </div>
              <textarea
                value={c.descriptors}
                onChange={(e) => setCrit(i, { descriptors: e.target.value })}
                rows={2}
                placeholder="What earns full, partial, and zero marks"
                disabled={disabled}
                className={`${inputCls} mt-2`}
                aria-label="Criterion descriptors"
              />
              {!disabled && (
                <button
                  onClick={() =>
                    onChange({ ...draft, criteria: draft.criteria.filter((_, j) => j !== i) })
                  }
                  className="mt-1 text-xs text-bad hover:underline"
                >
                  Remove criterion
                </button>
              )}
            </div>
          ))}
        </div>
        {!disabled && (
          <button
            onClick={() =>
              onChange({
                ...draft,
                criteria: [...draft.criteria, { label: "", maxMarks: 0, descriptors: "" }],
              })
            }
            className="mt-3 rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-muted"
          >
            + Add criterion
          </button>
        )}
      </div>
    </div>
  );
}
