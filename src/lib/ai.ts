import type {
  AiUsage,
  AnalysisResult,
  EvaluationResult,
  FileSummary,
  ProjectReport,
  RepoInfo,
  UnderstandingQuestion
} from "./types";
import { extractCodeSignals, formatSignalsForPrompt } from "./code-signals";

type StaticContext = {
  repo: RepoInfo;
  fileCount: number;
  contextFiles: FileSummary[];
  tree: string[];
  packageInfo: Record<string, unknown> | null;
};

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";
const ANALYSIS_OUTPUT_TOKENS = Number(process.env.ANALYSIS_OUTPUT_TOKENS ?? 2400);
const EVALUATION_OUTPUT_TOKENS = Number(process.env.EVALUATION_OUTPUT_TOKENS ?? 1200);

type ProviderResult = {
  text: string | null;
  usage: AiUsage;
};

export async function generateAnalysis(
  context: StaticContext,
  fallback: AnalysisResult
): Promise<AnalysisResult> {
  const prompt = `You are KnowYourCode, an AI code understanding evaluator.
Analyze this public GitHub repository and return Korean JSON only.
Keep the response concise. Do not quote code. Do not include markdown.
Every generated question must mention at least one concrete file path or symbol name from the code signals.

Repository: ${context.repo.url}
File count analyzed: ${context.fileCount}
Folder tree:
${context.tree.map((item) => `- ${item}`).join("\n")}

Code signals:
${formatSignalsForPrompt(extractCodeSignals(context.contextFiles))}

Important files:
${context.contextFiles.map(formatFileForPrompt).join("\n\n")}

Return this exact JSON shape:
{
  "report": {
    "oneLineSummary": "string",
    "techStack": ["string"],
    "folderStructure": ["string"],
    "coreFeatures": ["string"],
    "requestFlow": "string",
    "dataFlow": "string",
    "keyFiles": [{"path":"string","reason":"string","excerpt":""}],
    "difficulty": "쉬움|보통|어려움",
    "riskyQuestions": ["string"]
  },
  "questions": [
    {"id":"q1","type":"구조 이해","question":"string","relatedFiles":["string"]},
    {"id":"q2","type":"요청 흐름","question":"string","relatedFiles":["string"]},
    {"id":"q3","type":"데이터 흐름","question":"string","relatedFiles":["string"]},
    {"id":"q4","type":"변경 영향도","question":"string","relatedFiles":["string"]},
    {"id":"q5","type":"면접형","question":"string","relatedFiles":["string"]}
  ]
}`;

  const providerResult = await callConfiguredProvider(prompt, ANALYSIS_OUTPUT_TOKENS);
  const raw = providerResult.text;
  if (!raw) {
    return {
      ...fallback,
      ai: providerResult.usage
    };
  }

  const parsed = parseJsonObject(raw) as Partial<{
    report: ProjectReport;
    questions: UnderstandingQuestion[];
  }> | null;

  if (!parsed?.report || !Array.isArray(parsed.questions)) {
    return {
      ...fallback,
      ai: {
        ...providerResult.usage,
        used: false,
        reason: "LLM 응답을 JSON 형식으로 해석하지 못해 기본 분석으로 대체했습니다."
      }
    };
  }

  return {
    ...fallback,
    ai: providerResult.usage,
    report: {
      ...fallback.report,
      ...parsed.report,
      keyFiles: normalizeKeyFiles(parsed.report.keyFiles, fallback.contextFiles)
    },
    questions: normalizeQuestions(parsed.questions, fallback.questions)
  };
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
  "understood": ["string"],
  "missing": ["string"],
  "incorrect": ["string"],
  "relatedFiles": ["string"],
  "betterAnswer": "string",
  "followUpQuestion": "string"
}
Score must be an integer from 0 to 100.`;

  const providerResult = await callConfiguredProvider(prompt, EVALUATION_OUTPUT_TOKENS);
  const raw = providerResult.text;
  if (!raw) return fallback;

  const parsed = parseJsonObject(raw) as Partial<EvaluationResult> | null;
  if (!parsed) return fallback;

  return {
    score: clampScore(parsed.score),
    understood: normalizeStringArray(parsed.understood, fallback.understood),
    missing: normalizeStringArray(parsed.missing, fallback.missing),
    incorrect: normalizeStringArray(parsed.incorrect, fallback.incorrect),
    relatedFiles: normalizeStringArray(parsed.relatedFiles, fallback.relatedFiles),
    betterAnswer: parsed.betterAnswer || fallback.betterAnswer,
    followUpQuestion: parsed.followUpQuestion || fallback.followUpQuestion
  };
}

async function callConfiguredProvider(prompt: string, maxOutputTokens: number): Promise<ProviderResult> {
  const provider = (process.env.AI_PROVIDER || "").toLowerCase();

  if (provider === "gemini" || (!provider && process.env.GEMINI_API_KEY)) {
    return callGemini(prompt, maxOutputTokens);
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

async function callGemini(prompt: string, maxOutputTokens: number): Promise<ProviderResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return {
      text: null,
      usage: { provider: "gemini", used: false, reason: "GEMINI_API_KEY가 없습니다." }
    };
  }

  try {
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            maxOutputTokens
          }
        })
      }
    );

    if (!response.ok) {
      return {
        text: null,
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
      usage: {
        provider: "gemini",
        used: false,
        reason: error instanceof Error ? error.message : "Gemini API 호출 중 오류가 발생했습니다."
      }
    };
  }
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
${file.excerpt.slice(0, 1800)}
\`\`\``;
}

function parseJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
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

function normalizeKeyFiles(input: FileSummary[] | undefined, fallback: FileSummary[]): FileSummary[] {
  if (!Array.isArray(input) || !input.length) return fallback.slice(0, 6);
  return input.slice(0, 8).map((file) => ({
    path: file.path || "unknown",
    reason: file.reason || "핵심 파일",
    excerpt: file.excerpt || ""
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
  return files.length ? files.slice(0, 5) : fallbackFiles.slice(0, 3);
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
    understood: hasSpecifics
      ? ["코드 구조나 관련 파일을 언급하려는 방향은 좋습니다."]
      : ["질문에 대한 답변 의도는 확인됩니다."],
    missing: [
      "실제 파일명과 코드 흐름을 더 구체적으로 연결해야 합니다.",
      "수정 영향 범위나 예외 처리 지점을 함께 설명하면 답변 신뢰도가 올라갑니다."
    ],
    incorrect: [],
    relatedFiles,
    betterAnswer:
      "관련 파일의 역할을 먼저 짚고, 요청 또는 데이터가 어떤 순서로 이동하는지 설명한 뒤, 수정 시 함께 확인해야 할 파일을 연결해서 답변하는 것이 좋습니다.",
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
