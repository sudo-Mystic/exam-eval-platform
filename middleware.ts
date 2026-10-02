import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

// Single-token faculty auth for the MVP (no RBAC).
// Every /api/** route requires: Authorization: Bearer <FACULTY_TOKEN>.
// If FACULTY_TOKEN is unset, auth is skipped with a dev-mode warning;
// set it before exposing this to the college network.
export function middleware(req: NextRequest) {
  const token = process.env.FACULTY_TOKEN ?? "";

  if (!token) {
    console.warn(
      "[auth] FACULTY_TOKEN is not set; API routes are unauthenticated (dev mode only)"
    );
    return NextResponse.next();
  }

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  const ok = a.length === b.length && timingSafeEqual(a, b);

  if (!ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
