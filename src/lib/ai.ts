import type {
  AiUsage,
  AnalysisFocus,
  AnalysisResult,
  EvaluationResult,
  FileSummary,
  ProjectReport,
  RepoInfo,
  UnderstandingQuestion
} from "./types";
import { extractCodeSignals, formatSignalsForPrompt, type CodeSignal } from "./code-signals";

type StaticContext = {
  repo: RepoInfo;
  focus: AnalysisFocus;
  questionTargets: string[];
  fileCount: number;
  contextFiles: FileSummary[];
  tree: string[];
  packageInfo: Record<string, unknown> | null;
};

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";
const ANALYSIS_OUTPUT_TOKENS = Number(process.env.ANALYSIS_OUTPUT_TOKENS ?? 2200);
const EVALUATION_OUTPUT_TOKENS = Number(process.env.EVALUATION_OUTPUT_TOKENS ?? 1200);

type ProviderResult = {
  text: string | null;
  usage: AiUsage;
  retryable?: boolean;
};

function formatFocus(focus: AnalysisFocus): string {
  if (focus === "frontend") return "프론트엔드 중심";
  if (focus === "backend") return "백엔드 중심";
  return "전체 균형";
}

function buildQuestionPlan(focus: AnalysisFocus): string {
  if (focus === "frontend") {
    return [
      "- q1 구조 이해: page/component/layout 중 하나의 역할",
      "- q2 요청 흐름: frontend route, API call, form submit, navigation 흐름",
      "- q3 데이터 흐름: client state, props, server response, cache 중 하나",
      "- q4 변경 영향도: UI 기능 변경 시 함께 봐야 할 파일",
      "- q5 면접형: frontend 설계 의도 또는 사용자 경험 리스크"
    ].join("\n");
  }

  if (focus === "backend") {
    return [
      "- q1 구조 이해: API/controller/handler 또는 service 계층 역할",
      "- q2 요청 흐름: request가 service/domain/persistence까지 이동하는 흐름",
      "- q3 데이터 흐름: repository/entity/model/schema/database 중 하나",
      "- q4 변경 영향도: business rule 변경 시 영향받는 계층",
      "- q5 면접형: 장애, 예외, 보안, 트랜잭션, 운영 리스크 중 하나"
    ].join("\n");
  }

  return [
    "- q1 구조 이해: frontend page/component 또는 client entry 파일",
    "- q2 요청 흐름: backend API/controller/service 또는 server entry 파일",
    "- q3 데이터 흐름: frontend와 backend 사이 데이터 이동 또는 저장소 접근",
    "- q4 변경 영향도: 한 기능 변경 시 frontend와 backend 중 다른 계층 영향",
    "- q5 면접형: auth/security가 아닌 다른 핵심 도메인이나 운영 리스크"
  ].join("\n");
}

function formatQuestionTargets(questionTargets: string[]): string {
  return questionTargets.length ? questionTargets.join(", ") : "전체 기능";
}

function formatQuestionSignalBuckets(signals: CodeSignal[], focus: AnalysisFocus): string {
  const frontend = signals.filter((signal) => isClientFacingPath(signal.path));
  const backend = signals.filter((signal) => isServerFacingPath(signal.path));
  const shared = signals.filter(
    (signal) => !isClientFacingPath(signal.path) && !isServerFacingPath(signal.path)
  );

  if (focus === "frontend") {
    return [
      "Primary frontend candidates:",
      formatSignalsForPrompt(frontend.slice(0, 14)),
      "Secondary related candidates:",
      formatSignalsForPrompt([...shared, ...backend].slice(0, 6))
    ].join("\n");
  }

  if (focus === "backend") {
    return [
      "Primary backend candidates:",
      formatSignalsForPrompt(backend.slice(0, 14)),
      "Secondary related candidates:",
      formatSignalsForPrompt([...shared, ...frontend].slice(0, 6))
    ].join("\n");
  }

  return [
    "Frontend candidates:",
    formatSignalsForPrompt(frontend.slice(0, 8)),
    "Backend candidates:",
    formatSignalsForPrompt(backend.slice(0, 8)),
    "Shared/config candidates:",
    formatSignalsForPrompt(shared.slice(0, 6))
  ].join("\n");
}

