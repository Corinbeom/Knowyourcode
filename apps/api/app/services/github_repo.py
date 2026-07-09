import io
import os
import zipfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from app.services.llm import SSL_CONTEXT
from app.services.redaction import is_sensitive_file_path, redact_secrets

EXCLUDED_DIRS = {"node_modules", "dist", "build", ".next", "coverage", "vendor", "target", ".git", ".turbo"}
EXCLUDED_FILES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"}
TEXT_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".css", ".scss", ".html",
    ".yml", ".yaml", ".env.example", ".config", ".toml", ".java", ".kt", ".gradle", ".properties",
    ".xml", ".py", ".go", ".rb", ".php", ".cs", ".fs", ".rs", ".swift", ".scala", ".c", ".h",
    ".cpp", ".hpp", ".dart", ".vue", ".svelte", ".astro", ".sql", ".graphql", ".proto", ".sh",
}
SPECIAL_FILES = {"README", "Dockerfile", "pom.xml", "build.gradle", "settings.gradle"}

MAX_FILE_SIZE = 60_000
MAX_TOTAL_FILES = 1_000
MAX_REPO_ZIP_BYTES = int(os.getenv("MAX_REPO_ZIP_BYTES", "50000000"))


def parse_github_repo_url(raw: str) -> dict:
    parsed = urlparse(raw.strip())
    if parsed.netloc != "github.com":
        raise ValueError("github.com public repository URL만 지원합니다.")

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise ValueError("GitHub repository URL 형식이 아닙니다.")

    owner = parts[0]
    repo = parts[1].removesuffix(".git")
    return {"owner": owner, "repo": repo, "url": f"https://github.com/{owner}/{repo}"}


def fetch_repo_files(repo: dict) -> list[dict]:
    request = Request(
        f"https://api.github.com/repos/{repo['owner']}/{repo['repo']}/zipball",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "KnowYourCode-MVP"},
        method="GET",
    )

    try:
        with urlopen(request, timeout=30, context=SSL_CONTEXT) as response:
            content_length = int(response.headers.get("content-length") or 0)
            if content_length > MAX_REPO_ZIP_BYTES:
                raise ValueError(f"저장소가 너무 큽니다. ZIP 기준 {format_bytes(MAX_REPO_ZIP_BYTES)} 이하만 분석할 수 있습니다.")
            archive = response.read(MAX_REPO_ZIP_BYTES + 1)
    except HTTPError as exc:
        if exc.code == 404:
            raise ValueError("저장소를 찾을 수 없거나 public repository가 아닙니다.") from exc
        if exc.code == 403:
            raise ValueError("GitHub API 호출 제한에 도달했습니다. 잠시 후 다시 시도해주세요.") from exc
        raise ValueError(f"GitHub 저장소를 가져오지 못했습니다. ({exc.code})") from exc
    except URLError as exc:
        raise ValueError("GitHub 저장소를 가져오지 못했습니다. 네트워크 상태를 확인해주세요.") from exc

    if len(archive) > MAX_REPO_ZIP_BYTES:
        raise ValueError(f"저장소가 너무 큽니다. ZIP 기준 {format_bytes(MAX_REPO_ZIP_BYTES)} 이하만 분석할 수 있습니다.")

    files = []
    with zipfile.ZipFile(io.BytesIO(archive)) as zip_file:
        for info in zip_file.infolist():
            if info.is_dir():
                continue
            path = normalize_zip_path(info.filename)
            if not should_include_path(path):
                continue
            with zip_file.open(info) as file:
                content = redact_secrets(file.read(MAX_FILE_SIZE + 1).decode("utf-8", errors="ignore"))[:MAX_FILE_SIZE]
            files.append({"path": path, "content": content, "size": info.file_size})
            if len(files) >= MAX_TOTAL_FILES:
                break

    return files


def normalize_zip_path(path: str) -> str:
    return "/".join(path.split("/")[1:])


def should_include_path(path: str) -> bool:
    if not path:
        return False
    if is_sensitive_file_path(path):
        return False

    parts = path.split("/")
    if any(part in EXCLUDED_DIRS for part in parts):
        return False

    file_name = parts[-1]
    if file_name in EXCLUDED_FILES or file_name.endswith(".min.js") or file_name.endswith(".map"):
        return False

    extension = ".env.example" if file_name == ".env.example" else os.path.splitext(file_name)[1]
    return extension in TEXT_EXTENSIONS or file_name in SPECIAL_FILES


def format_bytes(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.0f}MB"
    if value >= 1_000:
        return f"{value / 1_000:.0f}KB"
    return f"{value}B"
