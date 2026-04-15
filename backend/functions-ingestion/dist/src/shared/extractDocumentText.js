import pdfParse from "pdf-parse";
import { ocrImageBuffer } from "./ocrImage.js";
function normalizeText(input) {
    return input
        .replace(/\r\n/g, "\n")
        .replace(/[\t\f\v]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function isTextBlob(blobName, contentType) {
    const lowerName = blobName.toLowerCase();
    const lowerType = contentType?.toLowerCase() ?? "";
    if (lowerType.startsWith("text/")) {
        return true;
    }
    return (lowerName.endsWith(".txt") ||
        lowerName.endsWith(".md") ||
        lowerName.endsWith(".csv") ||
        lowerName.endsWith(".json"));
}
function isPdfBlob(blobName, contentType) {
    const lowerName = blobName.toLowerCase();
    const lowerType = contentType?.toLowerCase() ?? "";
    return lowerType === "application/pdf" || lowerName.endsWith(".pdf");
}
function isImageBlob(blobName, contentType) {
    const lowerType = contentType?.toLowerCase() ?? "";
    if (lowerType.startsWith("image/") &&
        !lowerType.includes("svg") &&
        lowerType !== "image/heic") {
        return true;
    }
    const lowerName = blobName.toLowerCase();
    return (lowerName.endsWith(".png") ||
        lowerName.endsWith(".jpg") ||
        lowerName.endsWith(".jpeg") ||
        lowerName.endsWith(".webp") ||
        lowerName.endsWith(".gif"));
}
export async function extractDocumentText(blobName, contentType, content) {
    if (isTextBlob(blobName, contentType)) {
        return {
            text: normalizeText(content.toString("utf8")),
            sourceType: "text"
        };
    }
    if (isPdfBlob(blobName, contentType)) {
        const result = await pdfParse(content);
        return {
            text: normalizeText(result.text ?? ""),
            sourceType: "pdf"
        };
    }
    if (isImageBlob(blobName, contentType)) {
        const ocrText = await ocrImageBuffer(content);
        if (ocrText) {
            return {
                text: normalizeText(ocrText),
                sourceType: "image-ocr"
            };
        }
        return null;
    }
    return null;
}
