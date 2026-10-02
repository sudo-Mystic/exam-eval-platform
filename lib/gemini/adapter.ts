import { config } from "../config";
import { db } from "../db";

// Provider interface. Swapping Gemini for another provider means
// implementing this interface, not rewriting the application.
export interface ModelProvider {
  name: string;
  // Structured generation: prompt + images in, parsed JSON out.
  // Throws on transport errors; returns raw text on schema mismatch so the
  // caller can decide to retry or park for faculty review.
  generateStructured(args: {
    system: string;
    user: string;
    images?: Array<{ mimeType: string; data: Buffer }>;
    maxOutputTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; promptTokens?: number; outputTokens?: number }>;
}

export type TaskKind = "extract" | "match" | "mcq" | "baseline" | "grade-hard";

// Model routing: light model for cheap tasks, capable model only where quality
// matters. Names come from config so they change without code edits.
export function modelFor(task: TaskKind): string {
  switch (task) {
    case "baseline":
    case "grade-hard":
      return config.gemini.modelCapable;
    case "extract":
    case "match":
    case "mcq":
    default:
      return config.gemini.modelLight;
  }
}

export function isHardQuestion(qType: string): boolean {
  return ["DESCRIPTIVE", "CODE", "DIAGRAM", "EQUATION"].includes(qType);
}

// Usage logging for the cost dashboard. Every call is recorded.
export async function logUsage(args: {
  examId?: string;
  purpose: string;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  status?: string;
  error?: string;
}) {
  await db.apiUsage.create({
    data: {
      examId: args.examId,
      purpose: args.purpose,
      model: args.model,
      promptTokens: args.promptTokens,
      outputTokens: args.outputTokens,
      status: args.status ?? "ok",
      error: args.error,
    },
  });
}

// Budget check: sums tokens for this exam and compares against config caps.
// Returns true when the pipeline may proceed.
export async function withinBudget(examId: string): Promise<boolean> {
  const { tokenBudgetPrompt, tokenBudgetOutput } = config.gemini;
  if (tokenBudgetPrompt === 0 && tokenBudgetOutput === 0) return true;
  const agg = await db.apiUsage.aggregate({
    where: { examId, status: "ok" },
    _sum: { promptTokens: true, outputTokens: true },
  });
  const usedPrompt = agg._sum.promptTokens ?? 0;
  const usedOutput = agg._sum.outputTokens ?? 0;
  if (tokenBudgetPrompt > 0 && usedPrompt >= tokenBudgetPrompt) return false;
  if (tokenBudgetOutput > 0 && usedOutput >= tokenBudgetOutput) return false;
  return true;
}
