import { Jimp, JimpMime } from "jimp";

let workerPromise: Promise<
  Awaited<ReturnType<typeof import("tesseract.js").createWorker>>
> | null = null;

function ocrEnabled(): boolean {
  return (process.env.OCR_ENABLED ?? "true").toLowerCase() !== "false";
}

function maxImageBytes(): number {
  const n = Number(process.env.OCR_MAX_IMAGE_BYTES ?? String(12 * 1024 * 1024));
  return Number.isFinite(n) && n > 0 ? n : 12 * 1024 * 1024;
}

function maxEdgePx(): number {
  const n = Number(process.env.OCR_MAX_EDGE_PX ?? "2000");
  return Number.isFinite(n) && n >= 512 ? n : 2000;
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      const langs = process.env.OCR_LANGS?.trim() || "eng";
      return createWorker(langs, undefined, {
        logger: () => undefined
      });
    })();
  }
  return workerPromise;
}

/**
 * OCR for raster images (PNG, JPEG, WebP, GIF). PDFs are handled separately.
 */
export async function ocrImageBuffer(
  buffer: Buffer
): Promise<string | null> {
  if (!ocrEnabled()) {
    return null;
  }

  if (buffer.length > maxImageBytes()) {
    return null;
  }

  try {
    const image = await Jimp.read(buffer);
    const edge = maxEdgePx();
    if (image.bitmap.width > edge || image.bitmap.height > edge) {
      image.contain({ w: edge, h: edge });
    }
    const png = Buffer.from(await image.getBuffer(JimpMime.png));
    const worker = await getWorker();
    const {
      data: { text }
    } = await worker.recognize(png);
    const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}
