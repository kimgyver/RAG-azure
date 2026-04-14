/**
 * Local dev only: Azurite uploads 컨테이너 + processing-jobs 큐 생성
 * 사용법: node scripts/init-local-storage.mjs
 *         (Azurite가 먼저 실행 중이어야 합니다)
 */
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueServiceClient } from "@azure/storage-queue";

// Azurite 기본 연결 문자열 (로컬 개발 전용)
const serviceClient = BlobServiceClient.fromConnectionString(
  "UseDevelopmentStorage=true"
);

// 1. CORS 설정: Vite 개발 서버 proxy가 대신 처리하므로 생략

// 2. uploads 컨테이너 생성 (없으면)
const containerClient = serviceClient.getContainerClient("uploads");
const { succeeded } = await containerClient.createIfNotExists();
if (succeeded) {
  console.log("✓ uploads 컨테이너 생성됨");
} else {
  console.log("✓ uploads 컨테이너 이미 존재");
}

// 3. processing-jobs 큐 생성 (없으면)
const queueServiceClient = QueueServiceClient.fromConnectionString(
  "UseDevelopmentStorage=true"
);
const queueClient = queueServiceClient.getQueueClient("processing-jobs");
const queueCreate = await queueClient.createIfNotExists();
if (queueCreate.succeeded) {
  console.log("✓ processing-jobs 큐 생성됨");
} else {
  console.log("✓ processing-jobs 큐 이미 존재");
}

console.log("로컬 스토리지/큐 초기화 완료.");
