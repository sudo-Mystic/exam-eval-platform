import { Prisma } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";

// Postgres-backed job queue. No Redis in MVP.
// Workers claim jobs with SELECT ... FOR UPDATE SKIP LOCKED so multiple
// workers never double-run a job. Re-running a completed stage is a no-op
// because handlers are idempotent on their natural keys.

export type JobType =
  | "ingest-paper"
  | "scheme-parse"
  | "generate-baseline"
  | "question-match"
  | "grade-question";

export interface JobPayload {
  [key: string]: unknown;
}

export async function enqueue(
  type: JobType,
  payload: JobPayload,
  opts?: { runAfter?: Date; maxAttempts?: number }
) {
  return db.job.create({
    data: {
      type,
      payload: payload as Prisma.InputJsonValue,
      runAfter: opts?.runAfter,
      maxAttempts: opts?.maxAttempts ?? 3,
    },
  });
}

export interface ClaimedJob {
  id: string;
  type: string;
  payload: JobPayload;
  attempts: number;
  maxAttempts: number;
}

// Atomically claim the next due job. Returns null when the queue is empty.
export async function claimNext(): Promise<ClaimedJob | null> {
  const rows = await db.$queryRaw<ClaimedJob[]>`
    UPDATE "Job"
    SET status = 'running', "updatedAt" = NOW(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status IN ('queued', 'retryable')
        AND "runAfter" <= NOW()
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, attempts, "maxAttempts"
  `;
  if (rows.length === 0) return null;
  return { ...rows[0], payload: rows[0].payload as JobPayload };
}

export async function completeJob(id: string) {
  await db.job.update({
    where: { id },
    data: { status: "done" },
  });
}

export async function failJob(id: string, error: string, retryable: boolean) {
  const job = await db.job.findUniqueOrThrow({ where: { id } });
  const canRetry = retryable && job.attempts < job.maxAttempts;
  await db.job.update({
    where: { id },
    data: {
      status: canRetry ? "retryable" : "failed",
      lastError: error,
      // Simple backoff: 30s * attempts. No bit shifts (see AGENTS.md).
      runAfter: canRetry
        ? new Date(Date.now() + 30_000 * job.attempts)
        : undefined,
    },
  });
}

export async function queueStatus(examId: string) {
  // Counts of jobs touching this exam, for the progress UI.
  const groups = await db.job.groupBy({
    by: ["status"],
    where: { payload: { path: ["examId"], equals: examId } },
    _count: true,
  });
  const out: Record<string, number> = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    retryable: 0,
  };
  for (const g of groups) out[g.status] = g._count;
  return out;
}

export function workerConfig() {
  return {
    concurrency: config.worker.concurrency,
    pollMs: config.worker.pollMs,
  };
}
