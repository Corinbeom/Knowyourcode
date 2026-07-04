from fastapi import FastAPI

from app.config import load_environment

load_environment()

from app.api.commit import router as commit_router

app = FastAPI(title="KnowYourCode API")
app.include_router(commit_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
