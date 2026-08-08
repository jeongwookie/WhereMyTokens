import { createHash } from 'node:crypto';
import {
  existsSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

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

function sourceLabel(sourceId) {
  return `source-${createHash('sha256').update(sourceId).digest('hex').slice(0, 12)}`;
}

function validatedCheckpoint(filePath, byteOffset, sourceId) {
  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    throw new Error(`Unable to read ${sourceLabel(sourceId)}`);
  }
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new Error(`Invalid byte checkpoint ${byteOffset} for ${sourceLabel(sourceId)}`);
  }
  if (size < byteOffset) {
    throw new Error(`Source ${sourceLabel(sourceId)} is shorter than its indexed byte checkpoint (${size} < ${byteOffset})`);
  }
  return byteOffset;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const databasePath = path.resolve(arguments_.database ?? defaultDatabasePath());
  if (!existsSync(databasePath)) throw new Error('UsageIndex does not exist at the selected path');
  const backupPath = path.resolve(
    arguments_.backup
      ?? path.join(path.dirname(databasePath), `usage-index.cost-backup-${timestampForPath()}.sqlite`),
  );
  const sources = sourcePathMap();
  const report = await repriceUsageIndexCosts({
    databasePath,
    ...(arguments_.dryRun ? { dryRun: true } : { backupPath }),
    replaySource: async ({ descriptor, checkpoint }) => {
      const source = sources.get(descriptor.sourceId);
      if (!source) return null;
      if (source.provider !== descriptor.provider) {
        throw new Error(`Provider mismatch for ${sourceLabel(descriptor.sourceId)}`);
      }
      const endOffsetExclusive = validatedCheckpoint(
        source.filePath,
        checkpoint.byteOffset,
        descriptor.sourceId,
      );
      const scanner = descriptor.provider === 'claude'
        ? createClaudeUsageIndexScanner(source.filePath, { endOffsetExclusive })
        : createCodexUsageIndexScanner(source.filePath, { endOffsetExclusive });
      try {
        const batch = await scanner.scan({
          mode: 'rebuild',
          source: descriptor,
          checkpoint: null,
          previousSessionProjection: null,
        });
        return batch.entries;
      } catch {
        throw new Error(`Failed to replay ${sourceLabel(descriptor.sourceId)}`);
      }
    },
    onProgress: progress => {
      if (progress.completedSources === progress.totalSources
        || progress.completedSources % 50 === 0) {
        process.stderr.write(
          `[${progress.completedSources}/${progress.totalSources}] ${progress.state}\n`,
        );
      }
    },
  });
  const publicReport = report.backupPath
    ? { ...report, backupPath: path.basename(report.backupPath) }
    : report;
  process.stdout.write(`${JSON.stringify(publicReport, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
