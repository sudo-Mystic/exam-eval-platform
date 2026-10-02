import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { prismaError, notFound } from "@/lib/api-errors";

// GET /api/exams/:id/analytics - class-level performance analytics.
// Computed from finalized results and question evaluations only.
// Observations stay grounded: distributions, averages, flag counts.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;
  try {
    const exam = await db.exam.findUnique({ where: { id: examId } });
    if (!exam) return notFound("Exam not found");

    const questions = await db.question.findMany({
      where: { examId },
      orderBy: { sortOrder: "asc" },
    });
    const results = await db.finalResult.findMany({ where: { examId } });
    if (results.length === 0) {
      return NextResponse.json({
        exam: { id: exam.id, title: exam.title },
        finalizedCount: 0,
        questions: [],
        topics: [],
        overall: null,
      });
    }

    const evaluationIds = results.map((r) => r.evaluationId);
    const qevals = await db.questionEvaluation.findMany({
      where: { evaluationId: { in: evaluationIds } },
      include: {
        question: { select: { id: true, qNo: true, maxMarks: true, topic: true } },
        overrides: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    const byQuestion = new Map<string, typeof qevals>();
    for (const qe of qevals) {
      const list = byQuestion.get(qe.questionId) ?? [];
      list.push(qe);
      byQuestion.set(qe.questionId, list);
    }

    const qStats = questions.map((q) => {
      const list = byQuestion.get(q.id) ?? [];
      const finals = list.map((qe) => qe.overrides[0]?.facultyMarks ?? qe.aiMarks);
      const aiOnly = list.map((qe) => qe.aiMarks);
      const n = finals.length;
      const avg = n > 0 ? finals.reduce((s, m) => s + m, 0) / n : 0;
      const buckets = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100% of max
      for (const m of finals) {
        const pct = q.maxMarks > 0 ? (m / q.maxMarks) * 100 : 0;
        buckets[Math.min(4, Math.floor(pct / 20))]++;
      }
      const overridden = list.filter((qe) => qe.overrides.length > 0).length;
      const avgAiDelta =
        n > 0
          ? list.reduce((s, qe) => s + Math.abs((qe.overrides[0]?.facultyMarks ?? qe.aiMarks) - qe.aiMarks), 0) / n
          : 0;
      const flagged = list.filter((qe) => qe.flags.length > 0).length;
      const lowConf = list.filter((qe) => qe.confidence === "LOW").length;
      void aiOnly;
      return {
        questionId: q.id,
        qNo: q.qNo,
        maxMarks: q.maxMarks,
        topic: q.topic,
        n,
        avg: round(avg),
        avgPct: q.maxMarks > 0 ? round((avg / q.maxMarks) * 100) : 0,
        min: n > 0 ? round(Math.min(...finals)) : 0,
        max: n > 0 ? round(Math.max(...finals)) : 0,
        buckets,
        overridden,
        avgAiDelta: round(avgAiDelta),
        flagged,
        lowConf,
      };
    });

    // Topic-wise aggregation.
    const topicMap = new Map<string, { earned: number; max: number; n: number }>();
    for (const s of qStats) {
      if (!s.topic) continue;
      const t = topicMap.get(s.topic) ?? { earned: 0, max: 0, n: 0 };
      t.earned += s.avg * s.n;
      t.max += s.maxMarks * s.n;
      t.n += s.n;
      topicMap.set(s.topic, t);
    }
    const topics = [...topicMap.entries()].map(([topic, t]) => ({
      topic,
      avgPct: t.max > 0 ? round((t.earned / t.max) * 100) : 0,
      n: t.n,
    }));

    const totals = results.map((r) => r.totalFinal);
    const maxTotal = questions.reduce((s, q) => s + q.maxMarks, 0);
    const overallAvg = totals.reduce((s, t) => s + t, 0) / totals.length;

    return NextResponse.json({
      exam: { id: exam.id, title: exam.title, subject: exam.subject },
      finalizedCount: results.length,
      maxTotal,
      questions: qStats,
      topics,
      overall: {
        avg: round(overallAvg),
        avgPct: maxTotal > 0 ? round((overallAvg / maxTotal) * 100) : 0,
        min: round(Math.min(...totals)),
        max: round(Math.max(...totals)),
      },
    });
  } catch (e) {
    return prismaError(e);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
