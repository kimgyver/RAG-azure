# Azure RAG 문서 처리 파이프라인 프로젝트

## 목표

이 프로젝트는 실무형 스토리를 바탕으로 만든 개인 Azure 네이티브 포트폴리오 프로젝트다.

- 사용자가 파일과 이미지를 업로드한다.
- 업로드된 파일은 Azure Blob Storage에 저장된다.
- 이벤트 기반 파이프라인이 문서를 검증하고, 큐에 넣고, 비동기로 처리한다.
- OCR과 텍스트 추출을 통해 검색 가능한 콘텐츠를 만든다.
- 메타데이터는 Azure Cosmos DB에 저장한다.
- 청크 단위 텍스트와 임베딩은 Azure AI Search에 저장한다.
- RAG 챗봇은 테넌트 범위로 문서를 검색하고 Azure OpenAI로 답변을 생성한다.

이 프로젝트의 목적은 단순한 CRUD 앱이 아니라 다음을 보여주는 데 있다.

- 이벤트 기반 아키텍처
- 비동기 처리
- 멀티테넌트 설계
- Azure 네이티브 서비스 활용
- 운영 환경에 가까운 책임 분리
- RAG 기반 검색 및 챗봇

## 상위 아키텍처

```text
[React 프론트엔드]
    |
    | 1. 업로드 권한 요청
    v
[업로드 API - Azure Functions HTTP]
    |
    | 2. SAS URL 반환
    v
[Azure Blob Storage]
    |
    | 3. 브라우저가 Blob으로 직접 업로드
    |
    | 4. Blob 생성 이벤트 발생
    v
[Function: Blob Trigger / Validation]
    |
    | 5. 파일 검증 후 작업 큐에 등록
    v
[Azure Service Bus Queue]
    |
    | 6. Queue Trigger가 작업 수신
    v
[Function: Processing Worker]
    |
    | 7. OCR / 파싱 / 텍스트 추출
    | 8. 청킹
    | 9. 임베딩 생성
    |
    +--> [Azure Cosmos DB] 메타데이터, 상태, 문서 기록
    |
    +--> [Azure AI Search] 청크, 벡터, 검색 인덱스
    |
    v
[Chat API - Azure Functions HTTP 또는 Web App]
    |
    | 10. 검색 + 프롬프트 조합
    v
[Azure OpenAI]
    |
    | 11. 출처가 포함된 답변 생성
    v
[프론트엔드]
```

## SAS 기반 Direct Upload를 쓰는 이유

Direct upload는 브라우저가 파일 전체를 백엔드 서버로 보내지 않고 Azure Blob Storage에 바로 업로드하는 방식이다.

### 이 방식이 Azure Functions를 안 쓴다는 뜻은 아니다

Azure Functions는 그대로 사용하지만 역할이 달라진다.

Direct upload가 없으면:

```text
브라우저 -> Function App -> Blob Storage
```

SAS 기반 direct upload를 쓰면:

```text
브라우저 -> Function App (SAS 발급만) -> 브라우저 -> Blob Storage
```

### 권장 흐름

1. 프론트엔드가 업로드 권한을 요청하는 HTTP API를 호출한다.
2. 백엔드는 짧은 만료 시간과 제한된 권한을 가진 SAS URL을 생성한다.
3. 프론트엔드는 그 SAS URL을 사용해 Blob Storage로 파일을 직접 업로드한다.
4. Blob Storage가 이벤트를 발생시킨다.
5. Blob Trigger 기반 처리가 시작된다.

### 이 방식이 더 나은 이유

- API 서버가 대용량 파일을 중계할 필요가 없다.
- 업로드가 더 빠르고 비용 효율적이다.
- 백엔드 메모리와 연결 수 사용량이 낮아진다.
- 파일 업로드 시스템에서 흔히 쓰이는 운영 패턴이다.

## 전체 처리 순서

### 1단계: 사용자가 문서를 업로드함

1. 사용자가 프론트엔드에서 PDF, 이미지, 또는 문서를 선택한다.
2. 프론트엔드는 `/api/uploads/create` 같은 HTTP 엔드포인트를 호출한다.
3. 백엔드는 tenant와 user 컨텍스트를 확인한다.
4. 백엔드는 다음 값을 생성한다.
   - blob path
   - document id
   - 짧게 살아있는 SAS URL
5. 백엔드는 다음 값을 반환한다.
   - upload URL
   - blob path
   - document id
6. 프론트엔드는 해당 URL로 Blob Storage에 파일을 직접 업로드한다.
7. 필요하면 업로드 완료 API를 따로 호출할 수 있지만, Blob Trigger를 쓰는 경우 필수는 아니다.

