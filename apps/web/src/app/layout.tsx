import type { Metadata } from "next";
import Script from "next/script";
import { Analytics } from "@vercel/analytics/next";
import { AppSessionProvider } from "./session-provider";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://knowyourcode.cloud";
const title = "KnowYourCode";
const description = "GitHub 저장소를 분석하고 실제 코드 근거로 프로젝트 이해도를 검증하는 AI 코드 이해도 테스트 서비스";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: title,
  title: {
    default: title,
    template: `%s | ${title}`
  },
  description,
  keywords: [
    "AI 코드 리뷰",
    "코드 이해도 테스트",
    "GitHub 저장소 분석",
    "커밋 분석",
    "개발자 포트폴리오",
    "코드리뷰 면접",
    "바이브 코딩"
  ],
  authors: [{ name: "KnowYourCode" }],
  creator: "KnowYourCode",
  publisher: "KnowYourCode",
  category: "Developer Tools",
  alternates: {
    canonical: "/"
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1
    }
  },
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
        <AppSessionProvider>
          {children}
          <Script src="https://tally.so/widgets/embed.js" strategy="afterInteractive" />
          <Analytics />
        </AppSessionProvider>
      </body>
    </html>
  );
}