function isClientFacingPath(path: string): boolean {
  return /(^|\/)(frontend|client|web|app|pages|components|views|screens|ui)(\/|$)|\.(tsx|jsx|vue|svelte|astro)$/i.test(path);
}

function isServerFacingPath(path: string): boolean {
  return /(^|\/)(backend|server|api|routes|controllers?|services?|repositories?|entities?|models?|domain|infra)(\/|$)|\.(java|kt|go|py|rb|php|cs|rs)$/i.test(path);
}

export async function generateAnalysis(
  context: StaticContext,
  fallback: AnalysisResult
): Promise<AnalysisResult> {
  const questionsResult = await generateQuestions(context, fallback);
  const reportResult = await generateReport(context, fallback);
  const aiUsage = questionsResult.ai.used ? questionsResult.ai : reportResult.ai;

  if (!questionsResult.ai.used && !reportResult.ai.used) {
    return {
      ...fallback,
      ai: {
        ...questionsResult.ai,
        reason: `${questionsResult.ai.reason ?? "질문 생성 실패"} / ${reportResult.ai.reason ?? "리포트 생성 실패"}`
      }
    };
  }

  return {
    ...fallback,
    ai: aiUsage,
    report: reportResult.report,
    questions: questionsResult.questions
  };
}

async function generateQuestions(
  context: StaticContext,
  fallback: AnalysisResult
): Promise<Pick<AnalysisResult, "ai" | "questions">> {
  const signals = extractCodeSignals(context.contextFiles, context.focus);
  const prompt = `Return Korean JSON only.
Create exactly 5 repo-specific code understanding questions.
Return a single valid JSON object. Do not include markdown fences, comments, or any text outside JSON.
The top-level object must have exactly one key: "questions".
Each question must be under 70 Korean characters.
Each relatedFiles array must contain exactly 1 path.
Do not use backticks. Do not quote code. Do not list examples.
Each question must mention one concrete file path or symbol name from the code signals.
Prefer runtime source files over test files. Do not base questions primarily on __tests__, .test.*, or .spec.* files unless asking about testing.
If 분석 관점 is 프론트엔드 중심, questions must focus on UI, page, component, route, client state, and frontend data flow.
If 분석 관점 is 백엔드 중심, questions must focus on API, service, domain, persistence, auth, and server data flow.
For 프론트엔드 중심, do not make backend, service, repository, entity, or server config files the main subject.
For 백엔드 중심, do not make UI, page, component, CSS, or styling files the main subject.
Use five different main files if possible. Cover at least 3 different modules or folders.
Ask at most one question about auth, security, login, token, or permission unless the repository only contains that domain.
Follow the question plan exactly.
If 관심 기능 is not 전체 기능, prioritize those features when choosing files and questions.
Do not invent files or behavior just to match 관심 기능. If matching code is weak, ask about the closest concrete files.

Repository: ${context.repo.url}
분석 관점: ${formatFocus(context.focus)}
관심 기능: ${formatQuestionTargets(context.questionTargets)}
Question plan:
${buildQuestionPlan(context.focus)}

Code signal candidates:
${formatQuestionSignalBuckets(signals, context.focus)}

Important files:
${context.contextFiles.map(formatFileForPrompt).join("\n\n")}

Return this exact JSON shape:
{
  "questions": [
    {"id":"q1","type":"구조 이해","question":"string","relatedFiles":["string"]},
    {"id":"q2","type":"요청 흐름","question":"string","relatedFiles":["string"]},
    {"id":"q3","type":"데이터 흐름","question":"string","relatedFiles":["string"]},
    {"id":"q4","type":"변경 영향도","question":"string","relatedFiles":["string"]},
    {"id":"q5","type":"면접형","question":"string","relatedFiles":["string"]}
  ]
}`;

  const providerResult = await callConfiguredProvider(
    prompt,
    900,
    buildQuestionsResponseSchema()
  );
  const raw = providerResult.text;
  if (!raw) {
    return { ai: providerResult.usage, questions: fallback.questions };
  }

  const parsed = normalizeQuestionsPayload(parseJsonObject(raw));

  if (!Array.isArray(parsed?.questions)) {
    console.warn("[KnowYourCode] Failed to parse questions JSON", {
      length: raw.length,
      preview: raw.slice(0, 800),
      tail: raw.slice(-400)
    });

    return {
      ai: {
        ...providerResult.usage,
        used: false,
        reason: "LLM 질문 JSON을 해석하지 못해 기본 질문으로 대체했습니다."
      },
      questions: fallback.questions
    };
  }

  return {
    ai: providerResult.usage,
    questions: normalizeQuestions(parsed.questions, fallback.questions)
  };
}

