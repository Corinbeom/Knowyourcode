import AdmZip from "adm-zip";
import type { CommitFileChange, CommitInfo, RepoInfo, SourceFile } from "./types";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "target",
  ".git",
  ".turbo"
]);

const EXCLUDED_FILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb"
];

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".html",
  ".yml",
  ".yaml",
  ".env.example",
  ".config",
  ".toml",
  ".java",
  ".kt",
  ".gradle",
  ".properties",
  ".xml",
  ".py",
  ".go",
  ".rb",
  ".php",
  ".cs",
  ".fs",
  ".rs",
  ".swift",
  ".scala",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".dart",
  ".vue",
  ".svelte",
  ".astro",
  ".sql",
  ".graphql",
  ".proto",
  ".sh"
]);

const MAX_FILE_SIZE = 60_000;
const MAX_TOTAL_FILES = 1_000;
const MAX_REPO_ZIP_BYTES = Number(process.env.MAX_REPO_ZIP_BYTES ?? 50_000_000);
const MAX_COMMIT_FILES = Number(process.env.MAX_COMMIT_FILES ?? 40);
const MAX_COMMIT_PATCH_CHARS = Number(process.env.MAX_COMMIT_PATCH_CHARS ?? 120_000);

export function parseGitHubUrl(input: string): RepoInfo {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("올바른 GitHub URL을 입력해주세요.");
  }

  if (url.hostname !== "github.com") {
    throw new Error("github.com public repository URL만 지원합니다.");
  }

  const [owner, repoWithSuffix] = url.pathname.split("/").filter(Boolean);
  const repo = repoWithSuffix?.replace(/\.git$/, "");

  if (!owner || !repo) {
    throw new Error("GitHub repository URL 형식이 아닙니다.");
  }

  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export function parseGitHubCommitUrl(input: string): Pick<CommitInfo, "owner" | "repo" | "sha" | "shortSha" | "url"> {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("올바른 GitHub commit URL을 입력해주세요.");
  }

  if (url.hostname !== "github.com") {
    throw new Error("github.com public commit URL만 지원합니다.");
  }

  const [owner, repoWithSuffix, segment, sha] = url.pathname.split("/").filter(Boolean);
  const repo = repoWithSuffix?.replace(/\.git$/, "");

  if (!owner || !repo || segment !== "commit" || !sha) {
    throw new Error("GitHub commit URL 형식이 아닙니다. /owner/repo/commit/sha 형태로 입력해주세요.");
  }

  return {
    owner,
    repo,
    sha,
    shortSha: sha.slice(0, 7),
    url: `https://github.com/${owner}/${repo}/commit/${sha}`
  };
}

export async function fetchRepoFiles(repo: RepoInfo): Promise<SourceFile[]> {
  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/zipball`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "KnowYourCode-MVP"
    },
    cache: "no-store"
  });

  if (response.status === 404) {
    throw new Error("저장소를 찾을 수 없거나 public repository가 아닙니다.");
  }

  if (!response.ok) {
    throw new Error(`GitHub 저장소를 가져오지 못했습니다. (${response.status})`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REPO_ZIP_BYTES) {
    throw new Error(`저장소가 너무 큽니다. ZIP 기준 ${formatBytes(MAX_REPO_ZIP_BYTES)} 이하만 분석할 수 있습니다.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_REPO_ZIP_BYTES) {
    throw new Error(`저장소가 너무 큽니다. ZIP 기준 ${formatBytes(MAX_REPO_ZIP_BYTES)} 이하만 분석할 수 있습니다.`);
  }

  const zip = new AdmZip(buffer);

  return zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => {
      const normalized = normalizeZipPath(entry.entryName);
      return { entry, path: normalized };
    })
    .filter(({ path }) => shouldIncludePath(path))
    .slice(0, MAX_TOTAL_FILES)
    .map(({ entry, path }) => {
      const content = entry.getData().toString("utf8");
      return {
        path,
        content: content.slice(0, MAX_FILE_SIZE),
        size: entry.header.size
      };
    });
}

export async function fetchCommitChanges(input: Pick<CommitInfo, "owner" | "repo" | "sha" | "shortSha" | "url">): Promise<{
  commit: CommitInfo;
  files: CommitFileChange[];
  totalAdditions: number;
  totalDeletions: number;
}> {
  const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/commits/${input.sha}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "KnowYourCode-MVP"
    },
    cache: "no-store"
  });

  if (response.status === 404) {
    throw new Error("커밋을 찾을 수 없거나 public repository가 아닙니다.");
  }

  if (response.status === 403) {
    throw new Error("GitHub API 호출 제한에 도달했습니다. 잠시 후 다시 시도해주세요.");
  }

  if (!response.ok) {
    throw new Error(`GitHub 커밋 정보를 가져오지 못했습니다. (${response.status})`);
  }

  const data = await response.json();
  const rawFiles = Array.isArray(data.files) ? data.files : [];
  let usedPatchChars = 0;

  const files: CommitFileChange[] = rawFiles.slice(0, MAX_COMMIT_FILES).map((file: Record<string, unknown>) => {
    const rawPatch = typeof file.patch === "string" ? file.patch : "";
    const remaining = Math.max(0, MAX_COMMIT_PATCH_CHARS - usedPatchChars);
    const patch = rawPatch.slice(0, remaining);
    usedPatchChars += patch.length;

    return {
      path: String(file.filename ?? "unknown"),
      previousPath: typeof file.previous_filename === "string" ? file.previous_filename : undefined,
      status: normalizeCommitStatus(file.status),
      additions: toNumber(file.additions),
      deletions: toNumber(file.deletions),
      changes: toNumber(file.changes),
      patch
    };
  });

  const message = String(data.commit?.message ?? "").split("\n")[0] || "커밋 메시지 없음";
  const author = String(data.commit?.author?.name ?? data.author?.login ?? "unknown");
  const committedAt = String(data.commit?.author?.date ?? "");

  return {
    commit: {
      owner: input.owner,
      repo: input.repo,
      sha: String(data.sha ?? input.sha),
      shortSha: String(data.sha ?? input.sha).slice(0, 7),
      url: input.url,
      message,
      author,
      committedAt
    },
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0)
  };
}

function normalizeZipPath(entryName: string): string {
  const parts = entryName.split("/");
  return parts.slice(1).join("/");
}

function shouldIncludePath(path: string): boolean {
  if (!path) return false;

  const parts = path.split("/");
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return false;

  const fileName = parts.at(-1) ?? "";
  if (EXCLUDED_FILES.includes(fileName)) return false;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".map")) return false;

  const ext = getExtension(fileName);
  if (!TEXT_EXTENSIONS.has(ext) && !["README", "Dockerfile", "pom.xml", "build.gradle", "settings.gradle"].includes(fileName)) {
    return false;
  }

  return true;
}

function getExtension(fileName: string): string {
  if (fileName === ".env.example") return ".env.example";
  const index = fileName.lastIndexOf(".");
  return index === -1 ? fileName : fileName.slice(index);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${Math.floor(bytes / 1_000_000)}MB`;
  if (bytes >= 1_000) return `${Math.floor(bytes / 1_000)}KB`;
  return `${bytes}B`;
}

function normalizeCommitStatus(status: unknown): CommitFileChange["status"] {
  if (
    status === "added" ||
    status === "modified" ||
    status === "removed" ||
    status === "renamed" ||
    status === "copied" ||
    status === "changed" ||
    status === "unchanged"
  ) {
    return status;
  }
  return "modified";
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
