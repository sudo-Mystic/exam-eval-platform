import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage, paths } from "@/lib/storage";
import { prismaError, conflict, notFound } from "@/lib/api-errors";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB total per upload
const MAX_FILES = 25;

const SIGNATURES: Array<{ mime: string; magic: number[] }> = [
  { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP checked below
];

function sniffMime(buf: Buffer): string | null {
  for (const s of SIGNATURES) {
    if (s.magic.every((b, i) => buf[i] === b)) {
      if (s.mime === "image/webp") {
        if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
          return s.mime;
        }
        continue;
      }
      return s.mime;
    }
  }
  return null;
}

// POST /api/exams/:id/paper - upload question paper (PDF or page images).
// Saves files, enqueues an ingest-paper job, moves exam to PREPARED.
// Re-upload policy: replaces the paper and deletes DRAFT questions, criteria
// and baselines in the same transaction. 409 if a rubric version is already
// APPROVED or an ingest job is already queued/running.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;

  // Total size pre-check before buffering the multipart body into memory.
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { error: "Upload too large (max 200 MB total)" },
      { status: 413 }
    );
  }

  const exam = await db.exam.findUnique({ where: { id: examId } });
  if (!exam) return notFound("Exam not found");
  if (!["DRAFT", "PREPARED"].includes(exam.status)) {
    return conflict(`Cannot upload paper while exam is ${exam.status}`);
  }

  // Duplicate-submit guard: one ingest at a time per exam.
  const activeIngest = await db.job.findFirst({
    where: {
      type: "ingest-paper",
      status: { in: ["queued", "running", "retryable"] },
      payload: { path: ["examId"], equals: examId },
    },
  });
  if (activeIngest) {
    return conflict("Paper ingestion already in progress for this exam");
  }

  // Approved rubric means the paper is frozen.
  const approved = await db.rubricVersion.findFirst({
    where: { examId, status: "APPROVED" },
  });
  if (approved) {
    return conflict("Rubric already approved; the paper cannot be replaced");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files uploaded" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Too many files (max ${MAX_FILES})` }, { status: 400 });
  }

  const saved: string[] = [];
  try {
    for (const [i, file] of files.entries()) {
      if (file.size === 0) {
        throw new Error(`File at position ${i + 1} is empty`);
      }
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(`File at position ${i + 1} exceeds 50 MB`);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = sniffMime(buf);
      if (!mime) {
        throw new Error(`File at position ${i + 1}: only PDF, PNG, JPEG, WebP accepted`);
      }
      const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1];
      const rel = `${paths.paperDir(examId)}/upload-${i}.${ext}`;
      await storage.save(rel, buf);
      saved.push(rel);
    }

    // Replace policy: new paper invalidates draft extraction work. Delete
    // questions (cascades draft criteria/baselines) and draft rubric versions
    // in the same transaction that enqueues the new ingest job.
    await db.$transaction(async (tx) => {
      await tx.question.deleteMany({ where: { examId } });
      await tx.rubricVersion.deleteMany({ where: { examId, status: "DRAFT" } });
      await tx.paperUpload.create({
        data: { examId, files: saved },
      });
      await tx.job.create({
        data: {
          type: "ingest-paper",
          payload: { examId, files: saved },
        },
      });
      await tx.exam.update({
        where: { id: examId },
        data: { status: "PREPARED" },
      });
    });
  } catch (e) {
    // Orphan cleanup: files reached disk but the transaction failed.
    for (const rel of saved) {
      try {
        await storage.delete(rel);
      } catch {
        // best effort; a sweeper can catch stragglers
      }
    }
    if (e instanceof Error && e.message.startsWith("File at position")) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return prismaError(e);
  }

  return NextResponse.json({ ok: true, files: saved }, { status: 202 });
}
