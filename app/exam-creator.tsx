"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ExamCreator() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/exams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, subject, term: term || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create exam");
        return;
      }
      setTitle("");
      setSubject("");
      setTerm("");
      router.refresh();
    } catch {
      setError("Network error. Is the server running?");
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    "w-full rounded-[var(--radius-sm)] border border-border bg-background px-3 py-2 text-sm " +
    "placeholder:text-foreground/40 focus:border-accent focus:outline-none";

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
      <div>
        <label htmlFor="exam-title" className="mb-1 block text-xs font-medium">
          Title
        </label>
        <input
          id="exam-title"
          className={inputCls}
          placeholder="Mid-semester exam"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="exam-subject" className="mb-1 block text-xs font-medium">
          Subject
        </label>
        <input
          id="exam-subject"
          className={inputCls}
          placeholder="Engineering Physics"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="exam-term" className="mb-1 block text-xs font-medium">
          Term <span className="font-normal text-foreground/50">(optional)</span>
        </label>
        <input
          id="exam-term"
          className={inputCls}
          placeholder="2026-27 Sem 1"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>
      <div className="flex items-end">
        <button
          type="submit"
          disabled={saving}
          className="h-9 rounded-[var(--radius-sm)] bg-accent px-4 text-sm font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
        >
          {saving ? "Creating..." : "Create exam"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-bad sm:col-span-4">
          {error}
        </p>
      )}
    </form>
  );
}
