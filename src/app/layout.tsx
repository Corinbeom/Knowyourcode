import type { Metadata } from "next";
import Script from "next/script";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://knowyourcode.vercel.app";
const title = "KnowYourCode";
const description = "GitHub 저장소를 분석하고 실제 코드 근거로 프로젝트 이해도를 검증하는 AI 코드 이해도 테스트 서비스";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: title,
    template: `%s | ${title}`
  },
  description,
  icons: {
    icon: "/brand/knowyourcode-dark.png",
    shortcut: "/brand/knowyourcode-dark.png",
    apple: "/brand/knowyourcode-light.png"
  },
  openGraph: {
    title,
    description,
    url: siteUrl,
    siteName: title,
    images: [
      {
        url: "/brand/knowyourcode-dark.png",
        width: 500,
        height: 500,
        alt: "KnowYourCode logo"
      }
    ],
    locale: "ko_KR",
    type: "website"
  },
  twitter: {
    card: "summary",
    title,
    description,
    images: ["/brand/knowyourcode-dark.png"]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        {children}
        <Script src="https://tally.so/widgets/embed.js" strategy="afterInteractive" />
        <Analytics />
      </body>
    </html>
  );
}
