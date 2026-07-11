import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    commitSha: process.env.COMMIT_SHA
      || process.env.RENDER_GIT_COMMIT
      || process.env.RAILWAY_GIT_COMMIT_SHA
      || process.env.VERCEL_GIT_COMMIT_SHA
      || "unknown"
  });
}
