import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/exams - list exams, newest first
export async function GET() {
  const exams = await db.exam.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      subject: true,
      term: true,
      status: true,
      createdAt: true,
      _count: { select: { questions: true, answerSheets: true } },
    },
  });
  return NextResponse.json({ exams });
}

// POST /api/exams - create an exam. Server-side validation only.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { title, subject, term } = (body ?? {}) as {
    title?: unknown;
    subject?: unknown;
    term?: unknown;
  };

  if (typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return NextResponse.json({ error: "subject is required" }, { status: 400 });
  }
  if (term !== undefined && typeof term !== "string") {
    return NextResponse.json({ error: "term must be a string" }, { status: 400 });
  }

  const exam = await db.exam.create({
    data: {
      title: title.trim(),
      subject: subject.trim(),
      term: term?.trim() || null,
    },
  });
  return NextResponse.json({ exam }, { status: 201 });
}
