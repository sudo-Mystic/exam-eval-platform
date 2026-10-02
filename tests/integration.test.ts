// Integration tests for the non-AI workflow.
// Requires a reachable Postgres (DATABASE_URL). Skips gracefully without one,
// so `npm test` stays green in environments without a database.
// Run with a DB: DATABASE_URL=... npm test
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "../lib/db";

let dbUp = false;
try {
  await db.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const d = dbUp ? describe : describe.skip;

function req(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

d("exam workflow (no AI)", () => {
  const tag = Date.now().toString(36);
  let examId = "";
  let q1 = "";

  beforeAll(async () => {
    const { POST } = await import("../app/api/exams/route");
    const res = await POST(req("/api/exams", "POST", { title: `IT ${tag}`, subject: "Physics" }));
    expect(res.status).toBe(201);
    examId = ((await res.json()) as { exam: { id: string } }).exam.id;
  });

  afterAll(async () => {
    if (examId) await db.exam.deleteMany({ where: { id: examId } });
    await db.$disconnect();
  });

  it("rejects exam creation without title", async () => {
    const { POST } = await import("../app/api/exams/route");
    const res = await POST(req("/api/exams", "POST", { subject: "x" }));
    expect(res.status).toBe(400);
  });

  it("bulk upserts questions with validation", async () => {
    const { PATCH } = await import("../app/api/exams/[id]/questions/route");
    const params = Promise.resolve({ id: examId });
    const bad = await PATCH(
      req(`/api/exams/${examId}/questions`, "PATCH", {
        questions: [{ qNo: "1", text: "", maxMarks: 5, qType: "DESCRIPTIVE" }],
      }),
      { params }
    );
    expect(bad.status).toBe(400);

    const good = await PATCH(
      req(`/api/exams/${examId}/questions`, "PATCH", {
        questions: [
          { qNo: "1", text: "Define inertia.", maxMarks: 5, qType: "DESCRIPTIVE" },
          { qNo: "2", text: "Solve x^2=4.", maxMarks: 3, qType: "NUMERICAL" },
        ],
      }),
      { params }
    );
    expect(good.status).toBe(200);
    const json = (await good.json()) as { questions: Array<{ id: string; qNo: string }> };
    expect(json.questions).toHaveLength(2);
    q1 = json.questions[0].id;
  });

  it("creates a draft rubric and manual baseline, then approves", async () => {
    const params = Promise.resolve({ id: examId });
    const { POST: gen } = await import("../app/api/exams/[id]/baseline/generate/route");
    // generate enqueues a job; faculty can also write baselines manually.
    const genRes = await gen(req(`/api/exams/${examId}/baseline/generate`, "POST"), { params });
    expect([200, 202]).toContain(genRes.status);

    const { PATCH: patchBase } = await import("../app/api/exams/[id]/baseline/[qId]/route");
    const questions = await db.question.findMany({ where: { examId }, orderBy: { sortOrder: "asc" } });
    for (const q of questions) {
      const r = await patchBase(
        req(`/api/exams/${examId}/baseline/${q.id}`, "PATCH", {
          solutionText: "Reference solution.",
          alternatives: [],
          criteria: [{ label: "Correct answer", maxMarks: q.maxMarks, descriptors: "Full for correct." }],
        }),
        { params: Promise.resolve({ id: examId, qId: q.id }) }
      );
      expect(r.status).toBe(200);
    }

    const { POST: approve } = await import("../app/api/exams/[id]/rubric/route");
    const res = await approve(req(`/api/exams/${examId}/rubric/approve`, "POST"), { params });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rubricVersion: { status: string } };
    expect(json.rubricVersion.status).toBe("APPROVED");
  });

  it("blocks question edits after approval", async () => {
    const { PATCH } = await import("../app/api/exams/[id]/questions/route");
    const res = await PATCH(
      req(`/api/exams/${examId}/questions`, "PATCH", {
        questions: [{ id: q1, qNo: "1", text: "Changed.", maxMarks: 5, qType: "DESCRIPTIVE" }],
      }),
      { params: Promise.resolve({ id: examId }) }
    );
    expect(res.status).toBe(409);
  });

  it("blocks baseline edits after approval", async () => {
    const { PATCH } = await import("../app/api/exams/[id]/baseline/[qId]/route");
    const res = await PATCH(
      req(`/api/exams/${examId}/baseline/${q1}`, "PATCH", { solutionText: "Changed." }),
      { params: Promise.resolve({ id: examId, qId: q1 }) }
    );
    expect(res.status).toBe(409);
  });

  it("manages students idempotently", async () => {
    const mod = await import("../app/api/exams/[id]/students/route");
    const params = Promise.resolve({ id: examId });
    const body = { students: [{ rollNo: "A1", name: "Test Student" }] };
    const r1 = await mod.POST(req(`/api/exams/${examId}/students`, "POST", body), { params });
    expect(r1.status).toBe(201);
    const r2 = await mod.POST(req(`/api/exams/${examId}/students`, "POST", body), { params });
    expect(r2.status).toBe(201); // upsert, no duplicate
    const count = await db.student.count({ where: { examId } });
    expect(count).toBe(1);
  });

  it("creates one sheet per student", async () => {
    const student = await db.student.findFirstOrThrow({ where: { examId } });
    const { POST } = await import("../app/api/exams/[id]/sheets/route");
    const params = Promise.resolve({ id: examId });
    const r1 = await POST(req(`/api/exams/${examId}/sheets`, "POST", { studentId: student.id }), { params });
    expect(r1.status).toBe(201);
    const r2 = await POST(req(`/api/exams/${examId}/sheets`, "POST", { studentId: student.id }), { params });
    const j2 = (await r2.json()) as { deduped: boolean };
    expect(j2.deduped).toBe(true);
  });

  it("exports an empty CSV with headers before results exist", async () => {
    const { GET } = await import("../app/api/exams/[id]/export.csv/route");
    const res = await GET(req(`/api/exams/${examId}/export.csv`, "GET"), {
      params: Promise.resolve({ id: examId }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("roll_no");
  });
});
