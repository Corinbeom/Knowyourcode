import { auth } from "@/auth";

export type BackendAuth = {
  headers: Record<string, string>;
  user: {
    githubId: string;
    githubLogin: string;
  };
};

export async function requireBackendAuth(): Promise<BackendAuth> {
  const session = await auth();
  const githubId = session?.user?.githubId;
  const githubLogin = session?.user?.githubLogin;

  if (!githubId || !githubLogin) {
    throw new Error("LOGIN_REQUIRED");
  }

  const proxySecret = process.env.API_PROXY_SECRET;
  const backendUrl = process.env.BACKEND_API_URL;
  if (backendUrl && !proxySecret) {
    throw new Error("API_PROXY_SECRET_MISSING");
  }

  return {
    user: { githubId, githubLogin },
    headers: {
      ...(proxySecret ? { "X-KYC-Proxy-Secret": proxySecret } : {}),
      "X-KYC-User-Id": githubId,
      "X-KYC-User-Login": githubLogin
    }
  };
}

export function authErrorResponse(error: unknown) {
  if (error instanceof Error && error.message === "LOGIN_REQUIRED") {
    return Response.json({ error: "GitHub 로그인 후 이용할 수 있습니다.", code: "LOGIN_REQUIRED" }, { status: 401 });
  }
  if (error instanceof Error && error.message === "API_PROXY_SECRET_MISSING") {
    return Response.json({ error: "API 프록시 보안 설정이 누락되었습니다." }, { status: 500 });
  }
  return null;
}
