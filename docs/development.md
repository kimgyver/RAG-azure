# 로컬 개발과 구현 단계

[← README로 돌아가기](../README.md)

파이프라인의 의미와 Azure 서비스 역할은 [architecture.md](./architecture.md)를 참고한다.

**Azure에 이미 배포한 Function App**을 쓸 때: Terraform 기본값은 Search·Cosmos가 **꺼져** 있어 `GET /api/documents/catalog`이 **503**일 수 있다. 기존 AI Search(또는 Cosmos)를 앱 설정에 연결하는 절차는 [deployment-azure.md §4](./deployment-azure.md#4-optional-backends-azure-ai-search-cosmos-db-openai)를 본다. 배포 후 **404**가 나면 [deployment-azure.md — publish와 `dist/`](./deployment-azure.md#function-routes-return-404-after-publish)를 본다. 배포 전체 체크리스트는 [§5 Post-deploy checklist](./deployment-azure.md#5-post-deploy-checklist)이다.

## 환경 플래그 빠른 참고

| 변수                 | 기본      | 의미                                                                                                                            |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `COSMOS_DB_ENABLED`  | `false`   | `true`일 때만 문서 메타데이터를 Cosmos에 쓰고, `GET /documents/{id}`가 동작한다.                                                |
| `SEARCH_ENABLED`     | `false`   | `true`일 때만 AI Search 인덱싱·`POST /chat` 검색이 동작한다.                                                                    |
| `EMBEDDING_ENABLED`  | `false`   | `true`일 때 청크·질문 임베딩 경로 사용(키/엔드포인트 필요).                                                                     |
| `OCR_ENABLED`        | `true`    | `false`면 래스터 이미지 OCR을 건너뛴다.                                                                                         |
| `OCR_LANGS`          | `eng`     | Tesseract 언어 팩(예: `eng+kor`).                                                                                               |
| `ALLOWED_TENANT_IDS` | 비어 있음 | 비어 있으면 개발 편의상 모든 `tenantId` 허용. 값이 있으면 쉼표 구분 목록만 허용(`uploads/create`, 챗, 상태 조회, 큐·Blob 경로). |

프론트는 `VITE_TENANT_ID`로 기본 테넌트를 맞추고, UI에서 테넌트 문자열을 바꿀 수 있다.

히어로의 백엔드 상태 표시는 `GET /api/flags/deployment` 응답과 동기화된다(인증 없음·플래그만, 비밀 미포함). 함수 이름·URL에 `runtime` 을 쓰면 호스트 내장 경로와 충돌할 수 있다. 업로드·챗 등 다른 API는 기존처럼 Functions 키가 필요할 수 있다.

### 문서 카탈로그 · 데이터 삭제 (테스트용)

- `GET /api/documents/catalog?tenantId=` — Cosmos·Search를 합쳐 문서 단위 행을 반환한다(`authLevel: anonymous`, 테넌트·플래그로 제한). 둘 다 꺼져 있으면 503.
- `DELETE /api/documents/{documentId}/purge?tenantId=` — 해당 문서의 **AI Search 청크 전부**와 **Cosmos 메타데이터**를 지운다. **Blob 원본은 삭제하지 않는다.** (위와 동일하게 anonymous — 프로덕션은 네트워크·APIM·별도 인증으로 보호할 것.)

### Functions 로컬에서 `x-functions-key` 구하기 (Core Tools 4.9)

`func keys list` 는 **Core Tools 4.9에는 없다**(명령이 제거·통합됨). 업로드·챗 등 `authLevel: function` 인 API는 여전히 키가 필요할 수 있다.

- **Visual Studio Code** + Azure Functions 확장: 사이드바 **Azure** → Functions → 해당 함수 우클릭 → **Copy Function Url** 등으로 `code=` 또는 호출 URL을 복사해 키 부분만 쓴다.
- **Azure에 이미 배포한 Function App**이 있으면: Portal → 해당 앱 → **앱 키** → `_default` 복사.
- 로컬에서만 빠르게 시험할 때는 **목록·삭제 API**는 위 카탈로그/퍼지처럼 키 없이 호출되도록 해 두었다(프론트도 키 없이 목록·삭제 가능).

### 프론트 `npm run dev` 와 Functions 주소

- `VITE_UPLOAD_API_BASE_URL` 을 **비워 두면**(또는 미설정) 개발 모드에서 기본값은 **`/api`** 이다. Vite(`vite.config.ts`)가 이를 `http://127.0.0.1:7071` 로 넘겨 **CORS·`localhost` vs `127.0.0.1` 차이**로 인한 `Failed to fetch` 를 줄인다.
- 원격에 배포한 Functions만 쓸 때는 `.env`에 전체 URL을 넣는다(예: `https://<앱이름>.azurewebsites.net/api`).

### 로컬 호스트가 `LeaseIdMismatch` / `WebJobs.Internal.Blobs.Listener` 로 죽을 때

`AzureWebJobsStorage` 가 가리키는 **같은 스토리지**에 대해 **Functions 호스트가 두 개 이상** 떠 있거나, 이전 프로세스가 비정상 종료되면 Blob **싱글톤 잠금(리스)** 이 깨지며 409가 나고 호스트가 종료될 수 있다.

- **한 번에 `func start` / `npm run start` 는 하나만** 띄운다. 다른 터미널·VS Code 디버그 세션도 같은 앱이면 끈다.
- 클라우드 스토리지 계정을 여러 로컬 세션이 공유하지 않도록 한다.

## 로컬 개발: Azure Storage만 쓰기 (Azurite 없음)

이 레포는 **로컬 Functions도 클라우드의 Storage·Service Bus**를 가리키는 흐름을 기본으로 한다.

1. **스토리지 계정** 하나 준비. `AzureWebJobsStorage`와 문서 Blob(`AZURE_STORAGE_*`)에 **같은 계정**을 쓰는 것이 가장 단순하다(Blob 트리거 경로 `uploads/{name}`와 SAS 업로드 컨테이너가 일치).
2. `local.settings.json.example`을 복사해 `local.settings.json`을 만들고, 예시의 `YOUR_*` 자리를 실제 연결 문자열·키로 바꾼다.
3. Blob 컨테이너만 자동 생성: `cd backend/functions-ingestion && npm run storage:setup`  
   **Service Bus 큐**(`AZURE_PROCESSING_QUEUE_NAME`, 기본 `processing-jobs`)는 포털에서 네임스페이스에 만들어 둔다.
4. **브라우저에서 SAS로 Blob에 PUT**할 때는 스토리지 계정 **CORS**에 Vite 출처(예: `http://localhost:5173`)와 메서드 `PUT` 등을 허용한다. (Azurite 때처럼 Vite 프록시에 의존하지 않아도 된다.)
5. `vite.config.ts`의 `/devstoreaccount1` 프록시는 **에뮬레이터 URL을 쓸 때만** 의미가 있다. 클라우드 Blob URL만 쓰면 프록시는 타지 않는다.

## 권장 구현 순서

### Step 1: 프론트엔드 업로드 화면과 채팅 화면

먼저 업로드 페이지와 채팅 페이지의 형태를 만든다.

산출물:

- 파일 선택 UI
- 업로드 상태 UI
- 채팅 UI

현재 구현 상태:

- `frontend` 디렉터리에 React + TypeScript + Vite 기반 프론트엔드 셸을 생성함
- 업로드 패널과 채팅 패널이 한 화면에 보이도록 초기 UI 구성 완료
- 테넌트 ID 입력(`VITE_TENANT_ID` 기본값)과 안내 문구로 멀티테넌트 데모를 맞출 수 있음
- 채팅 영역은 안내용 시드 메시지 한 줄로 시작함

실행 방법:

```bash
cd frontend
npm install
npm run dev
```

검증 방법:

- 업로드 카드·Tenant ID 필드가 보이는지 확인
- 업로드 후 문서 행이 목록에 쌓이는지 확인(`COSMOS_DB_ENABLED=true`일 때 상태 폴링)
- 채팅 입력창과 시드 안내 메시지가 보이는지 확인

### Step 2: 업로드 권한 발급 API

다음 역할을 하는 HTTP 함수를 만든다.

- 필요하다면 사용자 인증
- document id와 blob path 생성
- SAS URL 반환

현재 구현 상태:

- `backend/functions-ingestion`에 Azure Functions(TypeScript v4) 프로젝트 생성
- `POST /api/uploads/create` HTTP 함수 구현 완료
- 요청값(`tenantId`, `fileName`, `contentType`) 검증 후 `documentId`, `blobName`, `uploadUrl` 반환
- 프론트엔드 업로드 버튼이 해당 API를 호출한 뒤 Blob direct upload(`PUT`)를 수행하도록 연결 완료

로컬 실행 방법:

1. 함수 앱 설정 파일 준비

- `backend/functions-ingestion/local.settings.json` **이 이미 있으면** 이 단계를 건너뛴다. (`cp`로 예시를 덮어쓰면 기존 비밀·설정이 사라진다.)
- **없을 때만** 예시를 복사한 뒤 값을 채운다.
- `local.settings.json`에는 키/연결 문자열 등 비밀값이 들어가므로 git에 커밋하지 않는다(로컬 전용 파일).

```bash
cd backend/functions-ingestion
cp local.settings.json.example local.settings.json
```

(위 `cp`는 **파일이 없을 때만** 실행한다.)

2. `local.settings.json`에서 아래 항목 값 입력(클라우드 Storage·Service Bus)

- `AzureWebJobsStorage` — 스토리지 계정 연결 문자열(Blob 트리거·호스트용)
- `AZURE_STORAGE_ACCOUNT_NAME` / `AZURE_STORAGE_ACCOUNT_KEY` / `AZURE_STORAGE_BLOB_ENDPOINT` — SAS 발급·다운로드용(보통 위와 동일 계정)
- `AZURE_STORAGE_CONTAINER_NAME` — 기본 `uploads`
- `SERVICE_BUS_CONNECTION` — Service Bus 연결 문자열
- `SAS_EXPIRY_MINUTES` 등 나머지는 예시 파일 참고

3. 함수 앱 실행

```bash
cd backend/functions-ingestion
npm install
npm run build
npm run start
```

4. 프론트엔드 실행

```bash
cd frontend
npm run dev
```

참고:

- 프론트 기본 API 주소는 `http://localhost:7071/api`다.
- 필요하면 `frontend/.env`에 `VITE_UPLOAD_API_BASE_URL` 값을 지정해 API 주소를 바꿀 수 있다.

### Step 3: Blob으로 direct upload 연결

프론트엔드가 SAS URL을 사용해 직접 업로드하도록 연결한다.

현재 구현 상태:

- 프론트엔드에서 `POST /api/uploads/create` 호출 후 SAS URL 획득
- 브라우저에서 Blob Storage로 `PUT` direct upload 연결 완료
- 브라우저는 SAS URL로 Blob Storage에 직접 `PUT`한다(클라우드 계정이면 스토리지 CORS 설정 필요)

### Step 4: Blob Trigger 검증

Blob이 생성되면:

- 메타데이터 검증
- `COSMOS_DB_ENABLED=true`일 때 Cosmos DB에 초기 레코드 저장(꺼져 있으면 이 단계는 생략)
- 처리 메시지를 큐에 등록

현재 구현 상태:

- `blob-validate-and-enqueue` Blob Trigger 함수 추가
- 업로드 파일 크기 검증(`MAX_UPLOAD_SIZE_MB`) 추가
- 검증 통과 시 Azure Service Bus `processing-jobs` 큐로 처리 메시지 등록
- 로컬·클라우드 모두 `BLOB_TRIGGER_SOURCE=LogsAndContainerScan`(기본)으로 Blob 스캔 기반 트리거를 쓸 수 있다
- `SERVICE_BUS_CONNECTION`에 Service Bus 연결 문자열, 네임스페이스에 처리 큐가 있어야 한다

### Step 5: 처리 워커

Queue Trigger 기반 워커를 구현한다.
처음에는 한 가지 문서 타입과 한 가지 추출 전략만 지원해도 충분하다.

현재 구현 상태:

- `processing-worker` Service Bus Queue Trigger 함수 추가
- 큐 메시지 역직렬화 및 처리 시작 로그 구현
- Blob Storage에서 원본 파일 다운로드 후 텍스트 추출 구현 완료
- 텍스트 기반 파일(`.txt`, `.md`, `.csv`, `.json`, `text/*`) 및 PDF(`pdf-parse`, 텍스트 레이어) 지원
- PNG·JPEG·WebP·GIF 등 래스터 이미지는 Tesseract 기반 OCR로 텍스트 추출 시도(`OCR_ENABLED`, `OCR_LANGS`)

### Step 6: 청킹과 임베딩 생성

추출된 텍스트를 청크로 나누고 임베딩을 생성한다.

현재 구현 상태:

- `processing-worker`에서 텍스트 추출 후 문자 기반 청킹(`chunkText`) 적용
- chunk size/overlap 환경변수(`CHUNK_SIZE_CHARS`, `CHUNK_OVERLAP_CHARS`) 적용
- `EMBEDDING_ENABLED=true` 설정 시 Azure OpenAI 또는 OpenAI를 통해 각 청크의 임베딩 생성
- 임베딩 생성은 배치 처리(16개 단위)로 수행해 API 호출 횟수 최적화
- 임베딩 미설정 환경에서는 텍스트 검색 전용 모드로 정상 동작

### Step 7: Azure AI Search 인덱싱

청크 문서를 검색 인덱스에 저장한다.

현재 구현 상태:

- Azure AI Search 설정이 켜진 경우 청크를 `rag-chunks` 인덱스에 업로드하도록 구현
- 인덱스 스키마에 `embedding` 벡터 필드(`Collection(Edm.Single)`, HNSW 알고리즘) 포함
- `createOrUpdateIndex`로 기존 인덱스 스키마 자동 갱신 지원
- 인덱싱 성공 시 문서 상태를 `indexed`로 전이
- 설정이 비활성화된 로컬 환경에서는 `chunked` 상태를 유지

운영/디버깅 명령:

- `cd backend/functions-ingestion && npm run search:clear`
  - 기본 인덱스(`SEARCH_INDEX_NAME`, 기본값 `rag-chunks`)의 문서를 모두 삭제하고 인덱스 스키마는 유지한다.
- `cd backend/functions-ingestion && npm run search:clear -- rag-chunks-debug`
  - 특정 인덱스 이름을 넘겨 해당 인덱스의 문서만 모두 삭제한다.
- `cd backend/functions-ingestion && npm run search:debug:rebuild`
  - `rag-chunks`의 현재 문서를 읽어 `rag-chunks-debug` 인덱스를 다시 만들고, 조회 가능한 `embedding` 필드를 채운다.

실행 결과 예시:

```json
{ "indexName": "rag-chunks", "deleted": 8 }
```

문서 삭제 후 확인 방법:

```bash
curl -s "https://<search-service>.search.windows.net/indexes/rag-chunks/docs?api-version=2024-07-01&search=*" \
   -H "api-key: <search-api-key>" \
   -H "Content-Type: application/json"
```

정상적으로 비워졌다면 응답의 `value`가 빈 배열이 된다.

### Step 8: Chat API 구현

tenant 필터 기반 하이브리드 검색과 답변 생성을 구현한다.

현재 구현 상태:

- `POST /api/chat` 엔드포인트가 `tenantId` 필터를 적용해 Azure AI Search에서 관련 청크를 조회
- `EMBEDDING_ENABLED=true` 설정 시 질문의 임베딩을 생성해 벡터 + 키워드 하이브리드 검색 수행
- `CHAT_SEARCH_MODE=keyword|hybrid|vector` 로 검색 모드를 전환 가능 (`hybrid` 기본값)
- Functions 로그에 `Chat search executed.` 항목으로 configured/effective mode, vectorUsed, retrievedChunks 출력
- 멀티턴 품질 개선: 요청 body의 `messages`(최근 대화) + `summaryMemory`(요약 메모리)를 함께 받아 프롬프트에 결합
- 비용/토큰 상한 우선 적용: `CHAT_PROMPT_CHAR_BUDGET`, `CHAT_MAX_COMPLETION_TOKENS`, `CHAT_CONTEXT_CHAR_BUDGET`, `CHAT_QUESTION_CHAR_LIMIT`
- 메모리 예산 제어: `CHAT_MEMORY_RECENT_TURNS`, `CHAT_MEMORY_RECENT_CHAR_BUDGET`, `CHAT_MEMORY_SUMMARY_CHAR_BUDGET`
- App Insights용 채팅 텔레메트리 로그 추가: 검색 모드, 히트 수, 응답 길이, fallback 여부, 지연(ms), prompt budget 적용 여부
- `OPENAI_API_KEY` 설정 시 Azure OpenAI 또는 OpenAI GPT로 최종 답변 생성
- 응답에 answer, citations(문서 출처), retrievedChunks 수 포함
- 미설정 환경에서는 검색 결과 스니펫 기반의 search-only fallback 답변으로 동작한다. 이는 오류가 아니라, LLM 연결 전에도 검색 품질과 tenant 필터를 검증할 수 있도록 한 운영 모드다.
- 프론트 채팅 패널은 이 상태를 그대로 드러내도록 `Search-only fallback mode` 또는 `Generative answer mode` 배너를 표시한다.
- 현재 구현은 "질문 + 검색된 문서 청크"를 프롬프트로 사용하며, 이전 턴의 chat history를 별도로 누적해 프롬프트에 넣지는 않는다.

대화 이력 포함 여부(현재 동작):

- `POST /api/chat`은 `tenantId`, `question` 외에 `messages`, `summaryMemory`, `sessionId`를 받을 수 있다.
- 백엔드는 최근 N턴(`CHAT_MEMORY_RECENT_TURNS`)과 요약 메모리를 함께 프롬프트에 포함한다.
- 총 프롬프트 길이가 예산(`CHAT_PROMPT_CHAR_BUDGET`)을 넘으면 컨텍스트/메모리를 자동 축약한다.

기존 Search 인덱스만 있고 Cosmos 메타데이터가 비어 있는 문서를 채우려면:

```bash
cd backend/functions-ingestion
npm run cosmos:backfill
```

스크립트는 `local.settings.json` 또는 현재 셸 환경의 `SEARCH_*`, `COSMOS_*` 값을 읽어 Search 문서를 스캔하고 Cosmos에 문서 메타데이터를 upsert 한다. 특정 tenant만 처리하거나 미리 결과만 보고 싶으면 `BACKFILL_TENANT_ID`, `BACKFILL_DRY_RUN=true` 를 함께 준다.

비교 테스트 방법:

- `CHAT_SEARCH_MODE=keyword`
  - 키워드 검색만 사용
- `CHAT_SEARCH_MODE=hybrid`
  - 키워드 + 벡터 검색 동시 사용
- `CHAT_SEARCH_MODE=vector`
  - 질문 임베딩만 사용해 검색 (`EMBEDDING_ENABLED=true` 필요)

백엔드 재시작 후 같은 질문을 반복하고, Functions 로그의 `Chat search executed.`를 비교하면 된다.

### Step 9: Terraform 정리

서비스 경계가 안정되면 인프라를 코드로 옮긴다. 이 레포에는 `infra/`에 Azure 스택(Resource Group, Storage, Service Bus, Linux Function App, Application Insights)용 Terraform이 있다. **Cosmos / AI Search / OpenAI 리소스는 Terraform이 기본 생성하지 않으며**, Function 앱 설정도 꺼 둔다 — 클라우드에서 Search·챗·카탈로그를 쓰려면 [deployment-azure.md §4](./deployment-azure.md#4-optional-backends-azure-ai-search-cosmos-db-openai)대로 연결한다.

코드 배포: `backend/functions-ingestion`에서 **`npm run build` 후** `func azure functionapp publish …` ([publish / `dist` / 404](./deployment-azure.md#function-routes-return-404-after-publish)). 전체 순서·체크리스트는 [deployment-azure.md](./deployment-azure.md) 본문과 [Post-deploy checklist](./deployment-azure.md#5-post-deploy-checklist)를 본다.

실무에서 자주 헷갈리는 포인트:

- `terraform apply`: 리소스(인프라) 생성/변경/삭제 단계
- `func azure functionapp publish`: 이미 생성된 Function App에 코드만 재배포
- 코드만 바뀐 경우에는 일반적으로 `publish`만 반복하고, 인프라나 앱 설정 변경이 있을 때 `terraform apply`를 실행한다.
- `backend/functions-ingestion/local.settings.json`은 로컬 실행 전용이다. Azure에 배포된 Function App은 Portal/ARM/Terraform app settings 값을 사용한다.

`infra/outputs.tf`의 주요 활용:

- `function_app_name`: `func azure functionapp publish "$(terraform -chdir=../../infra output -raw function_app_name)"` 형태로 배포 대상 이름을 자동 주입
- `api_base_url`: 프론트 `.env`의 `VITE_UPLOAD_API_BASE_URL`에 사용
- `storage_account_name`, `servicebus_namespace`: 운영 점검/진단 시 식별자 확인

Storage 용어 정리(공식 명칭):

- Storage Account: 최상위 스토리지 리소스(이 레포에서는 `project_name + random suffix` 규칙)
- Storage Container: Blob 저장 논리 단위(이 레포 기본값은 `uploads`)
- 구조는 `Storage Account > Container > Blob`로 이해하면 된다.

### Step 10: 관측성과 안정성 보강

다음을 추가한다.

- Application Insights(Terraform 배포 시 Function App에 연결됨 — 포털에서 쿼리·Live Metrics; 자세한 배포 메모는 [deployment-azure.md §5](./deployment-azure.md#5-post-deploy-checklist))
- correlation ID
- 재시도 정책
- DLQ 처리
- 상태 전이 관리

운영 로그 소음(폴링 로그) 줄이기:

- `backend/functions-ingestion/host.json`의 `logging.logLevel`에서 `Host.Triggers.*`를 `Warning`으로 설정해 Blob/Queue 폴링 로그를 최소화했다.
- 필요한 경우 `Function.chat`만 `Information`으로 유지해 챗 텔레메트리만 집중적으로 볼 수 있다.
