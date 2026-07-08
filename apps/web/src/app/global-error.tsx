"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ko">
      <body>
        <main className="center-screen">
          <section className="error-panel">
            <p className="eyebrow">오류</p>
            <h1>화면을 불러오는 중 문제가 발생했습니다.</h1>
            <p>잠시 후 다시 시도해주세요.</p>
            <button className="primary-button" type="button" onClick={reset}>
              다시 시도
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
