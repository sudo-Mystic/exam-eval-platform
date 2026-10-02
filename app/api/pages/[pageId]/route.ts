import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { prismaError, notFound } from "@/lib/api-errors";

// GET /api/pages/:pageId - serve a captured page image (?thumb=1 for thumbnail).
// Auth is enforced by middleware on all /api/** routes.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;
  try {
    const page = await db.sheetPage.findUnique({ where: { id: pageId } });
    if (!page) return notFound("Page not found");
    const thumb = req.nextUrl.searchParams.get("thumb") === "1";
    const rel = thumb && page.thumbPath ? page.thumbPath : page.imagePath;
    const data = await storage.read(rel);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    return prismaError(e);
  }
}
