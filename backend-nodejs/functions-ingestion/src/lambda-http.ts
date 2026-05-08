/**
 * lambda-http.ts — Lambda handler wrapping the Express app via serverless-http.
 * Bundled with esbuild as a single CJS file for Lambda deployment.
 */
import serverlessHttp from "serverless-http";
import { app } from "./server-aws.js";

export const handler = serverlessHttp(app);
