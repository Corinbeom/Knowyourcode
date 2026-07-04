from fastapi import FastAPI

from app.config import load_environment

load_environment()

from app.api.commit import router as commit_router
from app.api.evaluation import router as evaluation_router
from app.api.quota import router as quota_router
from app.api.repo import router as repo_router
from app.security import add_cors_middleware, docs_enabled

app = FastAPI(
    title="KnowYourCode API",
    docs_url="/docs" if docs_enabled() else None,
    redoc_url="/redoc" if docs_enabled() else None,
    openapi_url="/openapi.json" if docs_enabled() else None,
)
add_cors_middleware(app)
app.include_router(repo_router)
app.include_router(commit_router)
app.include_router(evaluation_router)
app.include_router(quota_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
