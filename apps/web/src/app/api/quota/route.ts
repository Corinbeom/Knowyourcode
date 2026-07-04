import { NextResponse } from "next/server";
import { authErrorResponse, requireBackendAuth } from "@/lib/backend-auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const backendAuth = await requireBackendAuth();
    const backendUrl = process.env.BACKEND_API_URL?.replace(/\/$/, "");
    if (!backendUrl) {
      return NextResponse.json({ error: "API 서버 연결 설정이 없습니다." }, { status: 503 });
    }

    const response = await fetch(`${backendUrl}/quota`, {
      method: "GET",
      headers: backendAuth.headers,
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = typeof data.detail === "string" ? data.detail : data.error ?? "사용량 정보를 가져오지 못했습니다.";
      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: "사용량 정보를 확인하는 중 오류가 발생했습니다." }, { status: 500 });
  }
}
