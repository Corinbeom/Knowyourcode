import type { AnalysisResult, CodeEvidence, QuestionType, UnderstandingQuestion } from "./types";

export function sanitizeRepoAnalysis(analysis: AnalysisResult): AnalysisResult {
  const evidence = analysis.evidenceSnippets ?? [];
  if (!evidence.length) return analysis;

  return {
    ...analysis,
    questions: analysis.questions.map((question, index) =>
      isQuestionAllowed(question, evidence) ? question : buildQuestionFromEvidence(question, evidence, index)
    )
  };
}

function isQuestionAllowed(question: UnderstandingQuestion, allEvidence: CodeEvidence[]): boolean {
  const snippets = question.evidenceSnippets ?? [];
  if (!snippets.length) return false;

  const primaryPath = firstQuestionPath(question);
  const hasBetter = hasBetterFlowEvidence(allEvidence);

  if (question.type === "요청 흐름") {
    if (primaryPath && (isConfigLikePath(primaryPath) || isContractLikePath(primaryPath)) && hasBetter) return false;
    if (/config\.py의\s*요청\s*처리\s*코드/.test(question.question)) return false;
    return snippets.some(supportsRequestFlowEvidence) && snippets.some((snippet) => snippet.kind === "entry");
  }

  if (question.type === "데이터 흐름") {
    const hasStrongDataEvidence = allEvidence.some(supportsStrongDataFlowEvidence);
    return hasStrongDataEvidence ? snippets.some(supportsStrongDataFlowEvidence) : snippets.some(supportsDataFlowEvidence);
  }

  if (question.type === "변경 영향도") {
    if (primaryPath && (isConfigLikePath(primaryPath) || isContractLikePath(primaryPath)) && hasBetter) return false;
    if (hasWeakContractUiPair(snippets) && hasBetter) return false;
    if (hasWeakServiceUiPair(snippets) && hasBetter) return false;
    return true;
  }

  if (question.type === "면접형") {
    if (primaryPath && isConfigLikePath(primaryPath) && hasBetter) return false;
    if (hasWeakConfigUiPair(snippets) && hasBetter) return false;
    if (snippets.some((snippet) => isMaintenanceLikePath(snippet.path)) && hasNonMaintenanceEvidence(allEvidence)) return false;
  }

  return true;
}

function buildQuestionFromEvidence(question: UnderstandingQuestion, evidence: CodeEvidence[], index: number): UnderstandingQuestion {
  const type = question.type;
  const selected = selectEvidenceForType(type, evidence);
  const relatedFiles = evidencePaths(selected);
  const primaryPath = relatedFiles[0] ?? question.relatedFiles[0] ?? "핵심 파일";
  const secondaryPath = relatedFiles[1] ?? primaryPath;

  return {
    id: question.id || `q${index + 1}`,
    type,
    question: buildQuestionText(type, primaryPath, secondaryPath),
    relatedFiles,
    evidenceSnippets: selected
  };
}

function selectEvidenceForType(type: QuestionType, evidence: CodeEvidence[]): CodeEvidence[] {
  if (type === "요청 흐름") {
    return selectLayered(
      evidence.filter((snippet) => !isConfigLikePath(snippet.path) && !isContractLikePath(snippet.path) && (supportsRequestFlowEvidence(snippet) || snippet.kind === "service")),
      ["entry", "service"],
      3
    );
  }
  if (type === "데이터 흐름") {
    const strongDataEvidence = evidence.filter(supportsStrongDataFlowEvidence);
    return selectLayered(strongDataEvidence.length ? strongDataEvidence : evidence.filter(supportsDataFlowEvidence), ["data", "service", "entry"], 3);
  }
  if (type === "변경 영향도") {
    const impactEvidence = evidence.filter(
      (snippet) =>
        !isConfigLikePath(snippet.path)
        && !isContractLikePath(snippet.path)
        && !isMaintenanceLikePath(snippet.path)
        && snippet.kind !== "ui"
    );
    return selectLayered(
      impactEvidence.length ? impactEvidence : evidence.filter((snippet) => !isConfigLikePath(snippet.path) && !isContractLikePath(snippet.path) && snippet.kind !== "ui"),
      ["service", "entry", "data"],
      3
    );
  }
  if (type === "면접형") {
    const interviewEvidence = evidence.filter(
      (snippet) => ["service", "entry", "data"].includes(snippet.kind) && !isConfigLikePath(snippet.path) && !isMaintenanceLikePath(snippet.path)
    );
    return selectLayered(
      interviewEvidence.length ? interviewEvidence : evidence.filter((snippet) => ["service", "entry", "data"].includes(snippet.kind) && !isConfigLikePath(snippet.path)),
      ["service", "entry", "data"],
      3
    );
  }
  return selectLayered(evidence, ["entry", "service", "ui", "config"], 1);
}

