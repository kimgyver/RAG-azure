# 설계 메모, 범위, 리포 구조

[← README로 돌아가기](../README.md)

## 멀티테넌트(현재 코드 수준)

- Blob 경로의 첫 세그먼트가 `tenantId`로 쓰이고, AI Search·챗 API에서 동일 문자열로 필터한다.
- **백엔드**: `ALLOWED_TENANT_IDS`에 쉼표 구분 목록을 두면 `uploads/create`, `GET /documents/{id}`, `POST /chat`, Blob 트리거·큐 워커가 그 목록 밖의 `tenantId`를 거절하거나 건너뛴다. 비어 있으면 로컬 편의를 위해 제한하지 않는다.
- **프론트**: `VITE_TENANT_ID` 기본값과 UI의 Tenant ID 입력으로 같은 문자열을 API에 넘긴다. 이는 **신뢰할 수 있는 테넌트 결정**이 아니라 데모용이다. 실서비스에서는 Entra ID 등에서 테넌트·권한을 결정하고 서버가 검증해야 한다.

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

현재 이 레포에서는 `backend/functions-chat` 대신 `functions-ingestion`에 챗 HTTP까지 포함한 형태로 진행 중일 수 있다. 분리할 때는 위 구조를 목표로 옮기면 된다.

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
