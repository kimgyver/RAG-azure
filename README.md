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

| 문서                                                                           | 내용                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/architecture.md](./docs/architecture.md)                                 | 목표, 상위 아키텍처, SAS 직접 업로드, 단계별 데이터 흐름, Azure 서비스 역할                                                                 |
| [docs/chatbot-feature-architecture.md](./docs/chatbot-feature-architecture.md) | AWS 챗봇 아키텍처와 유사한 수준으로 정리한 Azure 챗봇 기능 다이어그램(Mermaid)                                                              |
| [docs/development.md](./docs/development.md)                                   | 환경 변수 표, Step 1~10 구현 체크리스트, 로컬 실행·Search/Chat 디버깅                                                                       |
| [docs/deployment-azure.md](./docs/deployment-azure.md)                         | Terraform 적용, **Functions publish(`dist` 포함)**, 프론트·CORS, **기존 AI Search 연결**, 카탈로그 **503/404** 트러블슈팅, 할 일 체크리스트 |
| [docs/design-and-scope.md](./docs/design-and-scope.md)                         | 멀티테넌트·Cosmos 설계 메모, 청킹, Chat 호스팅 선택, IaC 순서, MVP 범위                                                                     |
| [docs/security-and-pitch.md](./docs/security-and-pitch.md)                     | 보안·운영 메모, 인터뷰용 한 문장 피치                                                                                                       |
| [docs/current-status-and-fixes.md](./docs/current-status-and-fixes.md)         | 최근 수정 내역, 원인 분석, 재발 방지, 운영 Runbook, 남은 개선 과제 통합 문서                                                                |

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

### 화면에서 텍스트를 바로 지식베이스에 등록

업로드 패널 하단의 **Register text knowledge** 영역에서 다음을 수행할 수 있다.

1. `Title (optional)` 입력
2. `Text to index` 에 텍스트 붙여넣기
3. `Register text` 클릭

그러면 프론트가 `POST /api/knowledge/text`(개발 시 프록시 기준)로 요청하고, 백엔드가 텍스트를 청킹/임베딩 후 Search 인덱스(활성화된 경우)에 바로 반영한다.

관련 제약:

- `tenantId` allowlist 정책을 동일하게 적용
- `TEXT_KNOWLEDGE_MAX_CHARS`(기본 120000) 초과 시 400 에러

### Azure에 올릴 때 (한 줄 요약)

1. `infra`와 `backend/functions-ingestion` 변경은 `Infra + Functions Deploy` 워크플로가 처리( Terraform apply + Functions publish ).
2. `frontend` 변경은 `Azure Static Web Apps CI/CD` 워크플로가 처리( React build + SWA 배포 ).
3. 포털 또는 `extra_app_settings`로 **AI Search**(또는 Cosmos) 연결 — 안 하면 카탈로그가 **503** ([deployment-azure.md §4](./docs/deployment-azure.md#4-optional-backends-azure-ai-search-cosmos-db-openai)).
4. 프론트 빌드 환경변수에는 `VITE_UPLOAD_API_BASE_URL`만 사용하고, 비밀키는 넣지 않음.

배포 후 화면 해석:

- **AI Search · indexing = On** 이면 검색/카탈로그/챗 검색 경로가 활성화된 상태다.
- **Cosmos · document state = On** 이면 업로드 상태 메타데이터를 Cosmos에도 저장한다. 기존에 Search에만 들어 있던 문서는 자동으로 소급 생성되지 않으므로 필요하면 `npm run cosmos:backfill` 로 메타데이터를 채운다.
- **Chat answers = Search snippets only** 는 오류가 아니라 `OPENAI_API_KEY` 또는 `AZURE_OPENAI_API_KEY` 가 비어 있을 때의 정상 fallback 모드다. 이 경우 챗은 생성형 답변 대신 Search 기반 요약을 반환한다.
- 프론트 채팅 패널과 카탈로그 상단에도 현재 모드를 설명하는 안내 문구가 보이도록 해, 설정 상태를 화면에서 바로 읽을 수 있게 했다.

전체 절차·트러블슈팅은 [docs/deployment-azure.md](./docs/deployment-azure.md)를 본다.

### Search 비용 절감 운영 (원클릭)

필요할 때만 Azure AI Search를 켜고, 안 쓰는 시간에는 끄려면 아래 스크립트를 사용한다.

```bash
# Search 생성(또는 재사용) + Function App SEARCH_* 자동 연결
./scripts/search-on.sh

# Search 비활성화 + Search 서비스 삭제
./scripts/search-off.sh
```

옵션:

```bash
# 특정 이름/티어로 생성
./scripts/search-on.sh rag-search-demo basic

# 특정 이름 서비스 삭제
./scripts/search-off.sh rag-search-demo
```

기본 Search 리소스 그룹은 `apim-lab-rg`이며, 필요하면 실행 시 `SEARCH_RG=<rg-name>`를 지정한다.

## 검토 메모 (README 분리 시)

- **장점**: 한 파일에 설계·운영·로컬 절차가 모두 있어 온보딩에 유리했음.
- **개선**: 길이가 길어져 역할별 탐색이 어려워, 위 문서로 나눔. “무엇을 왜 쓰는가”는 `architecture` / `design-and-scope`, “어떻게 돌리는가”는 `development`·`deployment-azure`에 모음.
- **중복**: 파이프라인 단계 설명이 아키텍처 문서와 개발 Step에 각각 있음. 전자는 **개념·현재 구현 요약**, 후자는 **작업 순서·명령** 기준으로 유지함.

## Website address

https://ambitious-ocean-078950f0f.1.azurestaticapps.net
