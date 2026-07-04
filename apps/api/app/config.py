from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - available through uvicorn[standard] in local dev
    load_dotenv = None


def load_environment() -> None:
    if load_dotenv is None:
        return

    root_dir = Path(__file__).resolve().parents[3]
    for env_file in [
        root_dir / "apps/api/.env.local",
        root_dir / "apps/api/.env",
        root_dir / "apps/web/.env.local",
    ]:
        if env_file.exists():
            load_dotenv(env_file, override=False)
