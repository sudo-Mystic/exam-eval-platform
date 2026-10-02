import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { prismaError, readJsonBody, badRequest, notFound } from "@/lib/api-errors";

// PATCH /api/sheets/:id/pages/:pageId - reorder (set pageNo) or rotate.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pageId: string }> }
) {
  const { id: sheetId, pageId } = await params;
  try {
    const page = await db.sheetPage.findFirst({ where: { id: pageId, sheetId } });
    if (!page) return notFound("Page not found");

    const parsed = await readJsonBody<{ pageNo?: number; rotation?: number }>(req);
    if (!parsed.ok) return parsed.response;
    const { pageNo, rotation } = parsed.body;

    if (pageNo !== undefined) {
      if (!Number.isInteger(pageNo) || pageNo < 1) return badRequest("pageNo must be a positive integer");
      // Swap with the page currently at that position to preserve order.
      const other = await db.sheetPage.findFirst({ where: { sheetId, pageNo } });
      await db.$transaction(async (tx) => {
        // Use a temp slot to avoid unique-constraint collision.
        await tx.sheetPage.update({ where: { id: page.id }, data: { pageNo: -1 } });
        if (other && other.id !== page.id) {
          await tx.sheetPage.update({ where: { id: other.id }, data: { pageNo: page.pageNo } });
        }
        await tx.sheetPage.update({ where: { id: page.id }, data: { pageNo } });
      });
    }
    if (rotation !== undefined) {
      if (![0, 90, 180, 270].includes(rotation)) return badRequest("rotation must be 0, 90, 180 or 270");
      await db.sheetPage.update({ where: { id: pageId }, data: { rotation } });
    }

    const updated = await db.sheetPage.findUnique({ where: { id: pageId } });
    return NextResponse.json({ page: updated });
  } catch (e) {
    return prismaError(e);
  }
}

// DELETE /api/sheets/:id/pages/:pageId - delete a page and renumber the rest.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; pageId: string }> }
) {
  const { id: sheetId, pageId } = await params;
  try {
    const page = await db.sheetPage.findFirst({ where: { id: pageId, sheetId } });
    if (!page) return notFound("Page not found");

    await db.$transaction(async (tx) => {
      await tx.sheetPage.delete({ where: { id: pageId } });
      const rest = await tx.sheetPage.findMany({
        where: { sheetId },
        orderBy: { pageNo: "asc" },
      });
      // Two passes through a temp range to avoid unique-constraint collisions.
      for (const [i, p] of rest.entries()) {
        await tx.sheetPage.update({ where: { id: p.id }, data: { pageNo: 100000 + i } });
      }
      for (const [i, p] of rest.entries()) {
        await tx.sheetPage.update({ where: { id: p.id }, data: { pageNo: i + 1 } });
      }
    });

    for (const rel of [page.imagePath, page.thumbPath].filter(Boolean) as string[]) {
      try {
        await storage.delete(rel);
      } catch {
        // best effort
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return prismaError(e);
  }
}
