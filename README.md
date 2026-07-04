# KnowYourCode

GitHub 저장소와 커밋을 분석해 사용자가 자신의 프로젝트 구조, 요청 흐름, 데이터 흐름, 변경 영향도를 실제 코드 기준으로 이해하고 있는지 확인하는 AI 코드 이해도 테스트 서비스입니다.

## 구조

- `apps/web`: Next.js 기반 웹 앱
- `apps/api`: FastAPI 기반 API 서버

현재 Web에는 기존 Next.js API fallback이 남아 있고, `BACKEND_API_URL`을 설정하면 Commit Mode 분석 요청을 FastAPI로 위임합니다.

## 요구 사항

- Node.js 20 이상
- npm
- Python 3.12 이상

## 환경변수

Web 환경변수는 `apps/web/.env.local`에 둡니다.

```bash
cp apps/web/.env.example apps/web/.env.local
```

FastAPI 환경변수는 `apps/api/.env.local`에 둘 수 있습니다.

```bash
cp apps/api/.env.example apps/api/.env.local
```

로컬 개발에서는 FastAPI가 `apps/api/.env.local`, `apps/api/.env`, `apps/web/.env.local` 순서로 환경변수를 읽습니다. 이미 Web에 LLM 키를 넣어두었다면 API 쪽에 중복으로 넣지 않아도 됩니다.

## 설치

Web 의존성:

```bash
npm install
```

API 의존성:

```bash
python3 -m venv apps/api/.venv
source apps/api/.venv/bin/activate
pip install -r apps/api/requirements.txt
```

## 실행

Web:

```bash
npm run dev
```

API:

```bash
source apps/api/.venv/bin/activate
npm run api:dev
```

기본 주소:

- Web: `http://localhost:3000`
- API: `http://127.0.0.1:8000`

FastAPI를 함께 사용할 때는 `apps/web/.env.local`에 아래 값을 설정합니다.

```bash
BACKEND_API_URL=http://127.0.0.1:8000
```

## 주요 플로우

### Repo Mode

1. GitHub public repository URL 입력
2. 저장소 파일 필터링 및 코드 정제
3. 프로젝트 리포트와 질문 생성
4. 사용자가 질문에 답변
5. 코드 근거 기반 피드백 확인

### Commit Mode

1. GitHub commit URL 입력
2. 커밋 메타데이터와 변경 파일 diff 수집
3. 변경 의도, 영향 범위, 리뷰 포인트 분석
4. 커밋 기반 질문 풀이
5. 문항별 피드백과 다시 볼 파일 확인

## 검증

Web 타입 체크:

```bash
npm run typecheck
```

Web 프로덕션 빌드:

```bash
npm run build
```

API 문법 확인:

```bash
source apps/api/.venv/bin/activate
python -m py_compile apps/api/app/main.py apps/api/app/api/commit.py apps/api/app/schemas/commit.py apps/api/app/services/github_commit.py apps/api/app/services/commit_analysis.py apps/api/app/services/llm.py
```

## 배포 메모

- Vercel Root Directory는 `apps/web`으로 설정합니다.
- FastAPI를 별도 서버에 배포한 뒤 `BACKEND_API_URL`을 운영 API 주소로 설정합니다.
- 운영 환경에서는 CORS origin, rate limit, API key 사용량 제한을 별도로 강화해야 합니다.