function buildQuestionText(type: QuestionType, primaryPath: string, secondaryPath: string): string {
  if (type === "요청 흐름") {
    return `${primaryPath}의 요청 처리 코드가 ${secondaryPath}와 어떻게 연결되는지 설명해주세요.`;
  }
  if (type === "데이터 흐름") {
    return `${primaryPath}에서 데이터 수집, 검증 또는 변환 흐름이 어떻게 드러나는지 설명해주세요.`;
  }
  if (type === "변경 영향도") {
    return `${primaryPath}의 동작을 수정할 때 ${secondaryPath}까지 어떤 영향이 이어질 수 있나요?`;
  }
  if (type === "면접형") {
    return `면접이나 코드리뷰에서 ${primaryPath}의 설계 의도와 위험 지점을 어떻게 설명하겠습니까?`;
  }
  return `${primaryPath}의 역할을 기준으로 이 프로젝트의 주요 구조를 설명해주세요.`;
}

function selectLayered(evidence: CodeEvidence[], layers: string[], limit: number): CodeEvidence[] {
  const selected: CodeEvidence[] = [];
  for (const layer of layers) {
    const snippet = evidence.find((candidate) => candidate.kind === layer && !selected.includes(candidate));
    if (snippet) selected.push(snippet);
    if (selected.length >= limit) return selected;
  }
  for (const snippet of evidence) {
    if (!selected.includes(snippet)) selected.push(snippet);
    if (selected.length >= limit) break;
  }
  return selected;
}

function firstQuestionPath(question: UnderstandingQuestion): string | undefined {
  return extractQuestionPaths(question.question)[0] ?? question.relatedFiles[0];
}

function extractQuestionPaths(text: string): string[] {
  const matches = text.match(/(?:apps?|src|lib|pages|components|api|app|server|client|tests?)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|java|kt|go|rs|json|yml|yaml)/g);
  return [...new Set(matches ?? [])];
}

function evidencePaths(evidence: CodeEvidence[]): string[] {
  return [...new Set(evidence.map((snippet) => snippet.path).filter(Boolean))];
}

function isConfigLikePath(path: string): boolean {
  return /(^|\/)(package\.json|[^/]*config[^/]*|settings\.(?:gradle|json)|application\.(?:yml|yaml|properties)|Dockerfile)$|\.config\./i.test(path);
}

function isContractLikePath(path: string): boolean {
  return /(^|\/)(schemas?|models?|entities?|dto|types?)(\/|$)|(?:schema|model|entity|dto|types?)\./i.test(path);
}

function hasBetterFlowEvidence(evidence: CodeEvidence[]): boolean {
  return evidence.some((snippet) => ["entry", "service", "data"].includes(snippet.kind) && !isConfigLikePath(snippet.path));
}

function hasNonMaintenanceEvidence(evidence: CodeEvidence[]): boolean {
  return evidence.some((snippet) => ["entry", "service", "data"].includes(snippet.kind) && !isConfigLikePath(snippet.path) && !isMaintenanceLikePath(snippet.path));
}

function supportsRequestFlowEvidence(snippet: CodeEvidence): boolean {
  const text = `${snippet.path}\n${snippet.title}\n${snippet.excerpt}`;
  if (snippet.kind === "config" && /package\.json|config|env|settings|docker/i.test(snippet.path)) return false;
  return isEntrypointPath(snippet.path)
    || /\b(GET|POST|PUT|PATCH|DELETE|Request|Response|APIRouter|FastAPI|fetch\w*|urlopen|axios|NextRequest|NextResponse)\b/i.test(text);
}