### 2단계: 검증 및 큐 등록

1. Blob Storage가 파일을 수신한다.
2. Blob Trigger 함수가 실행된다.
3. 함수는 다음과 같은 가벼운 검증을 수행한다.
   - 파일 크기
   - content type
   - 허용된 확장자
   - 필요하다면 중복 파일 검출
4. 함수는 Cosmos DB의 메타데이터 레코드를 생성하거나 갱신한다.
   - status = uploaded 또는 queued
   - tenantId
   - documentId
   - blob URL 또는 blob name
   - 타임스탬프
5. 함수는 Azure Service Bus Queue로 처리 메시지를 발행한다.

### 3단계: 무거운 처리 수행

1. Queue Trigger 함수가 메시지를 수신한다.
2. 처리 워커가 Blob Storage에서 원본 파일을 내려받는다.
3. 워커가 텍스트를 추출한다.
   - 이미지 또는 스캔 PDF는 OCR 사용
   - 텍스트 기반 문서는 파싱 사용
4. 워커는 텍스트를 정제하고 정규화한다.
5. 워커는 텍스트를 청크로 나눈다.
6. 워커는 Azure OpenAI를 사용해 각 청크의 임베딩을 생성한다.
7. 워커는 다음 데이터를 저장한다.
   - 운영 메타데이터는 Cosmos DB
   - 청크 레코드와 벡터는 Azure AI Search
8. 워커는 문서 상태를 갱신한다.
   - processing
   - indexed
   - failed
9. 실패 시에는 큐 재시도 정책 또는 dead-letter queue로 재처리한다.

현재 로컬 구현 상태:

- Blob Trigger와 Service Bus Queue Trigger가 연결되어 있다.
- 텍스트/PDF 문서는 청킹 후 Azure AI Search `rag-chunks` 인덱스로 적재된다.
- Cosmos DB `documents` 컨테이너에는 문서별 상태와 처리 메타데이터가 저장된다.

### 4단계: 챗 검색 및 응답 생성

1. 사용자가 채팅 UI에서 질문한다.
2. 프론트엔드는 `/api/chat`을 호출한다.
3. Chat API는 사용자를 인증하고 tenant 컨텍스트를 결정한다.
4. 백엔드는 사용자 질문으로부터 query embedding을 생성한다.
5. Azure AI Search는 다음 조합으로 검색을 수행한다.
   - 벡터 검색
   - 키워드 검색
   - 하이브리드 랭킹
   - tenant 필터
6. API는 상위 매칭 청크를 수집한다.
7. 백엔드는 다음 요소로 프롬프트를 조립한다.
   - 사용자 질문
   - 선택된 문서 청크
   - 시스템 지시문
   - 선택적으로 대화 이력 요약
8. Azure OpenAI가 최종 답변을 생성한다.
9. API는 다음을 반환한다.
   - answer
   - citations
   - 매칭된 문서 참조

현재 구현 상태:

- `POST /api/chat` 엔드포인트가 `tenantId` 필터를 적용해 Azure AI Search에서 관련 청크를 조회한다.
- `EMBEDDING_ENABLED=true` 설정 시 질문의 임베딩을 생성해 벡터 + 키워드 하이브리드 검색으로 전환한다.
- `OPENAI_API_KEY` 설정 시 Azure OpenAI 또는 OpenAI GPT로 최종 답변을 생성한다.
- 응답에는 answer, citations, retrievedChunks 수가 포함된다.

## Azure 서비스별 역할

### Azure Blob Storage

다음 용도로 사용한다.

- 원본 업로드 파일
- 필요하다면 추출 산출물
- 선택적으로 전체 텍스트 보관본

다음 용도로는 사용하지 않는다.

- 챗 검색 로직
- 질의 가능한 메타데이터 저장

### Azure Functions

다음 용도로 사용한다.

- SAS URL 발급
- Blob Trigger 검증
- Queue Trigger 처리 워커
- 가벼운 HTTP API

잘 맞는 이유:

- 이벤트 기반 처리에 적합함
- 서버리스 확장이 가능함
- Blob과 Service Bus 트리거를 기본 지원함

### Azure Service Bus

다음 용도로 사용한다.

- 업로드와 무거운 처리를 분리
- 재시도 및 backpressure 처리
- 안정적인 비동기 워크플로우 구성

중요한 이유:

- OCR과 추출 작업은 검증보다 느리고 무겁다.
- 큐를 사용하면 업로드 지연이 처리 지연과 묶이지 않는다.

