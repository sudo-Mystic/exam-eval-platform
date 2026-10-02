// Demo seed: creates a fully-worked exam so the UI can be screenshotted
// and explored without a Gemini key. All data is clearly fake.
// Env must be loaded before imports (imports are hoisted), so run via:
//   npm run seed:demo        (uses tsx --env-file=.env.demo)
// or: set -a && . ./.env.demo && set +a && npx tsx scripts/seed-demo.ts
import { db } from "../lib/db";
import { storage, paths } from "../lib/storage";
import { makeThumbnail } from "../lib/ingestion/pdf";
import sharp from "sharp";

const EXAM_TITLE = "Physics Mid-Semester (demo)";

function demoPage(roll: string, qNo: string, seed: number): Buffer {
  // A fake "scanned" answer page: ruled paper, question label, wavy lines.
  const lines: string[] = [];
  let y = 300;
  for (let i = 0; i < 14; i++) {
    const w = 700 + ((seed * 37 + i * 53) % 250);
    const wave =
      `M 140 ${y} q 40 -14 80 0 t 80 0 t 80 0 t 80 0 t 80 0 t 80 0 t 80 0` .slice(0, 60 + (i % 3) * 20);
    lines.push(
      `<path d="M 140 ${y} q 30 -12 60 0 t 60 0 t 60 0 t 60 0 t 60 0 t 60 0" stroke="#8a8f98" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.55"/>`
    );
    void wave;
    void w;
    y += 78;
  }
  const svg = `<svg width="1200" height="1600" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="1600" fill="#fdfdf8"/>
    ${Array.from({ length: 20 }, (_, i) => `<line x1="80" y1="${220 + i * 70}" x2="1120" y2="${220 + i * 70}" stroke="#d8dce3" stroke-width="2"/>`).join("")}
    <line x1="140" y1="80" x2="140" y2="1520" stroke="#f0a8a8" stroke-width="3"/>
    <text x="80" y="130" font-family="sans-serif" font-size="44" fill="#333">Roll: ${roll}</text>
    <text x="80" y="200" font-family="sans-serif" font-size="52" font-weight="bold" fill="#1a1a1a">Q${qNo}.</text>
    ${lines.join("")}
    <text x="80" y="1540" font-family="sans-serif" font-size="28" fill="#b0b0b0">demo scan - not a real answer</text>
  </svg>`;
  return Buffer.from(svg);
}

