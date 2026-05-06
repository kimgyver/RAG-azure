import {
  BlobSASPermissions,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters
} from "@azure/storage-blob";
import crypto from "node:crypto";

const accountName = "devstoreaccount1";
const accountKey =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDxM+q4nR6mQ6Q8iQ0LQmH4fQeRk6f7A5xL3V6m2mRjP9s0kV7mJpY5KQ==";
const sharedKey = new StorageSharedKeyCredential(accountName, accountKey);

const startsOn = new Date("2026-04-13T01:58:16Z");
const expiresOn = new Date("2026-04-13T02:18:16Z");
const blobName = "test/2026/04/13/22f82751-f334-4085-8d66-89bcf2efe2fc-hi.txt";

const params = generateBlobSASQueryParameters(
  {
    containerName: "uploads",
    blobName,
    permissions: BlobSASPermissions.parse("cw"),
    startsOn,
    expiresOn,
    protocol: SASProtocol.HttpsAndHttp,
    version: "2020-12-06"
  },
  sharedKey
);
console.log("SDK signature:", params.signature);

// Azurite의 signed string (16 items, joined with \n)
const azuriteItems = [
  "cw",
  "2026-04-13T01:58:16Z",
  "2026-04-13T02:18:16Z",
  `/blob/${accountName}/uploads/${blobName}`,
  "",
  "",
  "https,http",
  "2020-12-06",
  "b",
  "",
  "",
  "",
  "",
  "",
  "",
  ""
];
const azuriteStr = azuriteItems.join("\n");
const keyBuffer = Buffer.from(accountKey, "base64");
const azuriteSig = crypto
  .createHmac("sha256", keyBuffer)
  .update(azuriteStr, "utf8")
  .digest("base64");

console.log("Azurite stringToSign items:", azuriteItems.length, "items");
console.log("Azurite stringToSign:", JSON.stringify(azuriteStr));
console.log("Azurite calc sig:", azuriteSig);
console.log("");
console.log("Match:", params.signature === azuriteSig);