### Azure Cosmos DB

주 벡터 검색 계층이 아니라 운영 데이터와 애플리케이션 데이터를 저장하는 용도로 사용한다.

권장 저장 항목:

- 문서 메타데이터
- 처리 상태
- 업로드 감사 필드
- 채팅 세션 메타데이터
- 필요하다면 대화 상태

문서 메타데이터 예시:

```json
{
  "id": "doc_123",
  "tenantId": "tenant_a",
  "documentId": "doc_123",
  "fileName": "contract.pdf",
  "blobName": "tenant_a/2026/04/doc_123.pdf",
  "status": "indexed",
  "contentType": "application/pdf",
  "createdAt": "2026-04-13T10:00:00Z",
  "updatedAt": "2026-04-13T10:05:00Z"
}
```

### Azure AI Search

검색 계층이자 벡터 인덱스로 사용한다.

권장 필드:

- chunk id
- tenantId
- documentId
- chunk text
- embedding vector
- file name
- page number
- chunk index

인덱싱된 청크 예시:

```json
{
  "id": "doc_123_chunk_01",
  "tenantId": "tenant_a",
  "documentId": "doc_123",
  "content": "The customer may terminate the agreement with 30 days notice...",
  "chunkIndex": 1,
  "page": 2,
  "fileName": "contract.pdf",
  "embedding": [0.123, 0.456, 0.789]
}
```

RAG 검색 계층으로 Cosmos DB보다 Azure AI Search를 우선 추천하는 이유:

- 벡터 검색 지원이 더 강함
- 하이브리드 검색이 내장되어 있음
- 키워드 검색과 벡터 검색을 한 요청에서 처리 가능함
- semantic ranking 사용 가능함
- tenantId 기반 필터링이 자연스러움

### Azure OpenAI

다음 용도로 사용한다.

- 임베딩 생성
- 최종 답변 생성

권장 분리:

- 청크 및 질의 벡터 생성을 위한 embeddings model
- RAG 응답 생성을 위한 chat/completion model

## Cosmos DB 설계 가이드

tenant 범위 접근이 많다는 점은 `tenantId`를 시작점으로 삼기에 좋은 이유지만, 설명은 신중하게 해야 한다.

### 좋은 설명 방식

- 대부분의 조회는 tenant 단위다.
- 데이터 격리를 위해 tenant 필터링이 필요하다.
- `tenantId`는 핵심 질의 패턴과 잘 맞는다.

### 더 현실적으로 들리게 설명하는 법

`tenantId`를 모든 상황에서 절대적으로 옳은 선택처럼 말하지 않는 편이 낫다.

더 나은 설명은 다음과 같다.

- 대부분의 읽기와 쓰기가 tenant 범위라서 `tenantId`로 시작했다.
- 파티션 크기 증가와 hot tenant 위험을 모니터링했다.
- tenant 규모가 커지면 hierarchical partitioning이나 synthetic key 전략으로 확장할 수 있게 설계했다.

### 권장 컨테이너

1. `documents`
   - 목적: 파일 메타데이터와 상태 저장
   - 파티션 키: `/tenantId`
2. `conversations`
   - 목적: 채팅 스레드 또는 요약 저장
   - 파티션 키: 접근 패턴에 따라 `/conversationId` 또는 `/tenantId` 고려
3. `processing_logs` 선택 사항
   - 목적: 파이프라인 이벤트 또는 감사 로그 저장
   - 파티션 키: `/tenantId`

## 청킹 전략

청킹은 RAG 품질을 결정하는 핵심 요소다.

### 권장 시작점

- chunk size: 300~500 tokens
- overlap: 50~100 tokens
- strategy: 문단 또는 문장 경계를 고려한 chunking

### 추출된 전체 문서를 그대로 검색용으로 쓰지 않는 이유

검색이 전체 문서 단위로 동작하면:

- 임베딩 품질이 떨어진다.
- 검색 정밀도가 낮아진다.
- 프롬프트 컨텍스트에 노이즈가 많아진다.
- 비용이 증가한다.

청킹을 적용하면 다음이 좋아진다.

- 검색 정확도
- 답변 근거성
- 컨텍스트 효율
- 인용 품질

## Chat API는 Functions와 Web App 중 무엇이 좋은가

이 질문은 철학 문제가 아니라 워크로드 문제다.

### 다음 조건이면 Azure Functions로 시작해도 좋다