function isEntrypointPath(path: string): boolean {
  return /(^|\/)(app\/api|src\/app\/api|pages\/api|routes?|controllers?|endpoints?)\/.+\.(py|ts|tsx|js|jsx|java|kt|go|rs)$/i.test(path)
    || /(^|\/)(route|router|controller|handler)\.(py|ts|tsx|js|jsx)$/i.test(path)
    || /(^|\/)[A-Za-z0-9_.-]*(route|router|controller|handler|endpoint)[A-Za-z0-9_.-]*\.(py|ts|tsx|js|jsx|java|kt|go|rs)$/i.test(path);
}

function supportsDataFlowEvidence(snippet: CodeEvidence): boolean {
  const text = `${snippet.path}\n${snippet.title}\n${snippet.excerpt}`;
  if (snippet.kind === "config") return false;
  if (/tally|analytics|track\(/i.test(text) && !/\b(fetch|axios|save|query|repository|database|request\.json|FormData|localStorage)\b/i.test(text)) return false;
  return ["data", "service", "entry"].includes(snippet.kind)
    && /\b(schema|model|repository|entity|database|query\w*|save\w*|create\w*|update\w*|delete\w*|find\w*|fetch\w*|parse\w*|validate\w*|request\.json|response\.json|json\.loads|FormData|localStorage|EXCLUDED_DIRS|EXCLUDED_FILES)\b/i.test(text);
}

function supportsStrongDataFlowEvidence(snippet: CodeEvidence): boolean {
  if (!supportsDataFlowEvidence(snippet)) return false;
  const text = `${snippet.path}\n${snippet.title}\n${snippet.excerpt}`;
  if (isConstantOnlyEvidence(text)) return false;
  return /\b(query\w*|save\w*|create\w*|update\w*|delete\w*|find\w*|fetch\w*|parse\w*|validate\w*|filter\w*|map\w*|request\.json|response\.json|json\.loads|FormData|localStorage)\b/i.test(text);
}

function isConstantOnlyEvidence(text: string): boolean {
  return /\b(dimension|dimensions|embedding|vector|pgvector|MAX_[A-Z0-9_]+|[A-Z0-9_]{4,})\b/i.test(text)
    && !/\b(function|def |class |return|if |for |while |query\w*|save\w*|fetch\w*|parse\w*|validate\w*|filter\w*|map\w*)\b/i.test(text);
}

function isMaintenanceLikePath(path: string): boolean {
  return /(fixer|repair|migration|constraint|patch|backfill|seed|script|maintenance|cleanup)/i.test(path);
}

function hasWeakContractUiPair(snippets: CodeEvidence[]): boolean {
  return snippets.some((snippet) => snippet.kind === "data" && isContractLikePath(snippet.path))
    && snippets.some((snippet) => snippet.kind === "ui")
    && !snippets.some((snippet) => ["entry", "service"].includes(snippet.kind));
}

function hasWeakConfigUiPair(snippets: CodeEvidence[]): boolean {
  return snippets.some((snippet) => snippet.kind === "config")
    && snippets.some((snippet) => snippet.kind === "ui" && /tally|feedback|button|component/i.test(snippet.path))
    && !snippets.some((snippet) => ["entry", "service", "data"].includes(snippet.kind));
}

function hasWeakServiceUiPair(snippets: CodeEvidence[]): boolean {
  const hasService = snippets.some((snippet) => snippet.kind === "service");
  const uiSnippets = snippets.filter((snippet) => snippet.kind === "ui");
  if (!hasService || !uiSnippets.length) return false;
  if (snippets.some((snippet) => snippet.kind === "entry" && supportsRequestFlowEvidence(snippet))) return false;

  const combinedText = snippets.map((snippet) => `${snippet.path}\n${snippet.title}\n${snippet.excerpt}`).join("\n");
  return !uiSnippets.some((uiSnippet) => {
    const basename = uiSnippet.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    return Boolean(basename && new RegExp(basename.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i").test(combinedText));
  });
}