async function main() {
  // Delete in dependency order (some FKs do not cascade).
  await db.$executeRawUnsafe(
    `DELETE FROM "EvaluationOverride" WHERE "questionEvalId" IN (SELECT qe.id FROM "QuestionEvaluation" qe JOIN "Evaluation" e ON e.id = qe."evaluationId" JOIN "AnswerSheet" s ON s.id = e."sheetId" JOIN "Exam" x ON x.id = s."examId" WHERE x.title = $1)`,
    EXAM_TITLE
  );
  await db.$executeRawUnsafe(
    `DELETE FROM "FinalResult" WHERE "examId" IN (SELECT id FROM "Exam" WHERE title = $1)`,
    EXAM_TITLE
  );
  await db.$executeRawUnsafe(
    `DELETE FROM "QuestionEvaluation" WHERE "evaluationId" IN (SELECT e.id FROM "Evaluation" e JOIN "AnswerSheet" s ON s.id = e."sheetId" JOIN "Exam" x ON x.id = s."examId" WHERE x.title = $1)`,
    EXAM_TITLE
  );
  await db.$executeRawUnsafe(
    `DELETE FROM "ExtractedAnswer" WHERE "sheetId" IN (SELECT s.id FROM "AnswerSheet" s JOIN "Exam" x ON x.id = s."examId" WHERE x.title = $1)`,
    EXAM_TITLE
  );
  await db.$executeRawUnsafe(
    `DELETE FROM "Evaluation" WHERE "sheetId" IN (SELECT s.id FROM "AnswerSheet" s JOIN "Exam" x ON x.id = s."examId" WHERE x.title = $1)`,
    EXAM_TITLE
  );
  await db.exam.deleteMany({ where: { title: EXAM_TITLE } });

  const exam = await db.exam.create({
    data: { title: EXAM_TITLE, subject: "Physics", term: "Autumn 2026", status: "REVIEW" },
  });

  const qdefs = [
    { qNo: "1", text: "State Newton's second law and explain it with one everyday example.", maxMarks: 5, qType: "DESCRIPTIVE" as const, topic: "Mechanics" },
    { qNo: "2", text: "A 2 kg mass accelerates at 3 m/s^2. Find the net force acting on it.", maxMarks: 5, qType: "NUMERICAL" as const, topic: "Mechanics" },
    { qNo: "3", text: "Which of these is a transverse wave? (a) sound (b) light (c) both (d) neither", maxMarks: 2, qType: "MCQ" as const, topic: "Waves" },
    { qNo: "4", text: "Derive the expression for work done by a gas in an isothermal process.", maxMarks: 8, qType: "DESCRIPTIVE" as const, topic: "Thermodynamics" },
  ];
  const questions = [];
  for (const [i, q] of qdefs.entries()) {
    questions.push(await db.question.create({ data: { examId: exam.id, sortOrder: i + 1, ...q } }));
  }

  const version = await db.rubricVersion.create({
    data: { examId: exam.id, version: 1, status: "APPROVED" },
  });
  const critDefs: Record<string, Array<[string, number, string]>> = {
    "1": [["States F=ma correctly", 2, "Full for the law in words or symbols."], ["Valid everyday example", 2, "Car braking, rocket, etc."], ["Units mentioned", 1, "Newton / kg m/s^2."]],
    "2": [["Correct formula", 2, "F = m a."], ["Substitution", 1, "2 x 3."], ["Correct answer with unit", 2, "6 N."]],
    "3": [["Correct option", 2, "(b) light only."]],
    "4": [["Sets up dW = P dV", 2, "Starting point."], ["Uses PV = nRT", 2, "Isothermal condition."], ["Integration steps", 3, "W = nRT ln(V2/V1)."], ["Final expression boxed", 1, "Clear result."]],
  };
  const critByQ = new Map<string, { id: string; maxMarks: number }[]>();
  for (const q of questions) {
    const list = [];
    for (const [i, [label, maxMarks, descriptors]] of critDefs[q.qNo].entries()) {
      const c = await db.rubricCriterion.create({
        data: { rubricVersionId: version.id, questionId: q.id, sortOrder: i + 1, label, maxMarks, descriptors },
      });
      list.push({ id: c.id, maxMarks });
    }
    critByQ.set(q.id, list);
    await db.baselineSolution.create({
      data: {
        rubricVersionId: version.id,
        questionId: q.id,
        solutionText: `Reference solution for Q${q.qNo} (demo).`,
        alternatives: [],
        facultyEdited: false,
      },
    });
  }

  const students = [];
  for (const [rollNo, name] of [["101", "Aarav Sharma"], ["102", "Diya Patel"], ["103", "Kabir Singh"]]) {
    students.push(await db.student.create({ data: { examId: exam.id, rollNo, name } }));
  }

  // Per-student evaluation plan: [aiMarks per question], overrides, status
  const plans: Record<string, { marks: number[]; override?: [number, number, string]; evalStatus: "DONE" | "RUNNING"; finalized: boolean; published: boolean }> = {
    "101": { marks: [4, 5, 2, 5], override: [3, 6, "Partial credit for setup, integration incomplete."], evalStatus: "DONE", finalized: true, published: true },
    "102": { marks: [3, 4, 2, 6], evalStatus: "DONE", finalized: true, published: false },
    "103": { marks: [4, 3, 0, 0], evalStatus: "RUNNING", finalized: false, published: false },
  };

  for (const s of students) {
    const plan = plans[s.rollNo];
    const sheet = await db.answerSheet.create({
      data: { examId: exam.id, studentId: s.id, status: plan.finalized ? "FINALIZED" : "GRADING" },
    });
    // Two demo pages per sheet.
    for (let p = 1; p <= 2; p++) {
      const img = await sharp(demoPage(s.rollNo, p === 1 ? "1-2" : "3-4", p + s.rollNo.length)).jpeg({ quality: 85 }).toBuffer();
      const thumb = await makeThumbnail(img);
      const imagePath = paths.sheetPage(exam.id, sheet.id, p);
      const thumbPath = paths.sheetThumb(exam.id, sheet.id, p);
      await storage.save(imagePath, img);
      await storage.save(thumbPath, thumb);
      await db.sheetPage.create({ data: { sheetId: sheet.id, pageNo: p, imagePath, thumbPath, qcFlags: p === 2 && s.rollNo === "102" ? ["blur"] : [], rotation: 0 } });
    }

    const evaluation = await db.evaluation.create({
      data: { sheetId: sheet.id, rubricVersionId: version.id, status: plan.evalStatus, startedAt: new Date(Date.now() - 3600_000) },
    });

    const gradedCount = plan.evalStatus === "DONE" ? 4 : 2;
    for (let i = 0; i < gradedCount; i++) {
      const q = questions[i];
      const crits = critByQ.get(q.id)!;
      const ai = plan.marks[i];
      // Split ai marks across criteria roughly.
      let remaining = ai;
      const criterionMarks = crits.map((c, ci) => {
        const m = ci === crits.length - 1 ? remaining : Math.min(c.maxMarks, Math.round((ai / q.maxMarks) * c.maxMarks * 10) / 10);
        remaining = Math.round((remaining - m) * 10) / 10;
        return { criterionId: c.id, marks: Math.max(0, m), note: `Criterion ${ci + 1}` };
      });
      const flags: string[] = [];
      let confidence: "HIGH" | "MED" | "LOW" = "HIGH";
      if (s.rollNo === "102" && q.qNo === "4") { confidence = "LOW"; flags.push("low-confidence", "ambiguous"); }
      if (s.rollNo === "101" && q.qNo === "2") { confidence = "MED"; }
      const qe = await db.questionEvaluation.create({
        data: {
          evaluationId: evaluation.id,
          questionId: q.id,
          aiMarks: ai,
          aiJustification: `Demo interpretation of Q${q.qNo}: the student ${ai >= q.maxMarks * 0.6 ? "answered substantially correctly" : "gave a partial answer"} with ${ai >= q.maxMarks * 0.6 ? "minor" : "notable"} gaps.\n\nJustification: key steps ${ai >= q.maxMarks * 0.6 ? "present" : "missing or unclear"}; see evidence refs.`,
          criterionMarks,
          evidenceRefs: [`${i < 2 ? 1 : 2}:10,${20 + i * 8},80,40`],
          confidence,
          flags,
          model: "gemini-2.0-flash (demo)",
        },
      });
      await db.extractedAnswer.create({
        data: { sheetId: sheet.id, questionId: q.id, pageIds: [], regionRefs: [`${i < 2 ? 1 : 2}:10,20,80,60`], interpretationFlags: [] },
      });
      if (plan.override && plan.override[0] === i) {
        await db.evaluationOverride.create({
          data: { questionEvalId: qe.id, facultyMarks: plan.override[1], comment: plan.override[2] },
        });
      }
    }

    if (plan.finalized) {
      let totalAi = 0, totalFinal = 0;
      const qes = await db.questionEvaluation.findMany({ where: { evaluationId: evaluation.id }, include: { overrides: { orderBy: { createdAt: "desc" }, take: 1 }, question: true } });
      for (const qe of qes) { totalAi += qe.aiMarks; totalFinal += qe.overrides[0]?.facultyMarks ?? qe.aiMarks; }
      const maxTotal = questions.reduce((s2, q) => s2 + q.maxMarks, 0);
      await db.finalResult.create({
        data: { examId: exam.id, studentId: s.id, evaluationId: evaluation.id, totalAi, totalFinal, percentage: (totalFinal / maxTotal) * 100, published: plan.published },
      });
    }
    if (plan.evalStatus === "DONE") {
      await db.evaluation.update({ where: { id: evaluation.id }, data: { status: "DONE", finishedAt: new Date() } });
    }
  }

  console.log(`Seeded demo exam ${exam.id}`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
