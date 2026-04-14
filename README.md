# Azure RAG 문서 처리 파이프라인 프로젝트

Azure 네이티브 구성(Blob, Functions, Service Bus, Cosmos DB, AI Search, OpenAI)으로 **문서 업로드 → 비동기 인덱싱 → 테넌트 단위 RAG 챗**까지 이어지는 포트폴리오용 레포지터리다.

## 문서 목록

| 문서 | 내용 |
|------|------|
| [docs/architecture.md](./docs/architecture.md) | 목표, 상위 아키텍처, SAS 직접 업로드, 단계별 데이터 흐름, Azure 서비스 역할 |
| [docs/design-and-scope.md](./docs/design-and-scope.md) | Cosmos·청킹·Chat 호스팅 선택, 언어·IaC 권장, 리포 구조, MVP·확장 아이디어, 기술 스택 요약 |
| [docs/development.md](./docs/development.md) | Step 1~10 구현 체크리스트, 로컬 실행·검증, Search/Chat 디버깅 팁 |
| [docs/security-and-pitch.md](./docs/security-and-pitch.md) | 보안·운영 메모, 인터뷰용 한 문장 피치 |

## 빠른 시작

프론트엔드:

```bash
cd frontend
npm install
npm run dev
```

Functions(업로드·파이프라인·챗 API):

```bash
cd backend/functions-ingestion
# local.settings.json 이 없을 때만: cp local.settings.json.example local.settings.json
# 이미 있으면 cp 하지 말 것(덮어쓰기 방지). 스토리지 등 값은 그 파일에 채운다.
npm install
npm run build
npm run start
```

상세 환경 변수와 단계별 상태는 [docs/development.md](./docs/development.md)를 본다.

## 검토 메모 (README 분리 시)

- **장점**: 한 파일에 설계·운영·로컬 절차가 모두 있어 온보딩에 유리했음.
- **개선**: 길이가 길어져 역할별 탐색이 어려워, 위 네 문서로 나눔. “무엇을 왜 쓰는가”는 `architecture` / `design-and-scope`, “어떻게 돌리는가”는 `development`에 모음.
- **중복**: 파이프라인 단계 설명이 아키텍처 문서와 개발 Step에 각각 있음. 전자는 **개념·현재 구현 요약**, 후자는 **작업 순서·명령** 기준으로 유지함.
