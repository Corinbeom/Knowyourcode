import { NextResponse } from "next/server";

const MAX_EVALUATION_PAYLOAD_BYTES = Number(process.env.MAX_EVALUATION_PAYLOAD_BYTES ?? 250_000);
const MAX_EVALUATION_QUESTIONS = Number(process.env.MAX_EVALUATION_QUESTIONS ?? 10);
const MAX_EVALUATION_CONTEXT_FILES = Number(process.env.MAX_EVALUATION_CONTEXT_FILES ?? 20);
const MAX_EVALUATION_EVIDENCE_SNIPPETS = Number(process.env.MAX_EVALUATION_EVIDENCE_SNIPPETS ?? 60);
const MAX_EVALUATION_EXCERPT_CHARS = Number(process.env.MAX_EVALUATION_EXCERPT_CHARS ?? 5_000);

export class PayloadTooLargeError extends Error {
  constructor(message = "평가 요청 크기가 너무 큽니다.") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export async function readEvaluationJson<T>(request: Request): Promise<T> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_EVALUATION_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError();
  }
  return JSON.parse(raw) as T;
}

export function payloadTooLargeResponse(error: unknown): NextResponse | null {
  if (!(error instanceof PayloadTooLargeError)) return null;
  return NextResponse.json({ error: error.message }, { status: 413 });
}

export function validateEvaluationAnalysis(analysis: unknown): NextResponse | null {
  if (!isRecord(analysis)) {
    return NextResponse.json({ error: "분석 결과 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const questions = toArray(analysis.questions);
  if (!questions.length || questions.length > MAX_EVALUATION_QUESTIONS) {
    return NextResponse.json({ error: "평가할 질문 수가 허용 범위를 벗어났습니다." }, { status: 413 });
  }

  const contextFiles = toArray(analysis.contextFiles);
  if (contextFiles.length > MAX_EVALUATION_CONTEXT_FILES) {
    return NextResponse.json({ error: "평가 코드 근거 파일 수가 너무 많습니다." }, { status: 413 });
  }

  const topLevelEvidence = toArray(analysis.evidenceSnippets);
  const questionEvidenceCount = questions.reduce<number>((total, question) => {
    if (!isRecord(question)) return total;
    return total + toArray(question.evidenceSnippets).length;
  }, 0);
  if (topLevelEvidence.length + questionEvidenceCount > MAX_EVALUATION_EVIDENCE_SNIPPETS) {
    return NextResponse.json({ error: "평가 코드 근거 조각 수가 너무 많습니다." }, { status: 413 });
  }

  if (hasOversizedExcerpt(contextFiles) || hasOversizedExcerpt(topLevelEvidence) || questions.some(hasOversizedQuestionEvidence)) {
    return NextResponse.json({ error: "평가 코드 근거 내용이 너무 깁니다." }, { status: 413 });
  }

  return null;
}

function hasOversizedQuestionEvidence(question: unknown): boolean {
  if (!isRecord(question)) return false;
  return hasOversizedExcerpt(toArray(question.evidenceSnippets));
}

function hasOversizedExcerpt(items: unknown[]): boolean {
  return items.some((item) => isRecord(item) && typeof item.excerpt === "string" && item.excerpt.length > MAX_EVALUATION_EXCERPT_CHARS);
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
