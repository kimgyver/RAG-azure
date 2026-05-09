import { processMessage } from "./worker-aws.js";
// Main Lambda handler: processes batch of SQS messages
export const handler = async (event) => {
    for (const record of event.Records) {
        await processMessage(record.body);
    }
};
