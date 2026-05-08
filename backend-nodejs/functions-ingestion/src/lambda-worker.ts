/**
 * lambda-worker.ts — SQS event handler for async document processing
 * 
 * This module processes document upload notifications from AWS SQS.
 * Lambda is configured to automatically poll SQS and invoke this handler.
 * 
 * When compiled:
 * - esbuild bundles AWS SDK + handlers into a single file
 * - Output: dist-lambda/worker/index.js (~5000 lines of minified code)
 * - This bundle is zipped and uploaded to AWS Lambda
 * 
 * Processing Flow:
 * 1. User uploads file via HTTP → Lambda handler creates SQS message
 * 2. Message contains: tenantId, documentId, blobName (S3 key), source
 * 3. Lambda polls SQS (event source mapping configured in Terraform)
 * 4. Each SQS record is passed to this handler
 * 5. processMessage extracts tenant/document info from message
 * 6. Validates tenant against ALLOWED_TENANT_IDS
 * 7. Extracts text from PDF/image using OCR/PDF libraries
 * 8. Chunks text and generates embeddings
 * 9. Stores in DynamoDB (document metadata) + OpenSearch (text chunks)
 * 
 * Error Handling:
 * - If tenant not allowed: logs warning, skips processing
 * - If OCR/parsing fails: logs error, updates status to 'failed'
 * - Failures are NOT retried (dead-letter queue not configured)
 * 
 * @see worker-aws.ts for processMessage implementation
 * @see https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html for SQS Lambda docs
 */
import type { SQSHandler } from "aws-lambda";
import { processMessage } from "./worker-aws.js";

// Main Lambda handler: processes batch of SQS messages
export const handler: SQSHandler = async event => {
  for (const record of event.Records) {
    await processMessage(record.body);
  }
};