- Azure 네이티브 서버리스 스토리를 일관되게 가져가고 싶다.
- 챗이 대부분 request-response HTTP 형태다.
- MVP 호스팅을 단순하게 가져가고 싶다.
- API 레이어가 stateless해도 괜찮다.

### 다음 조건이면 Web App으로 분리하는 편이 낫다

- 더 복잡한 스트리밍 동작이 필요하다.
- 풍부한 미들웨어와 세션 제어가 필요하다.
- 사용자용 API를 장기적으로 더 많이 커스터마이징할 계획이다.
- 이벤트 워커와 사용자-facing API를 더 명확히 분리하고 싶다.

### 실무적인 권장안

MVP 단계:

- ingestion pipeline: Azure Functions
- chat API: Azure Functions HTTP

고도화 단계:

- ingestion은 계속 Functions 유지
- 스트리밍과 앱 복잡도가 커지면 chat API만 Web App으로 이동

## 개발 언어 추천

### 기본 추천

TypeScript with Node.js 20

이유:

- React 프론트엔드와 잘 맞는다.
- Azure Functions 지원이 좋다.
- 프론트와 백엔드 간 타입 공유가 가능하다.
- 제품 개발 속도와 클라우드 통합 측면의 균형이 좋다.

### 대안

문서 처리 자체가 가장 중요하다면 Python도 강하다.

Python이 잘 맞는 경우:

- OCR, 파싱, NLP 실험이 우선이다.
- AI 관련 라이브러리로 더 빠르게 실험하고 싶다.

### 이 프로젝트에서 가장 현실적인 선택

우선은 전 구간을 TypeScript로 시작한다.
문서 처리 품질이 병목이 되면 그때 worker만 Python으로 분리한다.

## Infrastructure as Code 권장 방식

Terraform은 쓰는 게 맞지만, 가장 처음 할 일은 아니다.

### 가장 좋은 순서

1. 먼저 동작하는 로컬 MVP 흐름을 만든다.
2. 최소한의 Azure 리소스로 클라우드 연동을 검증한다.
3. 서비스 경계가 안정되면 Terraform을 추가한다.

### 이 순서가 더 나은 이유

처음부터 인프라부터 시작하면:

- 앱 흐름이 검증되기 전에 프로비저닝에 시간을 많이 쓴다.
- 구현 중 요구사항이 계속 바뀐다.

반대로 IaC를 끝까지 추가하지 않으면:

- 프로젝트 완성도가 떨어져 보인다.
- 환경 재현성이 없다.

### 최종 권장안

앱 코드와 Terraform은 같은 리포지터리에 두되, 디렉터리로 분리한다.

## 권장 리포지터리 구조

```text
/infra
  /modules
  /environments
    /dev
    /prod
/frontend
/backend
  /functions-ingestion
  /functions-chat
/shared
/docs
```

### 각 폴더의 역할

- `infra`: Azure 리소스용 Terraform
- `frontend`: React 앱
- `backend/functions-ingestion`: upload, blob trigger, queue trigger
- `backend/functions-chat`: chat 및 search HTTP API
- `shared`: DTO와 공용 타입
- `docs`: 아키텍처 메모와 의사결정 기록

## MVP 범위

아키텍처를 증명할 수 있는 가장 작은 버전을 먼저 만든다.

### MVP 기능

- PDF 또는 이미지 업로드
- 백엔드에서 SAS URL 발급
- Blob Storage로 direct upload
- Blob Trigger에서 업로드 검증
- Service Bus에 처리 작업 등록
- 우선 한 가지 파일 타입만 텍스트 추출
- 텍스트 청킹 및 임베딩 생성
- 청크를 Azure AI Search에 인덱싱
- 문서 상태를 Cosmos DB에 저장
- tenant 필터 기반으로 청크 검색 후 질문 응답
- citations가 포함된 grounded answer 반환

### 나중에 추가할 만한 기능

- dead-letter queue 처리
- 재시도 대시보드
- 대화 이력 저장
- 문서 재인덱싱
- 스트리밍 응답
- semantic ranking 튜닝
- chunk versioning
- 역할 기반 접근 제어

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
- 문서 처리 상태 예시와 챗 메시지 예시를 포함해 전체 흐름을 시각적으로 확인 가능

실행 방법:

```bash
cd frontend
npm install
npm run dev
```

검증 방법:

- 업로드 카드가 보이는지 확인
- 최근 문서 상태 목록이 보이는지 확인
- 채팅 입력창과 샘플 메시지 영역이 보이는지 확인

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

```bash
cd backend/functions-ingestion
cp local.settings.json.example local.settings.json
```

2. `local.settings.json`에서 아래 항목 값 입력

