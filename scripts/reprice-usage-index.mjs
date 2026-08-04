import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import usageIndexModule from '../dist/main/usageIndex/index.js';
import claudeSourcesModule from '../dist/main/providers/claude/sources.js';
import codexSourcesModule from '../dist/main/providers/codex/sources.js';
import claudeScannerModule from '../dist/main/providers/claude/usageIndexScanner.js';
import codexScannerModule from '../dist/main/providers/codex/usageIndexScanner.js';

const { repriceUsageIndexCosts } = usageIndexModule;
const { listAllClaudeSources, buildClaudeUsageIndexSource } = claudeSourcesModule;
const { listAllCodexSources, buildCodexUsageIndexSource } = codexSourcesModule;
const { createClaudeUsageIndexScanner } = claudeScannerModule;
const { createCodexUsageIndexScanner } = codexScannerModule;

function parseArguments(argv) {
  const values = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      values.dryRun = true;
      continue;
    }
    if (argument === '--database' || argument === '--backup') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      values[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function defaultDatabasePath() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is unavailable; pass --database explicitly');
  return path.join(appData, 'wheremytokens-win', 'usage-index.sqlite');
}

function sourcePathMap() {
  const result = new Map();
  for (const source of listAllClaudeSources().sources) {
    const built = buildClaudeUsageIndexSource({}, source);
    result.set(built.descriptor.sourceId, { provider: 'claude', filePath: source.filePath });
  }
  for (const source of listAllCodexSources().sources) {
    const built = buildCodexUsageIndexSource({}, source);
    result.set(built.descriptor.sourceId, { provider: 'codex', filePath: source.filePath });
  }
  return result;
}

async function checkpointPrefix(filePath, byteOffset, tempRoot, sourceId) {
  const size = statSync(filePath).size;
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new Error(`Invalid byte checkpoint ${byteOffset} for ${sourceId}`);
  }
  if (size < byteOffset) {
    throw new Error(`Source ${sourceId} is shorter than its indexed byte checkpoint (${size} < ${byteOffset})`);
  }
  if (size === byteOffset) return filePath;

  const name = `${createHash('sha256').update(sourceId).digest('hex').slice(0, 20)}.jsonl`;
  const prefixPath = path.join(tempRoot, name);
  if (byteOffset === 0) {
    writeFileSync(prefixPath, '');
    return prefixPath;
  }
  await pipeline(
    createReadStream(filePath, { start: 0, end: byteOffset - 1 }),
    createWriteStream(prefixPath, { flags: 'wx' }),
  );
  return prefixPath;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const databasePath = path.resolve(arguments_.database ?? defaultDatabasePath());
  if (!existsSync(databasePath)) throw new Error(`UsageIndex does not exist: ${databasePath}`);
  const backupPath = path.resolve(
    arguments_.backup
      ?? path.join(path.dirname(databasePath), `usage-index.cost-backup-${timestampForPath()}.sqlite`),
  );
  const sources = sourcePathMap();
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'wmt-cost-reprice-'));
  try {
    const report = await repriceUsageIndexCosts({
      databasePath,
      ...(arguments_.dryRun ? { dryRun: true } : { backupPath }),
      replaySource: async ({ descriptor, checkpoint }) => {
        const source = sources.get(descriptor.sourceId);
        if (!source) return null;
        if (source.provider !== descriptor.provider) {
          throw new Error(`Provider mismatch for ${descriptor.sourceId}`);
        }
        const scanPath = await checkpointPrefix(
          source.filePath,
          checkpoint.byteOffset,
          tempRoot,
          descriptor.sourceId,
        );
        const scanner = descriptor.provider === 'claude'
          ? createClaudeUsageIndexScanner(scanPath)
          : createCodexUsageIndexScanner(scanPath);
        const batch = await scanner.scan({
          mode: 'rebuild',
          source: descriptor,
          checkpoint: null,
          previousSessionProjection: null,
        });
        return batch.entries;
      },
      onProgress: progress => {
        if (progress.completedSources === progress.totalSources
          || progress.completedSources % 50 === 0) {
          process.stderr.write(
            `[${progress.completedSources}/${progress.totalSources}] ${progress.state}: ${progress.sourceId}\n`,
          );
        }
      },
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
