import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
export class AwsDocumentStoreProvider {
    region = process.env.AWS_REGION ?? "ap-southeast-2";
    client = new DynamoDBClient({ region: this.region });
    tableName = process.env.DYNAMODB_TABLE_NAME ?? "rag-documents";
    isEnabled() {
        return true;
    }
    async upsert(record) {
        const now = new Date().toISOString();
        const item = Object.fromEntries(Object.entries({ ...record, updatedAt: now }).filter(([, v]) => v !== undefined && v !== null));
        if (!item.createdAt) {
            item.createdAt = now;
        }
        await this.client.send(new PutItemCommand({
            TableName: this.tableName,
            Item: marshall(item, { removeUndefinedValues: true })
        }));
    }
    async get(documentId, tenantId) {
        const { Item } = await this.client.send(new GetItemCommand({
            TableName: this.tableName,
            Key: marshall({ documentId })
        }));
        return Item ? unmarshall(Item) : null;
    }
    async listByTenant(tenantId, maxItems = 200) {
        const { Items } = await this.client.send(new QueryCommand({
            TableName: this.tableName,
            IndexName: "tenantId-index",
            KeyConditionExpression: "tenantId = :tid",
            ExpressionAttributeValues: marshall({ ":tid": tenantId }),
            Limit: maxItems
        }));
        return (Items ?? []).map(item => unmarshall(item));
    }
    async delete(documentId, tenantId) {
        await this.client.send(new DeleteItemCommand({
            TableName: this.tableName,
            Key: marshall({ documentId })
        }));
    }
}