- `AZURE_STORAGE_ACCOUNT_NAME`
- `AZURE_STORAGE_ACCOUNT_KEY`
- `AZURE_STORAGE_CONTAINER_NAME`
- `SAS_EXPIRY_MINUTES`

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
- 로컬 개발 환경에서 Vite proxy를 통해 Azurite 업로드 검증 완료

### Step 4: Blob Trigger 검증

Blob이 생성되면:

- 메타데이터 검증
- Cosmos DB에 초기 레코드 저장
- 처리 메시지를 큐에 등록

현재 구현 상태:

- `blob-validate-and-enqueue` Blob Trigger 함수 추가
- 업로드 파일 크기 검증(`MAX_UPLOAD_SIZE_MB`) 추가
- 검증 통과 시 Azure Service Bus `processing-jobs` 큐로 처리 메시지 등록
- 로컬 Azurite 환경에서는 `BLOB_TRIGGER_SOURCE=LogsAndContainerScan`으로 동작
- 클라우드 배포 시 `SERVICE_BUS_CONNECTION` 환경 변수에 Service Bus 연결 문자열 설정 필요

### Step 5: 처리 워커

Queue Trigger 기반 워커를 구현한다.
처음에는 한 가지 문서 타입과 한 가지 추출 전략만 지원해도 충분하다.

현재 구현 상태:

- `processing-worker` Service Bus Queue Trigger 함수 추가
- 큐 메시지 역직렬화 및 처리 시작 로그 구현
- Blob Storage에서 원본 파일 다운로드 후 텍스트 추출 구현 완료
- 텍스트 기반 파일(`.txt`, `.md`, `.csv`, `.json`, `text/*`) 및 PDF 파싱 지원

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
- `OPENAI_API_KEY` 설정 시 Azure OpenAI 또는 OpenAI GPT로 최종 답변 생성
- 응답에 answer, citations(문서 출처), retrievedChunks 수 포함
- 미설정 환경에서는 검색 결과 스니펫 요약으로 graceful fallback 동작

비교 테스트 방법:

- `CHAT_SEARCH_MODE=keyword`
  - 키워드 검색만 사용
- `CHAT_SEARCH_MODE=hybrid`
  - 키워드 + 벡터 검색 동시 사용
- `CHAT_SEARCH_MODE=vector`
  - 질문 임베딩만 사용해 검색 (`EMBEDDING_ENABLED=true` 필요)

백엔드 재시작 후 같은 질문을 반복하고, Functions 로그의 `Chat search executed.`를 비교하면 된다.

### Step 9: Terraform 정리

서비스 경계가 안정되면 인프라를 코드로 옮긴다.

### Step 10: 관측성과 안정성 보강

다음을 추가한다.

- Application Insights
- correlation ID
- 재시도 정책
- DLQ 처리
- 상태 전이 관리

## 보안 및 운영 메모

- SAS 토큰은 짧은 만료 시간으로 유지한다.
- Azure 리소스 접근은 가능하면 Functions의 managed identity를 우선 사용한다.
- storage account key를 프론트엔드에 노출하지 않는다.
- 모든 chat 요청에서 tenantId 필터를 강제한다.
- UI가 진행 상태를 보여줄 수 있도록 문서 상태 전이를 관리한다.
- 실패는 retry count와 dead-letter 동작까지 추적한다.

## 인터뷰용 설명 문장

프로젝트를 더 강하게 설명하려면 다음처럼 말할 수 있다.

> Built an Azure-native document intelligence and RAG platform where users upload files directly to Blob Storage through SAS-based direct upload, event-driven Azure Functions validate and enqueue processing through Service Bus, OCR and chunking pipelines store operational metadata in Cosmos DB and retrieval data in Azure AI Search, and a tenant-filtered chatbot uses Azure OpenAI to answer questions with grounded citations.

## 최종 권장안

신뢰도 있는 포트폴리오 프로젝트를 목표로 한다면, 가장 균형 잡힌 선택은 다음과 같다.

- React 프론트엔드
- TypeScript 백엔드
- ingestion pipeline은 Azure Functions
- 파일 저장은 Azure Blob Storage
- 비동기 처리는 Azure Service Bus
- 메타데이터와 상태 저장은 Azure Cosmos DB
- 벡터 및 하이브리드 검색은 Azure AI Search
- 임베딩과 답변 생성은 Azure OpenAI
- Terraform은 MVP 흐름이 검증된 뒤에 추가

이 조합이면 시스템이 현실적이고, Azure 네이티브이며, 설명 가능성이 높다.
