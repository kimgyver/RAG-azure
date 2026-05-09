/**
 * lambda-http.ts — HTTP handler for AWS Lambda
 *
 * This module wraps the Express HTTP server (server-aws.ts) for AWS Lambda
 * using serverless-http middleware. Lambda invokes this handler for each API request.
 *
 * When compiled:
 * - esbuild bundles Express + all dependencies into a single file
 * - Output: dist-lambda/http/index.js (~5000 lines of minified code)
 * - This bundle is zipped and uploaded to AWS Lambda
 *
 * Runtime Flow:
 * 1. API Gateway v2 receives HTTP request
 * 2. Invokes Lambda with payload (method, path, headers, body)
 * 3. serverless-http converts Lambda event → Express request
 * 4. app (Express) processes the request (routing, validation, handlers)
 * 5. serverless-http converts Express response → Lambda response
 * 6. API Gateway returns response to client
 *
 * @see server-aws.ts for business logic (endpoints, tenant validation, etc.)
 * @see https://github.com/dougmoscrop/serverless-http for serverless-http docs
 */
import serverlessHttp from "serverless-http";
import { app } from "./server-aws.js";
// Main Lambda handler: adapts API Gateway events to Express app
export const handler = serverlessHttp(app);
