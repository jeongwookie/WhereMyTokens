import * as fs from 'fs';

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function scanJsonlLines(
  filePath: string,
  startOffset: number,
  onPayloadBytesRead: ((byteCount: number) => void) | undefined,
  onLine: (line: string, offsetAfterLine: number) => void,
): Promise<void> {
  const stream = fs.createReadStream(filePath, { start: startOffset });
  let pendingChunks: Buffer[] = [];
  let pendingLength = 0;
  let consumedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(asError(error));
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const destroyWith = (error: unknown): void => {
      stream.destroy(asError(error));
    };

    stream.on('data', (chunk: Buffer | string) => {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        onPayloadBytesRead?.(bytes.length);
        let segmentStart = 0;
        while (true) {
          const newlineIndex = bytes.indexOf(0x0a, segmentStart);
          if (newlineIndex < 0) break;
          const segment = bytes.subarray(segmentStart, newlineIndex);
          let lineBuffer = pendingLength > 0
            ? Buffer.concat([...pendingChunks, segment], pendingLength + segment.length)
            : segment;
          consumedBytes += pendingLength + segment.length + 1;
          pendingChunks = [];
          pendingLength = 0;
          segmentStart = newlineIndex + 1;
          if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d) {
            lineBuffer = lineBuffer.subarray(0, -1);
          }
          const line = lineBuffer.toString('utf8');
          if (line.trim()) onLine(line, startOffset + consumedBytes);
        }
        if (segmentStart < bytes.length) {
          const trailing = bytes.subarray(segmentStart);
          pendingChunks.push(trailing);
          pendingLength += trailing.length;
        }
      } catch (error) {
        destroyWith(error);
      }
    });
    stream.once('error', fail);
    stream.once('end', () => {
      try {
        let trailing = pendingLength > 0
          ? Buffer.concat(pendingChunks, pendingLength)
          : Buffer.alloc(0);
        if (trailing.length > 0 && trailing[trailing.length - 1] === 0x0d) {
          trailing = trailing.subarray(0, -1);
        }
        const line = trailing.toString('utf8');
        if (line.trim()) {
          let completeJson = true;
          try {
            JSON.parse(line);
          } catch {
            completeJson = false;
          }
          if (completeJson) onLine(line, startOffset + consumedBytes + pendingLength);
        }
        finish();
      } catch (error) {
        fail(error);
      }
    });
  });
}
