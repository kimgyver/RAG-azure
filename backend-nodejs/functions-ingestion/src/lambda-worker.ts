/**
 * lambda-worker.ts — Lambda SQS event handler for document processing.
 * Each SQS message triggers processMessage from worker-aws.ts.
 */
import type { SQSHandler } from "aws-lambda";
import { processMessage } from "./worker-aws.js";

export const handler: SQSHandler = async event => {
  for (const record of event.Records) {
    await processMessage(record.body);
  }
};
