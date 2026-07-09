import { NextResponse } from "next/server";

const PRODUCTION_ENV_VALUES = new Set(["production"]);
const REQUIRED_PRODUCTION_ENV = [
  "AUTH_SECRET",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "BACKEND_API_URL",
  "API_PROXY_SECRET"
];

export function backendApiUrl(): string | null {
  return process.env.BACKEND_API_URL?.replace(/\/$/, "") || null;
}

export function isProductionRuntime(): boolean {
  if (process.env.VERCEL_ENV) {
    return PRODUCTION_ENV_VALUES.has(process.env.VERCEL_ENV);
  }
  return process.env.NODE_ENV === "production";
}

export function webRuntimeConfigErrorResponse(): NextResponse | null {
  if (!isProductionRuntime()) return null;

  const missing = REQUIRED_PRODUCTION_ENV.filter((key) => !process.env[key]);
  if (!missing.length) return null;

  return NextResponse.json(
    {
      error: "운영 Web 보안 설정이 누락되었습니다.",
      code: "WEB_RUNTIME_CONFIG_INVALID"
    },
    { status: 503 }
  );
}
