import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from "@azure/functions";
import { getRuntimeConfigSnapshot } from "../shared/runtimeConfig.js";

async function getRuntimeConfigHandler(
  _request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> {
  const snapshot = getRuntimeConfigSnapshot();
  return {
    status: 200,
    jsonBody: snapshot,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  };
}

app.http("deploymentFlags", {
  // 함수 이름·경로에 `runtime` 을 쓰면 호스트 예약과 충돌할 수 있다.
  route: "flags/deployment",
  methods: ["GET"],
  // 비밀 없는 플래그만 반환. 업로드·챗과 달리 로컬에서 키 없이 UI와 동기화되도록 허용한다.
  authLevel: "anonymous",
  handler: getRuntimeConfigHandler
});
