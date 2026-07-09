import json
import os
import ssl
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from app.services.redaction import redact_secrets

try:
    import certifi
except ImportError:  # pragma: no cover - fallback for minimal local environments
    certifi = None


MAX_COMMIT_FILES = int(os.getenv("MAX_COMMIT_FILES", "40"))
MAX_COMMIT_PATCH_CHARS = int(os.getenv("MAX_COMMIT_PATCH_CHARS", "120000"))
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where()) if certifi else ssl.create_default_context()


@dataclass
class CommitInput:
    owner: str
    repo: str
    sha: str
    short_sha: str
    url: str


def parse_github_commit_url(raw_url: str) -> CommitInput:
    try:
        parsed = urlparse(raw_url.strip())
    except ValueError as exc:
        raise ValueError("올바른 GitHub commit URL을 입력해주세요.") from exc

    if parsed.netloc != "github.com":
        raise ValueError("github.com public commit URL만 지원합니다.")

    parts = [part for part in parsed.path.split("/") if part]
    owner = parts[0] if len(parts) > 0 else ""
    repo = parts[1].removesuffix(".git") if len(parts) > 1 else ""
    segment = parts[2] if len(parts) > 2 else ""
    sha = parts[3] if len(parts) > 3 else ""

    if not owner or not repo or segment != "commit" or not sha:
        raise ValueError("GitHub commit URL 형식이 아닙니다. /owner/repo/commit/sha 형태로 입력해주세요.")

    return CommitInput(
        owner=owner,
        repo=repo,
        sha=sha,
        short_sha=sha[:7],
        url=f"https://github.com/{owner}/{repo}/commit/{sha}",
    )


def fetch_commit_changes(commit_input: CommitInput) -> dict:
    api_url = f"https://api.github.com/repos/{commit_input.owner}/{commit_input.repo}/commits/{commit_input.sha}"
    request = Request(
        api_url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "KnowYourCode-MVP",
        },
    )

    try:
        with urlopen(request, timeout=20, context=SSL_CONTEXT) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 404:
            raise ValueError("커밋을 찾을 수 없거나 public repository가 아닙니다.") from exc
        if exc.code == 403:
            raise ValueError("GitHub API 호출 제한에 도달했습니다. 잠시 후 다시 시도해주세요.") from exc
        raise ValueError(f"GitHub 커밋 정보를 가져오지 못했습니다. ({exc.code})") from exc
    except OSError as exc:
        raise ValueError("GitHub HTTPS 연결에 실패했습니다. 네트워크 상태 또는 API 가상환경 인증서 의존성을 확인해주세요.") from exc

    raw_files = data.get("files") if isinstance(data.get("files"), list) else []
    used_patch_chars = 0
    files = []

    for raw_file in raw_files[:MAX_COMMIT_FILES]:
        raw_patch = raw_file.get("patch") if isinstance(raw_file.get("patch"), str) else ""
        remaining = max(0, MAX_COMMIT_PATCH_CHARS - used_patch_chars)
        patch = redact_secrets(raw_patch[:remaining])
        used_patch_chars += len(patch)
        files.append(
            {
                "path": str(raw_file.get("filename") or "unknown"),
                "previousPath": raw_file.get("previous_filename") if isinstance(raw_file.get("previous_filename"), str) else None,
                "status": normalize_commit_status(raw_file.get("status")),
                "additions": to_int(raw_file.get("additions")),
                "deletions": to_int(raw_file.get("deletions")),
                "changes": to_int(raw_file.get("changes")),
                "patch": patch,
            }
        )

    sha = str(data.get("sha") or commit_input.sha)
    commit = data.get("commit") if isinstance(data.get("commit"), dict) else {}
    author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
    github_author = data.get("author") if isinstance(data.get("author"), dict) else {}
    message = str(commit.get("message") or "").split("\n")[0] or "커밋 메시지 없음"

    return {
        "commit": {
            "owner": commit_input.owner,
            "repo": commit_input.repo,
            "sha": sha,
            "shortSha": sha[:7],
            "url": commit_input.url,
            "message": message,
            "author": str(author.get("name") or github_author.get("login") or "unknown"),
            "committedAt": str(author.get("date") or ""),
        },
        "files": files,
        "totalAdditions": sum(file["additions"] for file in files),
        "totalDeletions": sum(file["deletions"] for file in files),
    }


def normalize_commit_status(status: object) -> str:
    if status in {"added", "modified", "removed", "renamed", "copied", "changed", "unchanged"}:
        return str(status)
    return "modified"


def to_int(value: object) -> int:
    return value if isinstance(value, int) else 0