async function generateReport(
  context: StaticContext,
  fallback: AnalysisResult
): Promise<Pick<AnalysisResult, "ai" | "report">> {
  const prompt = `Return Korean JSON only.
Create a concise project understanding report.
Return a single valid JSON object. Do not include markdown fences, comments, or any text outside JSON.
The top-level object must have exactly one key: "report".
Do not quote code. Never include source code excerpts in the output.
Every array must contain at most 4 items.
oneLineSummary, requestFlow, and dataFlow must be under 100 Korean characters each.
If 분석 관점 is 프론트엔드 중심, report must prioritize UI, routing, page/component structure, and client data flow.
If 분석 관점 is 백엔드 중심, report must prioritize API, service/domain logic, persistence, auth, and server data flow.
Do not make the opposite side the main report subject unless the selected side has no meaningful files.
If 관심 기능 is not 전체 기능, mention those features only when there is code evidence in the provided files.

Repository: ${context.repo.url}
분석 관점: ${formatFocus(context.focus)}
관심 기능: ${formatQuestionTargets(context.questionTargets)}
File count analyzed: ${context.fileCount}
Folder tree:
${context.tree.slice(0, 14).map((item) => `- ${item}`).join("\n")}

Code signals:
${formatSignalsForPrompt(extractCodeSignals(context.contextFiles, context.focus).slice(0, 18))}

Return this exact JSON shape:
{
  "report": {
    "oneLineSummary": "string",
    "techStack": ["string"],
    "folderStructure": ["string"],
    "coreFeatures": ["string"],
    "requestFlow": "string",
    "dataFlow": "string",
    "keyFiles": [{"path":"string","reason":"string"}],
    "difficulty": "쉬움|보통|어려움",
    "riskyQuestions": ["string"]
  }
}`;

  const providerResult = await callConfiguredProvider(
    prompt,
    ANALYSIS_OUTPUT_TOKENS,
    buildReportResponseSchema()
  );
  const raw = providerResult.text;
  if (!raw) {
    return { ai: providerResult.usage, report: fallback.report };
  }

  const parsed = normalizeReportPayload(parseJsonObject(raw));

  if (!parsed?.report) {
    console.warn("[KnowYourCode] Failed to parse report JSON", {
      length: raw.length,
      preview: raw.slice(0, 800),
      tail: raw.slice(-400)
    });

    return {
      ai: {
        ...providerResult.usage,
        used: false,
        reason: "LLM 리포트 JSON을 해석하지 못해 기본 리포트로 대체했습니다."
      },
      report: fallback.report
    };
  }

  return {
    ai: providerResult.usage,
    report: {
      ...fallback.report,
      ...parsed.report,
      keyFiles: normalizeKeyFiles(parsed.report.keyFiles, fallback.contextFiles)
    }
  };
}

