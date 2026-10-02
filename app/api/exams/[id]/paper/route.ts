import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage, paths } from "@/lib/storage";
import { enqueue } from "@/lib/queue";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per upload
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
        // bytes 8..11 must be "WEBP"
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
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: examId } = await params;

  const exam = await db.exam.findUnique({ where: { id: examId } });
  if (!exam) return NextResponse.json({ error: "Exam not found" }, { status: 404 });
  if (!["DRAFT", "PREPARED"].includes(exam.status)) {
    return NextResponse.json(
      { error: `Cannot upload paper while exam is ${exam.status}` },
      { status: 409 }
    );
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
    return NextResponse.json(
      { error: `Too many files (max ${MAX_FILES})` },
      { status: 400 }
    );
  }

  const saved: string[] = [];
  for (const [i, file] of files.entries()) {
    if (file.size === 0) {
      return NextResponse.json({ error: `File ${file.name} is empty` }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `File ${file.name} exceeds 50 MB` },
        { status: 400 }
      );
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const mime = sniffMime(buf);
    if (!mime || !["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(mime)) {
      return NextResponse.json(
        { error: `File ${file.name}: only PDF, PNG, JPEG, WebP accepted` },
        { status: 400 }
      );
    }
    const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1];
    const rel = `${paths.paperDir(examId)}/upload-${i}.${ext}`;
    await storage.save(rel, buf);
    saved.push(rel);
  }

  await enqueue("ingest-paper", { examId, files: saved });

  await db.exam.update({
    where: { id: examId },
    data: { status: "PREPARED" },
  });

  return NextResponse.json({ ok: true, files: saved }, { status: 202 });
}
