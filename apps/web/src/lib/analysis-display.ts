export function repoAnalysisTitle(value: string): string {
  const parts = githubPathParts(value);
  return parts.length >= 2 ? `${parts[0]}/${stripGitSuffix(parts[1])}` : "저장소 분석";
}

export function commitAnalysisTitle(value: string): string {
  const parts = githubPathParts(value);
  if (parts.length < 4 || parts[2] !== "commit") return "커밋 분석";
  return `${parts[0]}/${stripGitSuffix(parts[1])}@${parts[3].slice(0, 7)}`;
}

function githubPathParts(value: string): string[] {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return [];
    return url.pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}
