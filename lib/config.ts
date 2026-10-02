// Central configuration. Everything tunable lives here, driven by env vars.
// No model names, budgets, or thresholds are hardcoded anywhere else.

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  app: {
    url: str("APP_URL", "http://localhost:3000"),
  },
  auth: {
    // Single shared faculty token for the MVP. Empty = dev mode (open API).
    facultyToken: str("FACULTY_TOKEN", ""),
  },
  db: {
    url: str("DATABASE_URL", "postgresql://exam:exam@localhost:5432/exam_eval"),
  },
  gemini: {
    apiKey: str("GEMINI_API_KEY", ""),
    // Model routing: light for extraction/matching/MCQs, capable for baseline + hard grading.
    // Change these without code edits as models and free-tier quotas change.
    modelLight: str("GEMINI_MODEL_LIGHT", "gemini-2.0-flash"),
    modelCapable: str("GEMINI_MODEL_CAPABLE", "gemini-2.5-pro"),
    // Token budgets per exam. 0 = unlimited.
    tokenBudgetPrompt: int("EXAM_TOKEN_BUDGET_PROMPT", 0),
    tokenBudgetOutput: int("EXAM_TOKEN_BUDGET_OUTPUT", 0),
    maxRetries: int("GEMINI_MAX_RETRIES", 2),
    timeoutMs: int("GEMINI_TIMEOUT_MS", 60000),
  },
  storage: {
    backend: str("STORAGE_BACKEND", "local"), // local | s3
    dir: str("STORAGE_DIR", "./storage/uploads"),
  },
  worker: {
    concurrency: int("WORKER_CONCURRENCY", 4),
    pollMs: int("WORKER_POLL_MS", 2000),
  },
  capture: {
    // QC thresholds for the camera workspace
    blurThreshold: int("QC_BLUR_THRESHOLD", 100),
    maxImageWidth: int("IMAGE_MAX_WIDTH", 1600),
    thumbWidth: int("THUMB_WIDTH", 320),
  },
} as const;

export type AppConfig = typeof config;
