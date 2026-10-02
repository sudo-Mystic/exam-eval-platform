import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage, paths } from "@/lib/storage";
import { enqueue } from "@/lib/queue";
import { prismaError, conflict, notFound } from "@/lib/api-errors";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 25;

function sniffMime(buf: Buffer): string | null {
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
    return "application/pdf";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

// POST /api/exams/:id/scheme - upload the marking scheme (PDF or images).
// Enqueues a scheme-parse job. DRAFT-only: 409 once a rubric is APPROVED.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;

  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { error: "Upload too large (max 200 MB total)" },
      { status: 413 }
    );
  }

  const exam = await db.exam.findUnique({ where: { id: examId } });
  if (!exam) return notFound("Exam not found");

  const approved = await db.rubricVersion.findFirst({
    where: { examId, status: "APPROVED" },
  });
  if (approved) return conflict("Rubric already approved; scheme is frozen");

  const activeParse = await db.job.findFirst({
    where: {
      type: "scheme-parse",
      status: { in: ["queued", "running", "retryable"] },
      payload: { path: ["examId"], equals: examId },
    },
  });
  if (activeParse) return conflict("Scheme parsing already in progress for this exam");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0)
    return NextResponse.json({ error: "No files uploaded" }, { status: 400 });
  if (files.length > MAX_FILES)
    return NextResponse.json({ error: `Too many files (max ${MAX_FILES})` }, { status: 400 });

  const saved: string[] = [];
  try {
    for (const [i, file] of files.entries()) {
      if (file.size === 0) throw new Error(`File at position ${i + 1} is empty`);
      if (file.size > MAX_FILE_BYTES)
        throw new Error(`File at position ${i + 1} exceeds 50 MB`);
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = sniffMime(buf);
      if (!mime) throw new Error(`File at position ${i + 1}: only PDF, PNG, JPEG accepted`);
      const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1];
      const rel = `${paths.paperDir(examId)}/scheme-${i}.${ext}`;
      await storage.save(rel, buf);
      saved.push(rel);
    }
    await enqueue("scheme-parse", { examId, files: saved });
  } catch (e) {
    for (const rel of saved) {
      try {
        await storage.delete(rel);
      } catch {
        // best effort
      }
    }
    if (e instanceof Error && e.message.startsWith("File at position")) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return prismaError(e);
  }

  return NextResponse.json({ ok: true, files: saved }, { status: 202 });
}
