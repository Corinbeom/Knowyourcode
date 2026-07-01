import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KnowYourCode",
  description: "GitHub 저장소 기반 코드 이해도 테스트 서비스"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
