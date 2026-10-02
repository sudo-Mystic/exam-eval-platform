import { claimNext, completeJob, failJob, workerConfig } from "../lib/queue";
import { dispatch, BudgetExhausted } from "./handlers";
import { isRetryable } from "../lib/gemini/provider";

// Standalone worker: polls the Postgres job queue and runs handlers.
// Run with: npx tsx worker/run.ts (or node with ts-node).
// Handlers are idempotent; duplicate runs are safe.
async function tick() {
  const job = await claimNext();
  if (!job) return;
  console.log(`[worker] claimed ${job.type} ${job.id} (attempt ${job.attempts})`);
  try {
    await dispatch(job);
    await completeJob(job.id);
    console.log(`[worker] done ${job.type} ${job.id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Budget exhaustion and rate limits park the job as retryable;
    // semantic failures fail it so faculty sees the error.
    const retryable =
      e instanceof BudgetExhausted || isRetryable(e) || /rate limited|429|5\d\d/i.test(msg);
    await failJob(job.id, msg, retryable);
    console.warn(`[worker] ${retryable ? "parked" : "failed"} ${job.type} ${job.id}: ${msg}`);
  }
}

async function main() {
  const { pollMs } = workerConfig();
  console.log(`[worker] starting, poll interval ${pollMs}ms`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error("[worker] tick error", e);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
