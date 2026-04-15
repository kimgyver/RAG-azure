# Azure RAG 문서 처리 파이프라인 프로젝트

Azure 네이티브 구성(Blob, Functions, Service Bus, 선택적 Cosmos DB·AI Search·OpenAI)으로 **문서 업로드 → 비동기 인덱싱 → 테넌트 단위 RAG 챗**까지 이어지는 포트폴리오용 레포지터리다.

## 디렉터리 구조 (현재)

```text
/infra                 Terraform: RG, Storage, Service Bus, Linux Function App, Application Insights
/frontend              React + Vite SPA (업로드·챗·카탈로그 UI)
/backend/functions-ingestion   Azure Functions (TypeScript): 업로드 SAS, Blob/Queue 트리거, 챗·카탈로그 HTTP
/docs                  아키텍처·개발·배포·보안 문서
```

챗 API는 별도 `functions-chat` 앱이 아니라 **`functions-ingestion`에 포함**되어 있다.

## 문서 목록

읽는 순서를 추천하면: **아키텍처** → **개발(로컬)** → **Azure 배포** → 나머지.

| 문서 | 내용 |
|------|------|
| [docs/architecture.md](./docs/architecture.md) | 목표, 상위 아키텍처, SAS 직접 업로드, 단계별 데이터 흐름, Azure 서비스 역할 |
| [docs/development.md](./docs/development.md) | 환경 변수 표, Step 1~10 구현 체크리스트, 로컬 실행·Search/Chat 디버깅 |
| [docs/deployment-azure.md](./docs/deployment-azure.md) | Terraform 적용, **Functions publish(`dist` 포함)**, 프론트·CORS, **기존 AI Search 연결**, 카탈로그 **503/404** 트러블슈팅, 할 일 체크리스트 |
| [docs/design-and-scope.md](./docs/design-and-scope.md) | 멀티테넌트·Cosmos 설계 메모, 청킹, Chat 호스팅 선택, IaC 순서, MVP 범위 |
| [docs/security-and-pitch.md](./docs/security-and-pitch.md) | 보안·운영 메모, 인터뷰용 한 문장 피치 |

## 빠른 시작

### 프론트엔드

```bash
cd frontend
npm install
npm run dev
```

`frontend/.env.example`을 참고해 `.env`를 만든다. 개발 모드에서는 `VITE_UPLOAD_API_BASE_URL`을 비워 두면 Vite가 `/api`를 로컬 Functions(`127.0.0.1:7071`)로 넘긴다.

### Functions (업로드·파이프라인·챗 API)

```bash
cd backend/functions-ingestion
# local.settings.json 이 없을 때만: cp local.settings.json.example local.settings.json
# 이미 있으면 cp 하지 말 것(덮어쓰기 방지). 스토리지 등 값은 그 파일에 채운다.
npm install
npm run build
npm run start
```

상세 환경 변수와 단계별 구현 상태는 [docs/development.md](./docs/development.md)를 본다.

### Azure에 올릴 때 (한 줄 요약)

1. `cd infra && terraform apply` — Storage·Service Bus·Function App 등 (**Cosmos / AI Search 리소스는 기본 생성 안 함**, 앱 설정도 꺼 둠).  
2. `backend/functions-ingestion`에서 `npm run build` 후 `func azure functionapp publish …`.  
3. 포털 또는 `extra_app_settings`로 **AI Search**(또는 Cosmos) 연결 — 안 하면 카탈로그가 **503** ([deployment-azure.md §4](./docs/deployment-azure.md#4-optional-backends-azure-ai-search-cosmos-db-openai)).  
4. `frontend/.env`에 `VITE_UPLOAD_API_BASE_URL=https://<앱>.azurewebsites.net/api` 등 설정 후 빌드·호스팅.

전체 절차·트러블슈팅은 [docs/deployment-azure.md](./docs/deployment-azure.md)를 본다.

## 검토 메모 (README 분리 시)

- **장점**: 한 파일에 설계·운영·로컬 절차가 모두 있어 온보딩에 유리했음.
- **개선**: 길이가 길어져 역할별 탐색이 어려워, 위 문서로 나눔. “무엇을 왜 쓰는가”는 `architecture` / `design-and-scope`, “어떻게 돌리는가”는 `development`·`deployment-azure`에 모음.
- **중복**: 파이프라인 단계 설명이 아키텍처 문서와 개발 Step에 각각 있음. 전자는 **개념·현재 구현 요약**, 후자는 **작업 순서·명령** 기준으로 유지함.
