import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "코드 이해도 테스트 시작",
  description: "GitHub repository 또는 commit URL을 입력해 AI 코드 이해도 테스트를 시작하세요.",
  alternates: {
    canonical: "/start"
  },
  openGraph: {
    title: "코드 이해도 테스트 시작 | KnowYourCode",
    description: "GitHub repository 또는 commit URL을 입력해 AI 코드 이해도 테스트를 시작하세요.",
    url: "/start"
  }
};

export default function StartLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