function normalizeQuestionsPayload(input: unknown): Partial<{ questions: UnderstandingQuestion[] }> | null {
  const parsed = parseNestedJson(input);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.questions) {
    return record as Partial<{ questions: UnderstandingQuestion[] }>;
  }

  for (const key of ["analysis", "result", "data", "response"]) {
    const nested = parseNestedJson(record[key]);
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRecord = nested as Record<string, unknown>;
      if (nestedRecord.questions) {
        return nestedRecord as Partial<{ questions: UnderstandingQuestion[] }>;
      }
    }
  }

  return null;
}

function normalizeReportPayload(input: unknown): Partial<{ report: ProjectReport }> | null {
  const parsed = parseNestedJson(input);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.report) {
    return record as Partial<{ report: ProjectReport }>;
  }

  for (const key of ["analysis", "result", "data", "response"]) {
    const nested = parseNestedJson(record[key]);
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRecord = nested as Record<string, unknown>;
      if (nestedRecord.report) {
        return nestedRecord as Partial<{ report: ProjectReport }>;
      }
    }
  }

  return null;
}

export async function evaluateAnswer(input: {
  analysis: AnalysisResult;
  questionId: string;
  answer: string;
}): Promise<EvaluationResult> {
  const question = input.analysis.questions.find((item) => item.id === input.questionId);
  if (!question) {
    throw new Error("평가할 질문을 찾을 수 없습니다.");
  }

  const relatedFiles = pickRelatedFiles(
    input.analysis.contextFiles,
    question.relatedFiles,
    `${question.question}\n${input.answer}`
  );
  const fallback = buildFallbackEvaluation(input.answer, question.relatedFiles);

  const prompt = `You are KnowYourCode, evaluating whether a user understands their own code.
Evaluate in Korean and return JSON only.
Keep the response concise. Do not quote code. Do not include markdown.
Evaluate based on concrete code evidence, not general plausibility.
Separate these dimensions: file/symbol accuracy, request or data flow accuracy, change impact awareness, and interview readiness.
If the user honestly says they do not know, give partial credit for honesty but identify exactly what code they should inspect next.

Project summary:
${input.analysis.report.oneLineSummary}

Question:
${question.question}

User answer:
${input.answer}

Relevant code excerpts:
${relatedFiles.map(formatFileForPrompt).join("\n\n")}

Return this exact JSON shape:
{
  "score": 0,
  "scoreReason": "string",
  "understood": ["string"],
  "missing": ["string"],
  "incorrect": ["string"],
  "relatedFiles": ["string"],
  "reviewCode": ["string"],
  "betterAnswer": "string",
  "interviewAnswerDirection": "string",
  "followUpQuestion": "string"
}
Score must be an integer from 0 to 100.
scoreReason must be one concise Korean sentence.
reviewCode must list 1 to 4 concrete file paths or symbols to revisit.
betterAnswer should be a better project-code explanation, not a generic study tip.
interviewAnswerDirection should explain how to answer this in a developer interview.`;

  const providerResult = await callConfiguredProvider(
    prompt,
    EVALUATION_OUTPUT_TOKENS,
    buildEvaluationResponseSchema()
  );
  const raw = providerResult.text;
  if (!raw) return fallback;

  const parsed = parseJsonObject(raw) as Partial<EvaluationResult> | null;
  if (!parsed) return fallback;

  return {
    score: clampScore(parsed.score),
    scoreReason: parsed.scoreReason || fallback.scoreReason,
    understood: normalizeStringArray(parsed.understood, fallback.understood),
    missing: normalizeStringArray(parsed.missing, fallback.missing),
    incorrect: normalizeStringArray(parsed.incorrect, fallback.incorrect),
    relatedFiles: normalizeStringArray(parsed.relatedFiles, fallback.relatedFiles),
    reviewCode: normalizeStringArray(parsed.reviewCode, fallback.reviewCode),
    betterAnswer: parsed.betterAnswer || fallback.betterAnswer,
    interviewAnswerDirection: parsed.interviewAnswerDirection || fallback.interviewAnswerDirection,
    followUpQuestion: parsed.followUpQuestion || fallback.followUpQuestion
  };
}

