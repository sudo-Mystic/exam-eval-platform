import Link from "next/link";

const STEPS = [
  { key: "DRAFT", label: "Draft" },
  { key: "PAPER", label: "Paper" },
  { key: "QUESTIONS", label: "Questions" },
  { key: "BASELINE", label: "Baseline" },
  { key: "APPROVED", label: "Approved" },
] as const;

// Clickable workflow stepper. Maps exam status to the furthest reached step.
export function WorkflowStepper({
  examId,
  status,
}: {
  examId: string;
  status: string;
}) {
  const stepFor = (s: string) => {
    if (s === "DRAFT") return 0;
    if (s === "PREPARED") return 2; // paper uploaded, questions extracting/editable
    return 4; // READY and beyond: rubric approved
  };
  const current = stepFor(status);
  const hrefFor = (i: number) => {
    if (i === 0) return `/exams/${examId}`;
    if (i === 1 || i === 2) return `/exams/${examId}/questions`;
    return `/exams/${examId}/rubric`;
  };

  return (
    <nav aria-label="Exam setup progress" className="flex items-center gap-1">
      {STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <span key={step.key} className="flex items-center gap-1">
            {i > 0 && <span className="mx-1 h-px w-6 bg-border-strong" aria-hidden />}
            <Link
              href={hrefFor(i)}
              aria-current={active ? "step" : undefined}
              className={[
                "rounded-full px-3 py-1 text-xs font-medium",
                done
                  ? "bg-good-bg text-good"
                  : active
                    ? "bg-accent text-white"
                    : "bg-surface-muted text-foreground/50",
              ].join(" ")}
            >
              {step.label}
            </Link>
          </span>
        );
      })}
      <span className="sr-only">Current status: {status}</span>
    </nav>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong bg-surface p-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-foreground/60">{hint}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-md)] border border-bad/30 bg-bad-bg p-4 text-sm"
    >
      <p className="font-medium text-bad">Something went wrong</p>
      <p className="mt-1 text-bad/80">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded-[var(--radius-sm)] border border-bad/40 px-3 py-1.5 text-xs font-medium text-bad"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="border-b border-border px-5 py-4 last:border-0">
          <div className="h-4 w-1/3 animate-pulse rounded bg-surface-muted" />
          <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-surface-muted" />
        </div>
      ))}
    </div>
  );
}
