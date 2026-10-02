"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/workflow";

interface Report {
  exam: { title: string; subject: string; term: string | null };
  student: { rollNo: string; name: string };
  result: {
    totalAi: number;
    totalFinal: number;
    maxTotal: number;
    percentage: number;
    published: boolean;
    finalizedAt: string;
  };
  questions: Array<{
    qNo: string;
    text: string;
    maxMarks: number;
    aiMarks: number;
    finalMarks: number;
    overridden: boolean;
    justification: string;
    facultyComment: string | null;
  }>;
}

export default function ReportPage({
  params,
}: {
  params: Promise<{ id: string; studentId: string }>;
}) {
  const [ids, setIds] = useState<{ id: string; studentId: string } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void params.then(setIds);
  }, [params]);

  const load = useCallback(async () => {
    if (!ids) return;
    try {
      const res = await fetch(`/api/exams/${ids.id}/reports/${ids.studentId}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not load report");
        return;
      }
      setReport(json);
      setError(null);
    } catch {
      setError("Network error. Is the server running?");
    }
  }, [ids]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !report) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10 print:hidden">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  }
  if (!report || !ids) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <SkeletonList rows={6} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Link href={`/exams/${ids.id}/results`} className="text-xs text-foreground/60 hover:text-foreground">
          &larr; Results
        </Link>
        <button
          onClick={() => window.print()}
          className="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          Print report
        </button>
      </div>

      <header className="border-b-2 border-foreground pb-4">
        <h1 className="text-xl font-semibold">{report.exam.title}</h1>
        <p className="text-sm text-foreground/60">
          {report.exam.subject}
          {report.exam.term ? ` · ${report.exam.term}` : ""}
        </p>
        <div className="mt-3 flex justify-between text-sm">
          <p>
            <span className="font-medium">{report.student.name}</span>
            <span className="mark ml-2 text-foreground/60">{report.student.rollNo}</span>
          </p>
          <p className="mark text-lg font-bold">
            {report.result.totalFinal} / {report.result.maxTotal}
            <span className="ml-2 text-sm font-normal text-foreground/60">
              ({report.result.percentage.toFixed(1)}%)
            </span>
          </p>
        </div>
      </header>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-foreground/60">
            <th className="py-2 pr-4 font-medium">Q.No</th>
            <th className="py-2 pr-4 font-medium">Question</th>
            <th className="py-2 text-right font-medium">Marks</th>
          </tr>
        </thead>
        <tbody>
          {report.questions.map((q) => (
            <tr key={q.qNo} className="border-b border-border align-top">
              <td className="mark py-2 pr-4 font-semibold">{q.qNo}</td>
              <td className="py-2 pr-4">
                <p>{q.text}</p>
                {q.facultyComment && (
                  <p className="mt-1 text-xs text-foreground/60">Note: {q.facultyComment}</p>
                )}
              </td>
              <td className="mark py-2 text-right font-medium">
                {q.finalMarks} / {q.maxMarks}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-6 text-xs text-foreground/50">
        Finalized {new Date(report.result.finalizedAt).toLocaleString()}
        {report.result.published ? " · Published" : " · Not yet published"}.
        Marks reflect faculty review; AI-proposed total was {report.result.totalAi}.
      </p>
    </main>
  );
}
