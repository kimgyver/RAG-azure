# 보안·운영 메모와 소개 문장

[← README로 돌아가기](../README.md)

## 보안 및 운영 메모

- SAS 토큰은 짧은 만료 시간으로 유지한다.
- Azure 리소스 접근은 가능하면 Functions의 managed identity를 우선 사용한다.
- storage account key를 프론트엔드에 노출하지 않는다.
- 모든 chat 요청에서 tenantId 필터를 강제한다.
- 배포 환경에서는 `ALLOWED_TENANT_IDS`로 허용 테넌트를 제한하고, UI가 아닌 **신뢰할 수 있는 주체**(토큰·게이트웨이)에서 테넌트를 결정하도록 발전시킨다.
- UI가 진행 상태를 보여줄 수 있도록 문서 상태 전이를 관리한다.
- 실패는 retry count와 dead-letter 동작까지 추적한다.

## 인터뷰용 설명 문장

프로젝트를 더 강하게 설명하려면 다음처럼 말할 수 있다.

> Built an Azure-native document intelligence and RAG platform where users upload files directly to Blob Storage through SAS-based direct upload, event-driven Azure Functions validate and enqueue processing through Service Bus, OCR and chunking pipelines store operational metadata in Cosmos DB and retrieval data in Azure AI Search, and a tenant-filtered chatbot uses Azure OpenAI to answer questions with grounded citations.