async function callConfiguredProvider(
  prompt: string,
  maxOutputTokens: number,
  responseSchema: Record<string, unknown>
): Promise<ProviderResult> {
  const provider = (process.env.AI_PROVIDER || "").toLowerCase();

  if (provider === "gemini" || (!provider && process.env.GEMINI_API_KEY)) {
    const geminiResult = await callGemini(prompt, maxOutputTokens, responseSchema);
    if (!geminiResult.text && geminiResult.retryable && process.env.GROQ_API_KEY) {
      const groqResult = await callGroq(prompt, maxOutputTokens);
      if (groqResult.text) return groqResult;
      return {
        ...geminiResult,
        usage: {
          ...geminiResult.usage,
          reason: `${geminiResult.usage.reason} Groq 자동 대체 실패: ${groqResult.usage.reason}`
        }
      };
    }
    return geminiResult;
  }

  if (provider === "groq" || (!provider && process.env.GROQ_API_KEY)) {
    return callGroq(prompt, maxOutputTokens);
  }

  if (provider && provider !== "mock") {
    return {
      text: null,
      usage: {
        provider: "fallback",
        used: false,
        reason: `지원하지 않는 AI_PROVIDER 값입니다: ${provider}`
      }
    };
  }

  return {
    text: null,
    usage: {
      provider: "fallback",
      used: false,
      reason: "AI_PROVIDER가 mock이거나 API 키가 없어 기본 분석을 사용했습니다."
    }
  };
}

async function callGemini(
  prompt: string,
  maxOutputTokens: number,
  responseSchema: Record<string, unknown>
): Promise<ProviderResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return {
      text: null,
      usage: { provider: "gemini", used: false, reason: "GEMINI_API_KEY가 없습니다." }
    };
  }

  try {
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const response = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema,
            maxOutputTokens
          }
        })
      },
      2
    );

    if (!response.ok) {
      const retryable = isRetryableStatus(response.status);
      return {
        text: null,
        retryable,
        usage: {
          provider: "gemini",
          used: false,
          reason: `Gemini API 호출 실패 (${response.status}, model: ${model})`
        }
      };
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;

    return {
      text,
      usage: text
        ? { provider: "gemini", used: true }
        : { provider: "gemini", used: false, reason: "Gemini 응답에 텍스트가 없습니다." }
    };
  } catch (error) {
    return {
      text: null,
      retryable: true,
      usage: {
        provider: "gemini",
        used: false,
        reason: error instanceof Error ? error.message : "Gemini API 호출 중 오류가 발생했습니다."
      }
    };
  }
}

async function fetchWithRetry(url: string, init: RequestInit, retries: number): Promise<Response> {
  let response = await fetch(url, init);

  for (let attempt = 0; attempt < retries && isRetryableStatus(response.status); attempt += 1) {
    await sleep(500 * (attempt + 1));
    response = await fetch(url, init);
  }

  return response;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGroq(prompt: string, maxOutputTokens: number): Promise<ProviderResult> {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return {
      text: null,
      usage: { provider: "groq", used: false, reason: "GROQ_API_KEY가 없습니다." }
    };
  }

  try {
    const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      return {
        text: null,
        usage: {
          provider: "groq",
          used: false,
          reason: `Groq API 호출 실패 (${response.status}, model: ${model})`
        }
      };
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content ?? null;

    return {
      text,
      usage: text
        ? { provider: "groq", used: true }
        : { provider: "groq", used: false, reason: "Groq 응답에 텍스트가 없습니다." }
    };
  } catch (error) {
    return {
      text: null,
      usage: {
        provider: "groq",
        used: false,
        reason: error instanceof Error ? error.message : "Groq API 호출 중 오류가 발생했습니다."
      }
    };
  }
}

