declare module "pdf-parse" {
  type PdfParseResult = {
    numpages: number;
    numrender: number;
    info?: unknown;
    metadata?: unknown;
    version?: string;
    text: string;
  };

  export default function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>;
}
