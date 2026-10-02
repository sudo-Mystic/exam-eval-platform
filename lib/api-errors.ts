import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

// Shared error mapping. Never serialize raw Prisma errors to the client;
// they leak table and column names.
export function prismaError(e: unknown): NextResponse {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") {
      return NextResponse.json(
        { error: "Duplicate value: this record already exists" },
        { status: 409 }
      );
    }
    if (e.code === "P2025") {
      return NextResponse.json({ error: "Record not found" }, { status: 404 });
    }
  }
  console.error("[api] unhandled error", e);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// Guard JSON body size before parsing. Returns the parsed body or a 413.
export async function readJsonBody<T>(
  req: Request,
  maxBytes = 1024 * 1024
): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse }> {
  const len = req.headers.get("content-length");
  if (len && parseInt(len, 10) > maxBytes) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Request body too large" }, { status: 413 }),
    };
  }
  try {
    const body = (await req.json()) as T;
    return { ok: true, body };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }
}

export function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}
export function notFound(msg = "Not found") {
  return NextResponse.json({ error: msg }, { status: 404 });
}
export function conflict(msg: string) {
  return NextResponse.json({ error: msg }, { status: 409 });
}
export function unprocessable(msg: string, detail?: unknown) {
  return NextResponse.json({ error: msg, detail }, { status: 422 });
}