function formatFileForPrompt(file: FileSummary): string {
  return `Path: ${file.path}
Reason: ${file.reason}
Excerpt:
\`\`\`
${file.excerpt.slice(0, 700)}
\`\`\``;
}

function parseJsonObject(raw: string): unknown | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function parseNestedJson(input: unknown): unknown | null {
  if (typeof input !== "string") return input ?? null;
  return parseJsonObject(input);
}

function buildQuestionsResponseSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    required: ["questions"],
    properties: {
      questions: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          required: ["id", "type", "question", "relatedFiles"],
          properties: {
            id: { type: "STRING" },
            type: { type: "STRING", enum: ["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"] },
            question: { type: "STRING" },
            relatedFiles: { type: "ARRAY", items: { type: "STRING" } }
          }
        }
      }
    }
  };
}

function buildReportResponseSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    required: ["report"],
    properties: {
      report: {
        type: "OBJECT",
        required: [
          "oneLineSummary",
          "techStack",
          "folderStructure",
          "coreFeatures",
          "requestFlow",
          "dataFlow",
          "keyFiles",
          "difficulty",
          "riskyQuestions"
        ],
        properties: {
          oneLineSummary: { type: "STRING" },
          techStack: { type: "ARRAY", items: { type: "STRING" } },
          folderStructure: { type: "ARRAY", items: { type: "STRING" } },
          coreFeatures: { type: "ARRAY", items: { type: "STRING" } },
          requestFlow: { type: "STRING" },
          dataFlow: { type: "STRING" },
          keyFiles: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              required: ["path", "reason"],
              properties: {
                path: { type: "STRING" },
                reason: { type: "STRING" }
              }
            }
          },
          difficulty: { type: "STRING", enum: ["쉬움", "보통", "어려움"] },
          riskyQuestions: { type: "ARRAY", items: { type: "STRING" } }
        }
      }
    }
  };
}

function buildEvaluationResponseSchema(): Record<string, unknown> {
  return {
    type: "OBJECT",
    required: [
      "score",
      "scoreReason",
      "understood",
      "missing",
      "incorrect",
      "relatedFiles",
      "reviewCode",
      "betterAnswer",
      "interviewAnswerDirection",
      "followUpQuestion"
    ],
    properties: {
      score: { type: "NUMBER" },
      scoreReason: { type: "STRING" },
      understood: { type: "ARRAY", items: { type: "STRING" } },
      missing: { type: "ARRAY", items: { type: "STRING" } },
      incorrect: { type: "ARRAY", items: { type: "STRING" } },
      relatedFiles: { type: "ARRAY", items: { type: "STRING" } },
      reviewCode: { type: "ARRAY", items: { type: "STRING" } },
      betterAnswer: { type: "STRING" },
      interviewAnswerDirection: { type: "STRING" },
      followUpQuestion: { type: "STRING" }
    }
  };
}

function normalizeKeyFiles(input: FileSummary[] | undefined, fallback: FileSummary[]): FileSummary[] {
  if (!Array.isArray(input) || !input.length) return fallback.slice(0, 6);
  return input.slice(0, 8).map((file) => ({
    path: file.path || "unknown",
    reason: file.reason || "핵심 파일",
    excerpt: fallback.find((fallbackFile) => fallbackFile.path === file.path)?.excerpt || ""
  }));
}

function normalizeQuestions(
  input: UnderstandingQuestion[] | undefined,
  fallback: UnderstandingQuestion[]
): UnderstandingQuestion[] {
  if (!Array.isArray(input) || input.length < 5) return fallback;
  const allowedTypes = new Set(["구조 이해", "요청 흐름", "데이터 흐름", "변경 영향도", "면접형"]);
  const fallbackFiles = fallback.flatMap((question) => question.relatedFiles);

  return input.slice(0, 5).map((question, index) => ({
    id: question.id || `q${index + 1}`,
    type: allowedTypes.has(question.type) ? question.type : fallback[index]?.type ?? "구조 이해",
    question: question.question || fallback[index]?.question || "프로젝트 구조를 설명해주세요.",
    relatedFiles: normalizeRelatedFiles(question.relatedFiles, fallbackFiles)
  }));
}

