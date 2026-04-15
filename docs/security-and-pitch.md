# 보안·운영 메모와 소개 문장

[← README로 돌아가기](../README.md)

## 보안 및 운영 메모

- SAS 토큰은 짧은 만료 시간으로 유지한다.
- Azure 리소스 접근은 가능하면 Functions의 managed identity를 우선 사용한다(현재 데모는 Storage·Search 키를 앱 설정에 두는 경로도 있음 — 운영에서는 MI + RBAC·Key Vault 권장).
- storage account key·Search admin key·OpenAI 키를 **프론트엔드**나 공개 저장소에 넣지 않는다. `terraform.tfvars`는 Git에 커밋하지 않는다.
- 모든 chat 요청에서 tenantId 필터를 강제한다.
- 배포 환경에서는 `ALLOWED_TENANT_IDS`로 허용 테넌트를 제한하고, UI가 아닌 **신뢰할 수 있는 주체**(토큰·게이트웨이)에서 테넌트를 결정하도록 발전시킨다.
- 데모 편의를 위해 `GET /api/documents/catalog`, `DELETE .../purge`, `GET /api/flags/deployment` 등이 **anonymous**로 열려 있을 수 있다. 공개 인터넷에 두기 전에 APIM·인증·네트워크 제한으로 막을 것.
- UI가 진행 상태를 보여줄 수 있도록 문서 상태 전이를 관리한다.
- 실패는 retry count와 dead-letter 동작까지 추적한다.

## 인터뷰용 설명 문장

프로젝트를 더 강하게 설명하려면 다음처럼 말할 수 있다.

> Built an Azure-native document intelligence and RAG platform where users upload files directly to Blob Storage through SAS-based direct upload, event-driven Azure Functions validate and enqueue processing through Service Bus, OCR and chunking pipelines store operational metadata in Cosmos DB and retrieval data in Azure AI Search, and a tenant-filtered chatbot uses Azure OpenAI to answer questions with grounded citations.
