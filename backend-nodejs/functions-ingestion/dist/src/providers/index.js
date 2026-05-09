import { AzureStorageProvider } from "./azure/storage.js";
import { AzureDocumentStoreProvider } from "./azure/documentStore.js";
import { AzureSearchStoreProvider } from "./azure/searchStore.js";
import { AwsStorageProvider } from "./aws/storage.js";
import { AwsDocumentStoreProvider } from "./aws/documentStore.js";
import { AwsSearchStoreProvider } from "./aws/searchStore.js";
function cloudProvider() {
    return (process.env.CLOUD_PROVIDER ?? "azure").trim().toLowerCase();
}
export function getStorageProvider() {
    return cloudProvider() === "aws"
        ? new AwsStorageProvider()
        : new AzureStorageProvider();
}
export function getDocumentStore() {
    return cloudProvider() === "aws"
        ? new AwsDocumentStoreProvider()
        : new AzureDocumentStoreProvider();
}
export function getSearchStore() {
    return cloudProvider() === "aws"
        ? new AwsSearchStoreProvider()
        : new AzureSearchStoreProvider();
}
