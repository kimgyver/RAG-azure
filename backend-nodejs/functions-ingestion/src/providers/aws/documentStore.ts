import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  QueryCommand
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { DocumentStoreProvider } from "../base.js";

export class AwsDocumentStoreProvider implements DocumentStoreProvider {
  private region = process.env.AWS_REGION ?? "ap-southeast-2";
  private client = new DynamoDBClient({ region: this.region });
  private tableName = process.env.DYNAMODB_TABLE_NAME ?? "rag-documents";

  isEnabled(): boolean {
    return true;
  }

  async upsert(record: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    const item = Object.fromEntries(
      Object.entries({ ...record, updatedAt: now }).filter(
        ([, v]) => v !== undefined && v !== null
      )
    );
    if (!item.createdAt) {
      item.createdAt = now;
    }
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(item, { removeUndefinedValues: true })
      })
    );
  }

  async get(
    documentId: string,
    tenantId: string
  ): Promise<Record<string, unknown> | null> {
    const { Item } = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ documentId })
      })
    );
    return Item ? unmarshall(Item) : null;
  }

  async listByTenant(
    tenantId: string,
    maxItems = 200
  ): Promise<Record<string, unknown>[]> {
    const { Items } = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "tenantId-index",
        KeyConditionExpression: "tenantId = :tid",
        ExpressionAttributeValues: marshall({ ":tid": tenantId }),
        Limit: maxItems
      })
    );
    return (Items ?? []).map(item => unmarshall(item));
  }

  async delete(documentId: string, tenantId: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshall({ documentId })
      })
    );
  }
}
