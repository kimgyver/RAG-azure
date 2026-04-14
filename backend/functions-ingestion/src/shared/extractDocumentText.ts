import pdfParse from "pdf-parse";

export type ExtractedDocumentText = {
  text: string;
  sourceType: "text" | "pdf";
};

function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTextBlob(blobName: string, contentType?: string): boolean {
  const lowerName = blobName.toLowerCase();
  const lowerType = contentType?.toLowerCase() ?? "";

  if (lowerType.startsWith("text/")) {
    return true;
  }

  return (
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".json")
  );
}

function isPdfBlob(blobName: string, contentType?: string): boolean {
  const lowerName = blobName.toLowerCase();
  const lowerType = contentType?.toLowerCase() ?? "";
  return lowerType === "application/pdf" || lowerName.endsWith(".pdf");
}

export async function extractDocumentText(
  blobName: string,
  contentType: string | undefined,
  content: Buffer
): Promise<ExtractedDocumentText | null> {
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

  return null;
}
