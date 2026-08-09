import {
  MAX_CLAUDE_STATUS_LINE_BYTES,
  writeClaudeStatusLineFile,
} from './claudeStatusLineFile';
import { performance } from 'node:perf_hooks';

const inputCapturedAtMs = performance.timeOrigin;
let buffer = '';
let inputBytes = 0;
let tooLarge = false;

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
  inputBytes += Buffer.byteLength(chunk);
  if (inputBytes > MAX_CLAUDE_STATUS_LINE_BYTES) {
    tooLarge = true;
    buffer = '';
    return;
  }
  buffer += chunk;
});

process.stdin.on('end', () => {
  if (!tooLarge) {
    try {
      writeClaudeStatusLineFile(JSON.parse(buffer) as unknown, undefined, inputCapturedAtMs);
    } catch {
      // 잘못된 statusLine 입력은 기존 스냅샷을 보존하고 무시한다.
    }
  }
  process.stdout.write('');
  process.exit(0);
});

// statusLine 프로세스가 열린 채로 남지 않게 제한한다.
setTimeout(() => process.exit(0), 5000).unref();
