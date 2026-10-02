"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { WorkflowStepper, ErrorState } from "@/components/workflow";
import { UploadCard } from "@/components/upload-card";

interface Detail {
  exam: {
    id: string;
    title: string;
    subject: string;
    term: string | null;
    status: string;
  };
  rubricVersion: { id: string; version: number; status: string } | null;
  counts: { questions: number; baselines: number; criteria: number; sheets: number };
  usage: { calls: number; promptTokens: number; outputTokens: number };
  jobs: Array<{ id: string; type: string; status: string; lastError: string | null }>;
}

export default function ExamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [examId, setExamId] = useState<string | null>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void params.then((p) => setExamId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!examId) return;
    try {
      const res = await fetch(`/api/exams/${examId}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not load exam");
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
    const t = setInterval(load, 2000); // poll for ingest/baseline progress
    return () => clearInterval(t);
  }, [load]);

  if (error && !data) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }
  if (!data) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10" aria-busy="true" aria-label="Loading exam">
        <div className="h-8 w-64 animate-pulse rounded bg-surface-muted" />
        <div className="mt-6 h-24 animate-pulse rounded-[var(--radius-md)] bg-surface-muted" />
      </main>
    );
  }

  const { exam, rubricVersion, counts, usage, jobs } = data;
  const activeJob = jobs.find((j) =>
    ["queued", "running", "retryable"].includes(j.status)
  );
  const failedJob = jobs.find((j) => j.status === "failed");

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <Link href="/" className="text-xs text-foreground/60 hover:text-foreground">
          &larr; All exams
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{exam.title}</h1>
        <p className="mt-1 text-sm text-foreground/60">
          {exam.subject}
          {exam.term ? ` · ${exam.term}` : ""}
        </p>
        <div className="mt-4">
          <WorkflowStepper examId={exam.id} status={exam.status} />
        </div>
      </header>

      {activeJob && (
        <div className="mb-6 rounded-[var(--radius-md)] border border-info/30 bg-info-bg p-4 text-sm" role="status">
          <p className="font-medium text-info">
            {activeJob.type === "ingest-paper" && "Reading your question paper..."}
            {activeJob.type === "scheme-parse" && "Parsing the marking scheme..."}
            {activeJob.type === "generate-baseline" && "Generating baseline solutions..."}
            {!["ingest-paper", "scheme-parse", "generate-baseline"].includes(activeJob.type) &&
              `Working: ${activeJob.type}`}
          </p>
          <p className="mt-1 text-info/70">This page refreshes automatically.</p>
        </div>
      )}
      {failedJob && (
        <div className="mb-6" role="alert">
          <ErrorState
            message={`${failedJob.type} failed: ${failedJob.lastError ?? "unknown error"}. Your files are kept; fix the issue and re-upload.`}
            onRetry={load}
          />
        </div>
      )}

      <section className="mb-8 grid gap-4 md:grid-cols-2">
        <UploadCard
          examId={exam.id}
          kind="paper"
          title="Question paper"
          hint="PDF or page images. Re-uploading replaces the paper and clears draft questions."
          onDone={load}
        />
        <UploadCard
          examId={exam.id}
          kind="scheme"
          title="Marking scheme"
          hint="PDF or images. Criteria attach to the extracted questions."
          onDone={load}
        />
      </section>

      <section className="rounded-[var(--radius-md)] border border-border bg-surface p-5">
        <h2 className="text-sm font-medium">Pipeline status</h2>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-foreground/60">Questions</dt>
            <dd className="mark mt-1 text-lg font-semibold">{counts.questions}</dd>
          </div>
          <div>
            <dt className="text-xs text-foreground/60">Baselines</dt>
            <dd className="mark mt-1 text-lg font-semibold">
              {counts.baselines}
              <span className="text-foreground/40"> / {counts.questions}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-foreground/60">Rubric</dt>
            <dd className="mt-1 text-lg font-semibold">
              {rubricVersion ? (
                <span>
                  v{rubricVersion.version}{" "}
                  <span className="text-xs font-medium text-foreground/60">
                    {rubricVersion.status}
                  </span>
                </span>
              ) : (
                <span className="text-sm font-normal text-foreground/50">none yet</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-foreground/60">API calls</dt>
            <dd className="mark mt-1 text-lg font-semibold">
              {usage.calls}
              <span className="ml-2 text-xs font-normal text-foreground/50">
                {(usage.promptTokens + usage.outputTokens).toLocaleString()} tokens
              </span>
            </dd>
          </div>
        </dl>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href={`/exams/${exam.id}/questions`}
            className="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm font-medium hover:bg-surface-muted"
          >
            Review questions
          </Link>
          <Link
            href={`/exams/${exam.id}/rubric`}
            className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Baseline &amp; approval
          </Link>
        </div>
      </section>
    </main>
  );
}
