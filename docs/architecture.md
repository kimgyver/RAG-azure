# 아키텍처와 데이터 흐름

[← README로 돌아가기](../README.md)

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
   - 래스터 이미지(PNG, JPEG 등)는 Tesseract OCR 사용(설정으로 끌 수 있음)
   - PDF는 내장 텍스트 레이어 파싱(`pdf-parse`). 스캔 전용 PDF는 별도 Document Intelligence 등이 필요
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
- 텍스트·PDF(텍스트 레이어)·이미지(OCR 성공 시)는 청킹 후 `SEARCH_ENABLED=true`이면 Azure AI Search `rag-chunks` 인덱스로 적재된다.
- Cosmos DB `documents` 컨테이너는 `COSMOS_DB_ENABLED=true`일 때만 문서별 상태와 처리 메타데이터를 저장한다.
- 선택적으로 `ALLOWED_TENANT_IDS`로 허용 테넌트를 제한할 수 있다(미설정 시 개발용으로 전체 허용).

### 4단계: 챗 검색 및 응답 생성

1. 사용자가 채팅 UI에서 질문한다.
2. 프론트엔드는 `/api/chat`을 호출한다.
3. Chat API는 요청 본문의 `tenantId`를 사용한다(로그인 연동·발급 토큰 기반 테넌트 결정은 추후 보강).
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
