import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage, paths } from "@/lib/storage";
import { checkPageImage } from "@/lib/capture/qc";
import { normalizePageImage, makeThumbnail } from "@/lib/ingestion/pdf";
import { prismaError, notFound } from "@/lib/api-errors";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per page photo
const MAX_PAGES = 100;

function sniffImage(buf: Buffer): string | null {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  )
    return "image/webp";
  return null;
}

// POST /api/sheets/:id/pages - capture one page photo.
// Runs QC (blur, resolution, exact-duplicate), stores image + thumbnail,
// appends at the end preserving page order. Never silently discards.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sheetId } = await params;
  try {
    const sheet = await db.answerSheet.findUnique({
      where: { id: sheetId },
      include: { _count: { select: { pages: true } } },
    });
    if (!sheet) return notFound("Sheet not found");
    if (sheet._count.pages >= MAX_PAGES) {
      return NextResponse.json(
        { error: `Sheet already has ${MAX_PAGES} pages` },
        { status: 400 }
      );
    }

    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Page image too large (max 20 MB)" }, { status: 413 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "No image file uploaded" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Page image too large (max 20 MB)" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (!sniffImage(buf)) {
      return NextResponse.json(
        { error: "Only PNG, JPEG, WebP images accepted" },
        { status: 400 }
      );
    }

    const normalized = await normalizePageImage(buf);
    const thumb = await makeThumbnail(normalized);
    const qc = await checkPageImage(normalized);

    // Exact-duplicate detection against existing pages in this sheet.
    const existing = await db.sheetPage.findMany({
      where: { sheetId },
      select: { id: true, pageNo: true },
    });
    // Compare via stored QC is not persisted; do a cheap content check by
    // re-hashing thumbnails is overkill. Instead flag when the normalized
    // bytes match a page uploaded in the last minute is out of scope;
    // exact duplicates are caught by comparing sha against recent pages
    // whose image we re-read (small sheets, cheap enough).
    const flags = [...qc.flags];
    for (const p of existing) {
      try {
        const old = await storage.read(
          paths.sheetPage(sheet.examId, sheetId, p.pageNo)
        );
        const { createHash } = await import("crypto");
        if (createHash("sha256").update(old).digest("hex") === qc.sha256) {
          flags.push("duplicate-suspected");
          break;
        }
      } catch {
        // ignore unreadable old pages
      }
    }

    const pageNo = sheet._count.pages + 1;
    const imagePath = paths.sheetPage(sheet.examId, sheetId, pageNo);
    const thumbPath = paths.sheetThumb(sheet.examId, sheetId, pageNo);
    await storage.save(imagePath, normalized);
    await storage.save(thumbPath, thumb);

    const page = await db.sheetPage.create({
      data: {
        sheetId,
        pageNo,
        imagePath,
        thumbPath,
        qcFlags: [...new Set(flags)],
        rotation: 0,
      },
    });

    await db.answerSheet.update({
      where: { id: sheetId },
      data: { status: "CAPTURING" },
    });

    return NextResponse.json({ page }, { status: 201 });
  } catch (e) {
    return prismaError(e);
  }
}
