# 현재 상태 · 수정 이력 · 남은 작업

[← README로 돌아가기](../README.md)

이 문서는 최근 세션에서 반영된 변경사항, 원인 분석, 운영 시 주의점, 남은 개선 과제를 한 번에 볼 수 있도록 정리한 운영 기준 문서다.

## 1. 현재 서비스 상태

- 업로드 파이프라인: 정상 동작
- 상태 전이: `queued -> processing -> indexed` 확인
- 카탈로그 API: 정상 응답
- 배포 플래그 API: 정상 응답
- Search 비용 최적화: Free 티어 전환 완료
- 예산 경보: 월 10 NZD / 20 NZD 생성 완료

## 2. 이번에 수정된 핵심 이슈

### 2.1 Function API 404 (flags/catalog)

- 증상:
  - `GET /api/flags/deployment` 404
  - `GET /api/documents/catalog` 404
- 원인:
  - `terraform apply` 이후 Function App 패키지 설정이 다시 쓰이면서 코드 패키지 라우트가 사라질 수 있음
- 조치:
  - `backend/functions-ingestion`에서 `npm run build`
  - `func azure functionapp publish "$(terraform -chdir=../../infra output -raw function_app_name)"`
- 재발 방지:
  - 인프라 변경 후에는 항상 publish를 후속 단계로 실행

### 2.2 업로드가 queued에 머무는 문제

- 증상:
  - 업로드 직후 `queued`에서 진행이 안 되는 것처럼 보임
- 원인:
  - Blob 트리거 소스가 `EventGrid`로 설정된 상태에서 데모 환경에서 트리거 흐름이 불안정
- 조치:
  - `BLOB_TRIGGER_SOURCE=LogsAndContainerScan`로 전환
  - Function App 재시작 및 재배포
- 재발 방지:
  - Terraform 기본값도 `LogsAndContainerScan` 유지

### 2.3 Purge 버튼을 두 번 눌러야 지워지는 것처럼 보이는 문제

- 사용자 체감:
  - 첫 번째 클릭에서는 Cosmos만 지워진 것처럼 보이고, 두 번째 클릭 후 Search가 사라짐
- 실제 원인:
  - Search 삭제 반영이 짧은 시간 지연될 수 있는데, 프론트 카탈로그 갱신 타이밍이 충분하지 않았음
- 백엔드 조치:
  - purge API에 Search 잔여 청크 확인(`remainingSearchChunks`) 및 짧은 재확인 로직 추가
- 프론트 조치:
  - Purge 성공 후 카탈로그 단발 갱신이 아니라 짧은 간격 재조회 수행

### 2.4 인덱싱 완료 후 카탈로그 즉시 갱신되지 않는 문제

- 증상:
  - 상태 배지와 카탈로그 표가 순간적으로 어긋남
- 조치:
  - 문서 상태 폴링에서 terminal 상태(`indexed`, `chunked`, `skipped`, `failed`) 도달 시 카탈로그 자동 재조회 추가

### 2.5 채팅 UX 개선

- Enter 키 전송 지원
  - `Enter`: 전송
  - `Shift + Enter`: 줄바꿈

### 2.6 tenant allowlist 오류 가시성 개선

- 개선 전:
  - 오류가 일부 패널/알림에만 보여 원인 파악이 어려움
- 개선 후:
  - `tenantId is not allowed for this deployment.` 메시지를 tenant 입력 영역 근처에 표시
  - API 에러 메시지 파싱 공통화

## 3. 비용/운영 관련 반영 내용

### 3.1 Search Free 전환

- 기존 Standard Search를 Free로 전환
- Function App `SEARCH_*` 설정도 Free 엔드포인트/키로 전환
- 기존 Standard 서비스 삭제 완료

### 3.2 온디맨드 Search 운영 스크립트

- `scripts/search-on.sh`
  - Search 생성(또는 재사용) + Function App `SEARCH_*` 설정 연결
- `scripts/search-off.sh`
  - Function App Search 비활성화 + Search 서비스 삭제

### 3.3 월 예산 경보

- `rag-monthly-10-nzd`
- `rag-monthly-20-nzd`
- Owner 알림 규칙 포함

## 4. 운영 시 꼭 지켜야 할 실행 순서

1. 인프라 변경 적용
   - `cd infra && terraform apply`
2. 백엔드 코드 재배포
   - `cd backend/functions-ingestion`
   - `npm run build`
   - `func azure functionapp publish "$(terraform -chdir=../../infra output -raw function_app_name)"`
3. 프론트 배포(정적 호스팅 사용 시)
   - `cd frontend && npm run build`

위 2단계를 생략하면 API 라우트 404 또는 런타임 동작 불일치가 재발할 수 있다.

## 5. 검증 체크리스트

### 5.1 API 헬스

- `GET /api/flags/deployment` 응답 확인
- `GET /api/documents/catalog?tenantId=tenant-a` 응답 확인

### 5.2 업로드/처리

- 파일 업로드 후 상태 전이 확인
  - `queued -> processing -> indexed`

### 5.3 Purge

- Purge 1회 클릭 후 카탈로그에서 Cosmos/Search 동시 반영 여부 확인

### 5.4 채팅

- Enter 전송, Shift+Enter 줄바꿈 확인

### 5.5 테넌트 제한

- 허용되지 않은 tenant 입력 시 tenant 입력 영역 근처 경고 표시 확인

## 6. 남은 개선 과제 (권장)

1. 프론트 배포 자동화
   - 백엔드 publish와 프론트 빌드/배포를 단일 스크립트 또는 CI 파이프라인으로 묶기
2. Purge 사용자 피드백 강화
   - 삭제 결과(`deletedSearchChunks`, `remainingSearchChunks`)를 표준 토스트로 보여주기
3. API 보호 계층 강화
   - APIM + JWT 검증 + rate limit 적용
4. Node 런타임 업그레이드
   - Function App Node 20 EOL 안내에 따라 22/24로 계획적 전환
5. 관측성 대시보드 정리
   - 업로드 성공률, 큐 지연, 인덱싱 지연, purge 성공률을 Workbook으로 표준화

## 7. 빠른 장애 대응 Runbook

### 증상 A: 카탈로그/플래그 404

1. Function publish 재실행
2. 트리거 동기화 결과에서 HTTP 라우트 목록 확인

### 증상 B: 업로드가 queued에 정체

1. `BLOB_TRIGGER_SOURCE` 값 점검 (`LogsAndContainerScan` 권장)
2. Service Bus 큐 카운트 확인
3. Function 로그에서 `processing-worker` 실행 여부 확인

### 증상 C: Purge 후 Search가 남아보임

1. 카탈로그 자동 재조회가 동작하는지 확인
2. 필요 시 수동 새로고침
3. Search API로 해당 `documentId` 청크 잔여 수 확인
