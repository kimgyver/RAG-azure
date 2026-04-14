export type TextChunk = {
  chunkIndex: number;
  content: string;
  startOffset: number;
  endOffset: number;
};

export type ChunkTextOptions = {
  chunkSize: number;
  overlap: number;
};

export function chunkText(
  input: string,
  options: ChunkTextOptions
): TextChunk[] {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const chunkSize = Math.max(100, options.chunkSize);
  const overlap = Math.max(0, Math.min(options.overlap, chunkSize - 1));
  const chunks: TextChunk[] = [];

  let cursor = 0;
  let index = 0;

  while (cursor < normalized.length) {
    const tentativeEnd = Math.min(cursor + chunkSize, normalized.length);
    let end = tentativeEnd;

    // 문장/문단 경계 근처로 끝점을 맞춰 조각 품질을 조금 높인다.
    if (tentativeEnd < normalized.length) {
      const windowStart = Math.max(cursor, tentativeEnd - 120);
      const window = normalized.slice(windowStart, tentativeEnd);
      const boundaryOffset = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("\n")
      );

      if (boundaryOffset > 0) {
        end = windowStart + boundaryOffset + 1;
      }
    }

    const content = normalized.slice(cursor, end).trim();
    if (content) {
      chunks.push({
        chunkIndex: index,
        content,
        startOffset: cursor,
        endOffset: end
      });
      index += 1;
    }

    if (end >= normalized.length) {
      break;
    }

    cursor = Math.max(end - overlap, cursor + 1);
  }

  return chunks;
}
