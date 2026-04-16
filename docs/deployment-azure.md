# Azure 배포 (Terraform + Functions publish)

[← README](../README.md) · [개발 가이드](./development.md)

## 목차

1. [사전 준비](#사전-준비)
2. [1. 인프라 프로비저닝](#1-인프라-프로비저닝)
3. [2. Function App 코드 배포](#2-function-app-코드-배포)
4. [3. 프론트엔드 Azure 연결](#3-프론트엔드-azure-연결)
5. [4. GitHub Actions CI/CD (권장)](#4-github-actions-cicd-권장)
6. [5. 선택적 백엔드: Search, Cosmos, OpenAI](#5-선택적-백엔드-azure-ai-search-cosmos-db-openai)
7. [6. 배포 후 체크리스트](#6-배포-후-체크리스트)
8. [문제 해결](#문제-해결) — [404 / publish](#function-라우트-404), [503 catalog](#문서-카탈로그-503), [CORS](#브라우저-cors-에러), [App Service quota](#app-service-플랜-쿼터-문제)
9. [삭제](#삭제)

### Terraform가 생성하는 리소스 (및 생성하지 않는 것)

| 이 스택이 생성하는 리소스 | 비고                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| 리소스 그룹               | `project_name` + suffix로 생성                                                   |
| 스토리지 계정             | Blob 업로드 컨테이너 + Functions 호스트 스토리지 (`AzureWebJobsStorage`)         |
| Service Bus               | 네임스페이스 + 처리 큐 (`AZURE_PROCESSING_QUEUE_NAME`와 동일 이름)               |
| Linux Function App        | Node 20, extension ~4; **Application Insights**는 앱 설정으로 연결               |
| App Service 플랜          | 새 플랜 생성 **또는** `existing_linux_service_plan_resource_id`로 기존 플랜 연결 |
| Application Insights      | Function App의 로그/메트릭                                                       |

**기본적으로 생성하지 않음:** **Azure AI Search**, **Cosmos DB**, **Azure OpenAI**. 기존 서비스를 연결하려면 Portal **구성(Configuration)** 또는 `terraform.tfvars`의 `extra_app_settings`를 사용하세요. (설정 이름은 [`local.settings.json.example`](../backend/functions-ingestion/local.settings.json.example)과 동일)

`terraform apply` 후 유용한 출력값:

| 출력값                                   | 용도                                                 |
| ---------------------------------------- | ---------------------------------------------------- |
| `api_base_url`                           | `VITE_UPLOAD_API_BASE_URL`에 사용 (끝에 `/api` 포함) |
| `function_app_name`                      | `func azure functionapp publish` 명령에 사용         |
| `storage_account_name`                   | Blob/CORS 설정에 사용                                |
| `servicebus_namespace`                   | 큐 진단에 사용                                       |
| `application_insights_connection_string` | 민감 정보; 로컬/CI에서 선택적으로 사용               |

운영 안전장치(Terraform 변수):

- `allowed_tenant_ids`: 운영 허용 tenant 목록(비어 있으면 개발 모드처럼 전체 허용)
- `enable_chat_alerts`, `chat_alert_email_receivers`: `/api/chat` 실패/지연 알림 규칙 생성
- `chat_failure_count_threshold`, `chat_latency_p95_threshold_ms`: 알림 임계값

> **`terraform apply`가 `Basic VMs: 0` 또는 `Dynamic VMs: 0` 오류로 실패할 경우:** 해당 리전에 App Service 플랜을 새로 만들 수 없습니다. 아래 중 하나를 반드시 선택해야 합니다: **(A)** 같은 구독 내 기존 Linux 플랜의 리소스 ID를 `terraform.tfvars`의 `existing_linux_service_plan_resource_id`에 입력, **(B)** App Service 쿼터가 있는 구독(예: Pay-As-You-Go)으로 전환, **(C)** Azure Portal에서 쿼터 증가 요청. 이 단계를 건너뛸 수 없습니다—자세한 내용은 [문제 해결](#문제-해결) 참고.

이 스택은 **리소스 그룹**, **스토리지**(blob + Functions 호스트), **Service Bus**(처리 큐), **Linux Function App**(Node 20, extension ~4), **Application Insights**를 생성합니다. 기본적으로 **새 Linux App Service 플랜**(`B1`, 또는 `app_service_plan_sku`를 `Y1`로 설정 시 Consumption)을 만듭니다. 쿼터가 없으면 **`existing_linux_service_plan_resource_id`**를 사용하세요. Cosmos DB, AI Search, OpenAI 키는 기본적으로 꺼져 있습니다—`extra_app_settings`나 포털에서 직접 설정하세요.

**Consumption 플랜 사용:** 쿼터가 허용되면 `terraform.tfvars`에 `app_service_plan_sku = "Y1"`로 설정하세요.

## 사전 준비

- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5 이상
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) 로그인 (`az login`)
- 구독 선택: `az account set --subscription <id>`
- **Node.js** (LTS, 예: 20) — `frontend`와 `backend/functions-ingestion`에서 `npm run build` 필요
- [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) v4.x (`func`) — `func azure functionapp publish`에 필요

## 1. 인프라 프로비저닝

구독에서 App Service 플랜 생성 쿼터가 자주 0이 된다면, `terraform apply` 전에 **기존 Linux App Service 플랜**을 만들어 두거나 찾아서 (Portal → 해당 플랜 → **JSON View** / properties → **Resource ID** 복사) `infra/terraform.tfvars`에 입력하세요:

```hcl
existing_linux_service_plan_resource_id = "/subscriptions/.../resourceGroups/.../providers/Microsoft.Web/serverFarms/..."
```

```bash
cd infra
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

출력값 확인:

```bash
terraform output api_base_url
terraform output function_app_name
```

## 2. Function App 코드 배포

Functions 프로젝트에서 (`npm run build` 후):

```bash
cd ../backend/functions-ingestion
npm install
npm run build
func azure functionapp publish "$(terraform -chdir=../../infra output -raw function_app_name)"
```

`func`가 설치되어 있지 않다면 [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local)를 참고하세요.

## 3. 프론트엔드 Azure 연결

API base URL을 배포된 앱으로 설정하세요 (`terraform output api_base_url` 참고):

```bash
# frontend/.env
VITE_UPLOAD_API_BASE_URL=https://<function-app>.azurewebsites.net/api
```

SPA를 다시 빌드하고 (Static Web Apps, Storage static website 등) 호스팅하세요. 아래 두 곳에 사이트 origin을 추가해야 합니다:

- **Function App** CORS (포털 또는 `host.json`의 allowed origins)
- **Storage account** blob CORS (`blob_cors_origins` in Terraform, 또는 포털) — 브라우저에서 PUT 업로드 허용

## 4. GitHub Actions CI/CD (권장)

이 레포는 인프라/백엔드와 프론트를 분리 배포합니다.

- `/.github/workflows/infra-functions-deploy.yml`
  - 트리거: `infra/**`, `backend/functions-ingestion/**` 변경 또는 수동 실행
  - 순서: `terraform plan` → `terraform apply` → `npm run build` → `func azure functionapp publish`
  - 이유: Terraform 적용 후 Function App 런타임 설정이 바뀔 수 있어, 같은 파이프라인에서 함수 코드를 바로 재배포해 404 재발을 막음

- `/.github/workflows/azure-static-web-apps.yml`
  - 트리거: `frontend/**` 변경 또는 수동 실행
  - 역할: React 빌드 후 Azure Static Web Apps 배포

필수 GitHub Secrets:

- `AZURE_CREDENTIALS`: Azure 로그인용 서비스 프린시펄 JSON
- `AZURE_STATIC_WEB_APPS_API_TOKEN`: Static Web App 배포 토큰

`AZURE_CREDENTIALS` 형식(키 이름 대소문자 포함):

```json
{
   "clientId": "<appId>",
   "clientSecret": "<password>",
   "subscriptionId": "<subscription-id>",
   "tenantId": "<tenant-id>"
}
```

생성 예시:

```bash
az ad sp create-for-rbac \
   --name "rag-azure-gha" \
   --role Contributor \
   --scopes /subscriptions/<subscription-id> \
   --json-auth
```

로그에 `Not all values are present`가 보이면, 대부분 `AZURE_CREDENTIALS`가 비어 있거나 위 4개 키 중 일부가 누락된 상태입니다.

보안 권장:

- 브라우저 번들에 노출되는 `VITE_*` 환경 변수에는 비밀키(Functions host key, Search admin key 등)를 넣지 않음
- 운영 환경은 APIM + JWT(Entra ID) 또는 별도 인증 계층으로 API 보호

## 5. 선택적 백엔드: Azure AI Search, Cosmos DB, OpenAI

Terraform은 기본적으로 **Cosmos DB**와 **Azure AI Search**를 꺼둡니다 (`COSMOS_DB_ENABLED` / `SEARCH_ENABLED`가 `false`이고 endpoint가 비어 있음). [문서 카탈로그](../backend/functions-ingestion/src/functions/listDocumentCatalog.ts) API가 **503**이 아닌 **200**을 반환하려면 최소한 **Search** 또는 **Cosmos**를 켜야 합니다 ([문제 해결: 문서 카탈로그 503](#문서-카탈로그-503) 참고).

SPA의 상태 카드들은 `GET /api/flags/deployment` API로 동작합니다:

- **Cosmos · document state**: Cosmos 메타데이터 쓰기 활성화 여부
- **AI Search · indexing**: Search 인덱싱/쿼리 활성화 여부
- **Chat answers = Search snippets only**: OpenAI 키가 없을 때의 정상적인 fallback 모드 (런타임 에러 아님)

설정 이름은 [`backend/functions-ingestion/local.settings.json.example`](../backend/functions-ingestion/local.settings.json.example)과 동일합니다.

### 4.1 Azure AI Search (기존 서비스 사용)

이미 Search 서비스가 있다면(예: `rag-search-core`), 새로 만들 필요 없이 해당 서비스 정보를 Function App에 환경 변수로 연결하면 됩니다.

**리전이 달라도 무방:** Function App과 Search가 서로 다른 리전에 있어도 HTTPS로 통신하므로 문제 없습니다(지연만 다를 수 있음).

**인덱스 이름:** 기본값은 **`rag-chunks`**입니다. Search 서비스에서 다른 인덱스명을 쓴다면 Function App의 `SEARCH_INDEX_NAME`을 맞춰주세요. Search가 활성화되면 Functions 코드가 인덱스 스키마를 자동으로 생성/업데이트합니다(직접 관리할 경우만 포털에서 미리 생성).

#### 방법 A — Azure Portal

1. **Azure AI Search** 리소스(예: `rag-search-core`)로 이동
2. **개요(Overview)** → **Url** 복사 (예: `https://<service-name>.search.windows.net`) → `SEARCH_ENDPOINT`
3. **설정(Settings)** → **키(Keys)** → **Admin key** 복사 → `SEARCH_API_KEY`
4. **Function App** → **설정(Settings)** → **구성(Configuration)** → **애플리케이션 설정(Application settings)** → **+ 새 애플리케이션 설정** (또는 기존 값 수정)
   - `SEARCH_ENABLED` = `true`
   - `SEARCH_ENDPOINT` = 2번에서 복사한 URL
   - `SEARCH_API_KEY` = 3번에서 복사한 키
   - `SEARCH_INDEX_NAME` = `rag-chunks`가 아닐 경우만 입력
5. **저장 후 앱 재시작**

**확인:** `GET https://<function-app>.azurewebsites.net/api/documents/catalog?tenantId=<tenant>` 호출 시 **200** 반환(업로드/인덱싱 전이면 빈 배열일 수 있음)

#### 방법 B — Terraform `extra_app_settings`

비밀키는 커밋하지 마세요. `terraform.tfvars`는 gitignore 처리하고, Search 키는 `extra_app_settings`로 병합(예시는 [`infra/terraform.tfvars.example`](../infra/terraform.tfvars.example) 참고):

```hcl
extra_app_settings = {
   SEARCH_ENABLED   = "true"
   SEARCH_ENDPOINT  = "https://<your-search-service>.search.windows.net"
   SEARCH_API_KEY   = "<admin-key-from-portal>"
   # SEARCH_INDEX_NAME = "custom-index"  # 기본값(rag-chunks)이면 생략
}
```

적용:

```bash
cd infra
terraform apply
```

### 4.2 Cosmos DB (선택)

문서 메타데이터 저장에 Cosmos를 사용하려면: `COSMOS_DB_ENABLED` = `true`로 설정하고, `COSMOS_ENDPOINT`, `COSMOS_KEY`, 필요시 `COSMOS_DATABASE_ID` / `COSMOS_DOCUMENTS_CONTAINER_ID`도 지정하세요(기본값은 `local.settings.json.example` 참고). Portal이나 `extra_app_settings` 방식은 Search와 동일합니다.

Cosmos를 **나중에** 활성화하면, 기존에 Search에만 인덱싱된 문서는 카탈로그에서 `Cosmos = —`로 표시됩니다. 이때는 아래 스크립트로 메타데이터를 백필하세요:

```bash
cd backend/functions-ingestion
COSMOS_DB_ENABLED=true \
COSMOS_ENDPOINT="https://<account>.documents.azure.com:443/" \
COSMOS_KEY="<key>" \
SEARCH_ENABLED=true \
SEARCH_ENDPOINT="https://<service>.search.windows.net" \
SEARCH_API_KEY="<admin-key>" \
npm run cosmos:backfill
```

백필 스크립트용 환경 변수(선택):

- `BACKFILL_TENANT_ID` — 특정 tenant만 백필
- `BACKFILL_MAX_CHUNKS` — 최대 검색 스캔 수(기본 5000)
- `BACKFILL_PAGE_SIZE` — 페이지 크기(최대 1000)
- `BACKFILL_DRY_RUN=true` — Cosmos에 쓰지 않고 요약만 출력

### 4.3 OpenAI / 임베딩 (선택)

Chat, 임베딩, 일부 인제스트 경로는 추가 키(`AZURE_OPENAI_*`, `OPENAI_API_KEY`, `EMBEDDING_ENABLED` 등)가 필요합니다. `local.settings.json.example`을 참고해 필요한 것만 활성화하세요.

이 키들이 없어도 `POST /api/chat`은 **search-only fallback mode**로 동작합니다. 검색된 chunk와 citation만으로 답변을 생성하므로, LLM 기반 생성 활성화 전 인제스트 품질 검증에 유용합니다.

## 6. 배포 후 체크리스트

`terraform apply`와 `func azure functionapp publish` 이후 아래 항목을 확인하세요.

- [ ] **Functions 빌드 포함:** 매번 배포 전 `backend/functions-ingestion`에서 `npm run build` 실행. 이 저장소는 `.gitignore`에서 `backend/functions-ingestion/dist/`를 제외시켜 Core Tools가 빌드된 JS를 포함하도록 함([404 문제 해결](#function-라우트-404) 참고).
- [ ] **순서 고정:** `terraform apply`가 Function App `app_settings`를 다시 쓰면 `WEBSITE_RUN_FROM_PACKAGE`가 지워져 라우트가 404가 될 수 있다. **apply 후에는 항상 `func azure functionapp publish`를 다시 실행**.
- [ ] **API URL:** `terraform output api_base_url`이 `frontend/.env`의 `VITE_UPLOAD_API_BASE_URL`과 일치(끝에 `/api` 포함).
- [ ] **카탈로그 503 아님:** Search 또는 Cosmos 중 하나 이상이 활성화되어 있고 endpoint/key가 유효([§4.1](#41-azure-ai-search-기존-서비스-사용) / [§4.2](#42-cosmos-db-선택)).
- [ ] **기존 Search 문서 백필:** Cosmos를 나중에 켰다면, 예전 카탈로그 행도 Cosmos 메타데이터가 보이게 하려면 `npm run cosmos:backfill` 실행.
- [ ] **브라우저 Blob 업로드:** Storage 계정 **CORS**에 SPA origin과 `PUT` 허용(Terraform `blob_cors_origins`; Static Web Apps URL 추가 시 재적용).
- [ ] **Function CORS:** 위와 동일한 origin(Function App `site_config.cors`는 `blob_cors_origins`와 동일하게 설정).
- [ ] **운영 보안 강화:** `ALLOWED_TENANT_IDS`에 허용할 tenant ID를 콤마로 구분해 입력. UI에서 입력된 tenant만 신뢰하지 마세요([security-and-pitch.md](./security-and-pitch.md)).
- [ ] **관측성:** Application Insights가 Function App에 기본 연결됨. Portal → Function App → **Application Insights** 또는 **Log stream**에서 큐/Blob/HTTP 오류 디버깅.
- [ ] **채팅 알림:** Terraform에서 `enable_chat_alerts=true`, `chat_alert_email_receivers=[...]`를 설정하면 `/api/chat` 실패 건수 및 p95 지연 알림 규칙이 생성됨.
- [ ] **API 경계 보안:** Function key 단독 운영 대신 APIM + 인증 계층(Entra ID/JWT 검증)으로 외부 진입점을 보호.

### HTTP 라우트 (빠른 참고)

경로는 모두 `https://<function-app>.azurewebsites.net/api` 기준입니다.

| 라우트                                          | 용도                                       |
| ----------------------------------------------- | ------------------------------------------ |
| `GET flags/deployment`                          | 런타임 기능 플래그(비밀 없음)              |
| `GET documents/catalog?tenantId=`               | Cosmos + Search 병합 문서 목록             |
| `DELETE documents/{documentId}/purge?tenantId=` | Search chunk + Cosmos 행 삭제(Blob은 아님) |
| `POST uploads/create`                           | 브라우저 PUT 업로드용 SAS + 메타데이터     |
| `POST chat`                                     | RAG 챗                                     |

여러 핸들러가 로컬/데모 편의를 위해 `authLevel: anonymous`를 사용합니다. 실제 운영 환경에서는 APIM, VNet, 인증 등으로 잠그세요.

### APIM/인증 계층 권장안

- 외부 호출은 APIM으로 강제하고 Function App은 APIM 백엔드로만 노출
- APIM에서 JWT 검증(Entra ID), rate limit, IP 필터, 요청 크기 제한 적용
- Function key는 APIM->Function 내부 호출용 보조 수단으로만 사용
- `tenantId`는 클라이언트 body 대신 토큰 클레임과 매핑해 서버에서 재검증

## 문제 해결

### Function 라우트 404

증상: `GET /api/documents/catalog`, `GET /api/flags/deployment` 등 HTTP 라우트가 Azure에서는 **404**를 반환(로컬에서는 정상 동작).

`func azure functionapp publish`는 **.gitignore**를 따릅니다. 만약 `backend/functions-ingestion/dist/`가 무시되고 있었다면, zip에 빌드된 JS가 포함되지 않아 Azure에 라우트가 등록되지 않아 404가 발생합니다. 이 저장소는 `!backend/functions-ingestion/dist/`로 예외 처리되어 있습니다. 변경사항을 pull한 뒤 `npm run build` 실행 후 **`func azure functionapp publish …` 재실행**하세요.

### 문서 카탈로그 503

증상: `GET /api/documents/catalog?tenantId=…`가 **503**과 함께 JSON 본문을 반환(Cosmos와 Search 모두 비활성화).

Functions 앱은 **Cosmos DB**와 **Azure AI Search**가 모두 꺼져 있으면 **503**을 반환합니다(`COSMOS_DB_ENABLED`, `SEARCH_ENABLED`가 모두 `true`가 아님). 기본 Terraform `app_settings`는 이 둘을 꺼둡니다.

**해결:** 카탈로그가 읽을 수 있는 백엔드(Search 또는 Cosmos) 중 하나 이상을 활성화하세요:

- **Search만 사용:** `terraform.tfvars`의 `extra_app_settings`에 `SEARCH_ENABLED = "true"`, `SEARCH_ENDPOINT`, `SEARCH_API_KEY`(필요시 `SEARCH_INDEX_NAME`)를 추가 후 `terraform apply` 및 앱 재시작. 또는 포털에서 동일하게 설정.
- **Cosmos 사용:** `COSMOS_DB_ENABLED = "true"`와 `COSMOS_ENDPOINT`, `COSMOS_KEY`, (필요시 컨테이너/DB ID) 설정.

둘 중 하나라도 활성화되기 전까지는 503과 함께 비활성화 안내 JSON이 반환됩니다.

### 챗이 검색 스니펫만 답변할 때

증상: 챗 패널이 검색 기반 요약만 반환하고, 상태 카드에 **Chat answers → Search snippets only**가 표시됨.

이는 `OPENAI_API_KEY`나 `AZURE_OPENAI_API_KEY`가 설정되지 않았을 때의 정상적인 fallback입니다. 검색은 정상 동작하며 citation도 반환되지만, LLM을 호출해 최종 답변을 생성하지 않습니다.

**해결:** Function App에 OpenAI 또는 Azure OpenAI 키를 설정 후 앱을 재시작/설정 재적용하세요. 그 전까지는 ingestion 품질/tenant 필터 검증에 fallback 모드가 유용합니다.

### 브라우저 CORS 에러 (Failed to fetch)

대부분 **CORS** 문제: 페이지는 `http://localhost:5173`에서 실행, 요청은 `https://<functionapp>.azurewebsites.net`로 전송. `terraform apply` 후 Function App의 `site_config.cors`는 `blob_cors_origins`와 동일한 origin을 사용합니다(localhost 포함). origin을 변경했다면 `terraform apply`를 다시 실행하세요.

**DevTools → Network**에서 빨간 요청 + CORS 에러가 보이면 확실합니다. 포털 → Function App → **CORS**에서 `http://localhost:5173`(및 실제 SPA URL) 추가도 가능.

`frontend/.env`의 **`VITE_UPLOAD_API_BASE_URL=https://<app>.azurewebsites.net/api`**(끝에 `/api` 포함)도 확인하세요.

### Service Bus 네임스페이스 이름 오류

Azure는 `-sb` 또는 `-mgmt`로 끝나는 네임스페이스 이름을 예약합니다. 이 저장소는 `"{project}-sb-{random}"` 패턴을 사용해 충돌을 피합니다.

### App Service 플랜 쿼터 문제

Terraform 또는 Azure에서 **Dynamic VMs: 0** 또는 **Basic VMs: 0**(새 Linux App Service 플랜 생성 불가) 오류가 발생할 때.

일부 구독(예: Azure for Students, 제한이 심한 테넌트)은 두 쿼터 모두 0일 수 있습니다. 이 경우 Terraform은 새 App Service 플랜을 만들 수 없습니다.

해결 방법:

1. **포털** → Subscriptions → **Usage + quotas** → **App Service** / **Basic small vCPU** 쿼터 증가 요청(또는 Pay-As-You-Go 구독 사용)
2. `terraform.tfvars`의 `location`을 다른 리전(예: `westus2`)으로 변경
3. **같은 구독 내 기존 Linux App Service 플랜 재사용:**
   ```hcl
   existing_linux_service_plan_resource_id = "/subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Web/serverFarms/<PLAN_NAME>"
   ```
   이 경우 `terraform apply`는 `azurerm_service_plan` 생성을 건너뛰고 해당 플랜에 Function App을 연결합니다(플랜 리전에 Function App 생성, Storage/Service Bus는 기존 location 유지).

**Terraform 프롬프트:** 반드시 영문 `yes`만 입력하세요(한글 IME로 `ㅛyes` 입력 시 인식 안 됨).

## 삭제

```bash
cd infra
terraform destroy
```