function normalizeRelatedFiles(input: unknown, fallbackFiles: string[]): string[] {
  if (!Array.isArray(input)) return fallbackFiles.slice(0, 3);
  const files = input.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return files.length ? files.slice(0, 2) : fallbackFiles.slice(0, 2);
}

function pickRelatedFiles(files: FileSummary[], relatedPaths: string[], searchText: string): FileSummary[] {
  const queryTerms = extractSearchTerms(searchText);
  const scored = files
    .map((file) => ({
      file,
      score: scoreRelatedFile(file, relatedPaths, queryTerms)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.file);

  return dedupeFiles([...scored, ...files]).slice(0, 8);
}

function scoreRelatedFile(file: FileSummary, relatedPaths: string[], queryTerms: string[]): number {
  let score = 0;

  if (relatedPaths.includes(file.path)) score += 80;
  if (relatedPaths.some((path) => file.path.includes(path) || path.includes(file.path))) score += 40;

  const haystack = `${file.path}\n${file.reason}\n${file.excerpt}`.toLowerCase();
  for (const term of queryTerms) {
    if (file.path.toLowerCase().includes(term)) score += 12;
    if (haystack.includes(term)) score += 4;
  }

  return score;
}

function extractSearchTerms(input: string): string[] {
  const terms = input
    .toLowerCase()
    .match(/[a-z0-9_./-]{3,}|[가-힣]{2,}/g);

  if (!terms) return [];

  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "어떤",
    "설명",
    "파일",
    "프로젝트",
    "흐름",
    "코드"
  ]);

  return [...new Set(terms.filter((term) => !stopWords.has(term)))].slice(0, 24);
}

function dedupeFiles(files: FileSummary[]): FileSummary[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function buildFallbackEvaluation(answer: string, relatedFiles: string[]): EvaluationResult {
  const hasSpecifics = answer.length > 120 && /파일|함수|컴포넌트|API|route|page|src|app/i.test(answer);

  return {
    score: hasSpecifics ? 68 : 42,
    scoreReason: hasSpecifics
      ? "관련 파일을 언급했지만 코드 흐름과 영향 범위 설명은 더 구체화할 필요가 있습니다."
      : "답변이 일반적이라 실제 코드 근거를 충분히 확인하기 어렵습니다.",
    understood: hasSpecifics
      ? ["코드 구조나 관련 파일을 언급하려는 방향은 좋습니다."]
      : ["질문에 대한 답변 의도는 확인됩니다."],
    missing: [
      "실제 파일명과 코드 흐름을 더 구체적으로 연결해야 합니다.",
      "수정 영향 범위나 예외 처리 지점을 함께 설명하면 답변 신뢰도가 올라갑니다."
    ],
    incorrect: [],
    relatedFiles,
    reviewCode: relatedFiles.slice(0, 4),
    betterAnswer:
      "관련 파일의 역할을 먼저 짚고, 요청 또는 데이터가 어떤 순서로 이동하는지 설명한 뒤, 수정 시 함께 확인해야 할 파일을 연결해서 답변하는 것이 좋습니다.",
    interviewAnswerDirection:
      "면접에서는 파일명을 먼저 제시한 뒤, 진입점, 처리 흐름, 수정 시 영향 범위를 순서대로 설명하면 답변 신뢰도가 높아집니다.",
    followUpQuestion: "방금 설명한 흐름에서 가장 먼저 실행되는 파일은 무엇이고, 그 근거는 코드의 어느 부분인가요?"
  };
}

function clampScore(score: unknown): number {
  if (typeof score !== "number" || Number.isNaN(score)) return 50;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeStringArray(input: unknown, fallback: string[]): string[] {
  if (!Array.isArray(input)) return fallback;
  const values = input.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length ? values : fallback;
}
