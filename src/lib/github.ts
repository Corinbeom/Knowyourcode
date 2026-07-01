import AdmZip from "adm-zip";
import type { RepoInfo, SourceFile } from "./types";

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
  ".toml"
]);

const MAX_FILE_SIZE = 60_000;
const MAX_TOTAL_FILES = 80;

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

  const buffer = Buffer.from(await response.arrayBuffer());
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
  if (!TEXT_EXTENSIONS.has(ext) && !["README", "Dockerfile"].includes(fileName)) {
    return false;
  }

  return true;
}

function getExtension(fileName: string): string {
  if (fileName === ".env.example") return ".env.example";
  const index = fileName.lastIndexOf(".");
  return index === -1 ? fileName : fileName.slice(index);
}
