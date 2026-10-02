"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/workflow";

interface Criterion {
  id: string;
  label: string;
  maxMarks: number;
}
interface Baseline {
  id: string;
  facultyEdited: boolean;
}
interface Question {
  id: string;
  qNo: string;
  subPart: string | null;
  text: string;
  maxMarks: number;
  qType: string;
  topic: string | null;
  sortOrder: number;
  criteria: Criterion[];
  baseline: Baseline | null;
}

const QTYPES = ["MCQ", "DESCRIPTIVE", "NUMERICAL", "EQUATION", "DIAGRAM", "CODE"];

export default function QuestionsPage({ params }: { params: Promise<{ id: string }> }) {
  const [examId, setExamId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [rubric, setRubric] = useState<{ status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    void params.then((p) => setExamId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!examId) return;
    try {
      const res = await fetch(`/api/exams/${examId}/questions`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not load questions");
        return;
      }
      setQuestions(json.questions);
      setRubric(json.rubricVersion);
      setError(null);
    } catch {
      setError("Network error. Is the server running?");
    }
  }, [examId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveAll(next: Question[]) {
    if (!examId) return;
    const res = await fetch(`/api/exams/${examId}/questions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions: next.map((q, i) => ({
          id: q.id.startsWith("new-") ? undefined : q.id,
          qNo: q.qNo,
          subPart: q.subPart,
          text: q.text,
          maxMarks: q.maxMarks,
          qType: q.qType,
          topic: q.topic,
          sortOrder: i,
        })),
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Could not save questions");
      return;
    }
    setQuestions(json.questions);
    setEditingId(null);
    setError(null);
  }

  async function generateBaselines() {
    if (!examId) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/exams/${examId}/baseline/generate`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not start baseline generation");
        return;
      }
      setError(null);
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setGenerating(false);
    }
  }

  if (error && !questions) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }
  if (!questions || !examId) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <SkeletonList rows={5} />
      </main>
    );
  }

  const frozen = rubric?.status === "APPROVED";

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link href={`/exams/${examId}`} className="text-xs text-foreground/60 hover:text-foreground">
            &larr; Exam overview
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Questions</h1>
          <p className="mt-1 text-sm text-foreground/60">
            Correct the extracted questions. {frozen ? "Rubric approved: questions are frozen." : "Changes save to the draft rubric."}
          </p>
        </div>
        <button
          onClick={generateBaselines}
          disabled={generating || questions.length === 0 || frozen}
          className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {generating ? "Starting..." : "Generate baselines"}
        </button>
      </header>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={() => setError(null)} />
        </div>
      )}

      {questions.length === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong bg-surface p-10 text-center">
          <p className="text-sm font-medium">No questions yet</p>
          <p className="mt-1 text-sm text-foreground/60">
            Upload the question paper from the exam overview and the AI will extract them here.
          </p>
          <Link
            href={`/exams/${examId}`}
            className="mt-4 inline-block rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm font-medium"
          >
            Go to exam overview
          </Link>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface">
          {questions.map((q) => (
            <li key={q.id} className="border-b border-border last:border-0">
              <button
                className="flex w-full items-center gap-4 px-5 py-3 text-left hover:bg-surface-muted"
                onClick={() => setEditingId(editingId === q.id ? null : q.id)}
                aria-expanded={editingId === q.id}
              >
                <span className="mark w-14 shrink-0 text-sm font-semibold">{q.qNo}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{q.text}</span>
                <span className="hidden shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-foreground/70 sm:inline">
                  {q.qType}
                </span>
                <span className="mark shrink-0 text-sm font-medium">{q.maxMarks} marks</span>
                <span
                  className={[
                    "shrink-0 rounded-full px-2 py-0.5 text-xs",
                    q.baseline ? "bg-good-bg text-good" : "bg-review-bg text-review",
                  ].join(" ")}
                >
                  {q.baseline ? "baseline ready" : "no baseline"}
                </span>
              </button>
              {editingId === q.id && (
                <QuestionEditor
                  question={q}
                  disabled={!!frozen}
                  onSave={(next) => {
                    const updated = questions.map((x) => (x.id === q.id ? { ...x, ...next } : x));
                    void saveAll(updated);
                  }}
                  onDelete={() => {
                    if (
                      q.baseline &&
                      !window.confirm(
                        `Delete question ${q.qNo}? Its baseline will be deleted too.`
                      )
                    )
                      return;
                    void saveAll(questions.filter((x) => x.id !== q.id));
                  }}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {!frozen && questions.length > 0 && (
        <button
          onClick={() => {
            const nq: Question = {
              id: `new-${Date.now()}`,
              qNo: "",
              subPart: null,
              text: "",
              maxMarks: 1,
              qType: "DESCRIPTIVE",
              topic: null,
              sortOrder: questions.length,
              criteria: [],
              baseline: null,
            };
            setQuestions([...questions, nq]);
            setEditingId(nq.id);
          }}
          className="mt-4 rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm font-medium hover:bg-surface-muted"
        >
          + Add question
        </button>
      )}
    </main>
  );
}

function QuestionEditor({
  question,
  disabled,
  onSave,
  onDelete,
  onCancel,
}: {
  question: Question;
  disabled: boolean;
  onSave: (q: Partial<Question>) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [qNo, setQNo] = useState(question.qNo);
  const [text, setText] = useState(question.text);
  const [maxMarks, setMaxMarks] = useState(String(question.maxMarks));
  const [qType, setQType] = useState(question.qType);
  const [topic, setTopic] = useState(question.topic ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const inputCls =
    "w-full rounded-[var(--radius-sm)] border border-border bg-background px-3 py-2 text-sm " +
    "focus:border-accent focus:outline-none disabled:opacity-60";

  function submit() {
    const marks = parseFloat(maxMarks);
    if (!qNo.trim()) return setLocalError("Question number is required");
    if (!text.trim()) return setLocalError("Question text is required");
    if (!Number.isFinite(marks) || marks <= 0)
      return setLocalError("Marks must be a positive number");
    onSave({
      qNo: qNo.trim(),
      text: text.trim(),
      maxMarks: marks,
      qType,
      topic: topic.trim() || null,
    });
  }

  return (
    <div className="border-t border-border bg-background px-5 py-4">
      <div className="grid gap-3 sm:grid-cols-[100px_1fr_120px_160px]">
        <div>
          <label className="mb-1 block text-xs font-medium">Q.No</label>
          <input value={qNo} onChange={(e) => setQNo(e.target.value)} className={inputCls} disabled={disabled} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Topic (optional)</label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} className={inputCls} disabled={disabled} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Marks</label>
          <input value={maxMarks} onChange={(e) => setMaxMarks(e.target.value)} className={`${inputCls} mark`} disabled={disabled} inputMode="decimal" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Type</label>
          <select value={qType} onChange={(e) => setQType(e.target.value)} className={inputCls} disabled={disabled}>
            {QTYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium">Question text</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className={inputCls}
          disabled={disabled}
        />
      </div>
      {localError && (
        <p role="alert" className="mt-2 text-xs text-bad">{localError}</p>
      )}
      {!disabled && (
        <div className="mt-3 flex gap-2">
          <button onClick={submit} className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white">
            Save question
          </button>
          <button onClick={onCancel} className="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm">
            Cancel
          </button>
          <button onClick={onDelete} className="ml-auto rounded-[var(--radius-sm)] px-4 py-2 text-sm text-bad hover:bg-bad-bg">
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
