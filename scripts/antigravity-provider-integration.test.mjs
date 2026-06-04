import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

import { fetchAntigravityQuotaFromServers } from '../dist/main/providers/antigravity/quota.js';
import { discoverAntigravitySessionsFromServers } from '../dist/main/providers/antigravity/sessions.js';
import { scanAntigravityUsageFromServers } from '../dist/main/providers/antigravity/usage.js';
import {
  AntigravityUsageCacheStore,
  emptyAntigravityUsageCacheSnapshot,
} from '../dist/main/providers/antigravity/usageCacheStore.js';
import {
  antigravityCascadeSummaryKey,
  antigravityServerOwnerKey,
} from '../dist/main/providers/antigravity/serverIdentity.js';
import aggregates from '../dist/main/usageLedgerAggregates.js';

const { emptyUsageAggregate, emptyUsageLedgerSnapshot, dayModelKey, monthModelKey } = aggregates;

function context(overrides = {}) {
  return {
    settings: { enabledProviders: ['antigravity'] },
    nowMs: Date.parse('2026-06-01T12:00:00.000Z'),
    jsonlCache: {},
    scanBudgetMs: null,
    prioritySourceIds: new Set(),
    includeFullHistory: false,
    force: false,
    ...overrides,
  };
}

function memoryAntigravityCacheStore() {
  let value = emptyAntigravityUsageCacheSnapshot();
  return new AntigravityUsageCacheStore({
    get(key) {
      assert.equal(key, 'cache');
      return value;
    },
    set(key, next) {
      assert.equal(key, 'cache');
      value = next;
    },
  });
}

async function withAntigravityServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run({ pid: 1, port: server.address().port, csrfToken: 'csrf' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function sendJson(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendStatus(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function summaryKey(serverInfo, cascadeId) {
  return antigravityCascadeSummaryKey(antigravityServerOwnerKey(serverInfo), cascadeId);
}

test('Antigravity provider maps local quota and usage RPC data into WMT provider structures', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, {
        userStatus: {
          email: 'person@example.com',
          planStatus: { planInfo: { planName: 'Pro' } },
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: 'Gemini 3 Pro',
                modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' },
                quotaInfo: { remainingFraction: 0.8, resetTime: nowMs + 60_000 },
              },
            ],
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Implement feature',
            createdTime: new Date(nowMs - 120_000).toISOString(),
            lastModifiedTime: new Date(nowMs - 30_000).toISOString(),
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C:/repo/app' }],
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'e1',
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1 },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const ctx = context({ nowMs });
    const quota = await fetchAntigravityQuotaFromServers(ctx, [serverInfo]);
    const usage = await scanAntigravityUsageFromServers(ctx, [serverInfo], undefined, memoryAntigravityCacheStore());

    assert.equal(quota.provider, 'antigravity');
    assert.equal(quota.source, 'localRpc');
    assert.equal(quota.status.connected, true);
    assert.equal(quota.accountLabel, 'pe***@example.com');
    assert.equal(quota.accountTooltip, 'pe***@example.com');
    assert.equal(quota.accountTooltip.includes('person@example.com'), false);
    assert.equal(quota.models[0].remainingPct, 80);
    assert.equal(quota.models[0].usageModel, 'Gemini 3 Pro');
    assert.equal(quota.models[0].statsWindowKey, 'model.MODEL_GEMINI_3_PRO');
    assert.equal(quota.models[0].durationMs, undefined);
    assert.equal(quota.models[0].visualKind, 'percentOnly');
    assert.equal('credits' in quota, false);
    assert.equal('source' in quota.models[0], false);
    const quotaWithPace = await fetchAntigravityQuotaFromServers(
      context({
        nowMs,
        settings: {
          enabledProviders: ['antigravity'],
          antigravityQuotaDurationPaceEnabled: true,
        },
      }),
      [serverInfo],
    );
    assert.equal(quotaWithPace.models[0].durationMs, 5 * 60 * 60 * 1000);
    assert.equal(quotaWithPace.models[0].visualKind, 'pace');
    assert.equal(usage.summaries.has(summaryKey(serverInfo, 'c1')), true);
    assert.equal(usage.ledgerSources.length, 1);
    assert.equal(usage.scannedSources, 1);
  });
});

test('Antigravity quota selection prefers the server with the newest cascade activity', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const handlerFor = ({ remainingFraction, resetMs, newestMs }) => (req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: 'Gemini 3 Pro',
                modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' },
                quotaInfo: { remainingFraction, resetTime: nowMs + resetMs },
              },
            ],
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          c1: {
            lastModifiedTime: new Date(newestMs).toISOString(),
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
      return;
    }
    sendJson(res, {});
  };

  await withAntigravityServer(
    handlerFor({
      remainingFraction: 1,
      resetMs: 4 * 60 * 60 * 1000,
      newestMs: nowMs - 60 * 60 * 1000,
    }),
    async olderServer => {
      await withAntigravityServer(
        handlerFor({
          remainingFraction: 0.2,
          resetMs: 6 * 60 * 60 * 1000,
          newestMs: nowMs - 60 * 1000,
        }),
        async newerServer => {
          const quota = await fetchAntigravityQuotaFromServers(
            context({
              nowMs,
              settings: {
                enabledProviders: ['antigravity'],
                antigravityQuotaDurationPaceEnabled: true,
              },
            }),
            [olderServer, newerServer],
          );

          assert.equal(quota.models[0].remainingPct, 20);
          assert.equal(quota.models[0].durationMs, 7 * 24 * 60 * 60 * 1000);
        },
      );
    },
  );
});

test('Antigravity usage scan returns partial near deadline instead of waiting for slow GM RPC timeout', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          slow: {
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      setTimeout(() => sendJson(res, { generatorMetadata: [] }), 700);
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const started = performance.now();
    const usage = await scanAntigravityUsageFromServers(
      context({ nowMs, scanBudgetMs: 50 }),
      [serverInfo],
      undefined,
      memoryAntigravityCacheStore(),
    );
    const elapsed = performance.now() - started;

    assert.equal(usage.partial, true);
    assert.ok(elapsed < 500, `scan took ${elapsed}ms`);
  });
});

test('Antigravity usage scan marks partial when cascade list exceeds the scan limit', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const trajectorySummaries = Object.fromEntries(
    Array.from({ length: 201 }, (_, index) => [
      `c${index}`,
      {
        lastModifiedTime: new Date(nowMs - index * 1000).toISOString(),
        stepCount: 1,
        status: 'CASCADE_RUN_STATUS_RUNNING',
      },
    ]),
  );

  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, { trajectorySummaries });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, { generatorMetadata: [] });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const usage = await scanAntigravityUsageFromServers(context({ nowMs }), [serverInfo], undefined, memoryAntigravityCacheStore());

    assert.equal(usage.scannedSources, 48);
    assert.equal(usage.partial, true);
  });
});

test('Antigravity full-history usage scan raises the cascade limit', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const trajectorySummaries = Object.fromEntries(
    Array.from({ length: 201 }, (_, index) => [
      `c${index}`,
      {
        lastModifiedTime: new Date(nowMs - index * 1000).toISOString(),
        stepCount: 1,
        status: 'CASCADE_RUN_STATUS_RUNNING',
      },
    ]),
  );

  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, { trajectorySummaries });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, { generatorMetadata: [] });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const usage = await scanAntigravityUsageFromServers(
      context({ nowMs, includeFullHistory: true }),
      [serverInfo],
      undefined,
      memoryAntigravityCacheStore(),
    );

    assert.equal(usage.scannedSources, 200);
    assert.equal(usage.partial, true);
  });
});

test('Antigravity usage scan marks partial when trajectory summaries RPC fails', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendStatus(res, 500, { error: 'temporary failure' });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const usage = await scanAntigravityUsageFromServers(context({ nowMs }), [serverInfo], undefined, memoryAntigravityCacheStore());

    assert.equal(usage.partial, true);
    assert.equal(usage.scannedSources, 0);
    assert.equal(usage.ledgerSources.length, 1);
  });
});

test('Antigravity usage scan uses createdTime as timestamp fallback when lastModifiedTime is missing', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const createdMs = nowMs - 3 * 60 * 60_000;
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          createdOnly: {
            createdTime: new Date(createdMs).toISOString(),
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'created-only-call',
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 10, outputTokens: 5 },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const usage = await scanAntigravityUsageFromServers(context({ nowMs }), [serverInfo], undefined, memoryAntigravityCacheStore());
    const summary = usage.summaries.get(summaryKey(serverInfo, 'createdOnly'));

    assert.equal(summary.recentEntries[0].timestampMs, createdMs);
  });
});

test('Antigravity usage scan falls back to now when cascade and GM timestamps are missing', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          noTime: {
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'no-time-call',
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 10, outputTokens: 5 },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const usage = await scanAntigravityUsageFromServers(context({ nowMs }), [serverInfo], undefined, memoryAntigravityCacheStore());
    const summary = usage.summaries.get(summaryKey(serverInfo, 'noTime'));

    assert.equal(summary.recentEntries[0].timestampMs, nowMs);
    assert.equal(summary.mtimeMs, nowMs);
  });
});

test('Antigravity usage scan enriches non-empty lightweight GM with full trajectory metadata', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini 3 Pro', modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' } }] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          enriched: {
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 350,
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'same-exec',
            stepIndices: [1],
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 10, outputTokens: 1 },
            },
          },
        ],
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectory')) {
      sendJson(res, {
        trajectory: {
          generatorMetadata: [
            {
              executionId: 'same-exec',
              stepIndices: [1],
              chatModel: {
                responseModel: 'MODEL_GEMINI_3_PRO',
                usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 50 },
              },
            },
            {
              executionId: 'full-only',
              stepIndices: [2],
              chatModel: {
                responseModel: 'MODEL_GEMINI_3_PRO',
                usage: { inputTokens: 20, outputTokens: 2 },
              },
            },
          ],
        },
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const usage = await scanAntigravityUsageFromServers(context({ nowMs }), [serverInfo], undefined, memoryAntigravityCacheStore());
    const snapshot = await usage.ledgerSources[0].importIntoSnapshot(emptyUsageLedgerSnapshot(), nowMs);
    const row = snapshot.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')];

    assert.equal(row.requestCount, 2);
    assert.equal(row.inputTokens, 120);
    assert.equal(row.outputTokens, 9);
    assert.equal(row.cacheReadTokens, 50);
  });
});

test('Antigravity usage scan keeps repeated execution ids with distinct step indices', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              { label: 'Gemini 3 Pro', modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' } },
            ],
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          repeatedExec: {
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 1,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'same-exec',
            stepIndices: [4, 5],
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 10, outputTokens: 5 },
            },
          },
          {
            executionId: 'same-exec',
            stepIndices: [8, 9],
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 20, outputTokens: 7 },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const usage = await scanAntigravityUsageFromServers(context({ nowMs }), [serverInfo], undefined, memoryAntigravityCacheStore());
    const snapshot = await usage.ledgerSources[0].importIntoSnapshot(emptyUsageLedgerSnapshot(), nowMs);
    const row = snapshot.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')];

    assert.equal(row.requestCount, 2);
    assert.equal(row.inputTokens, 30);
    assert.equal(row.outputTokens, 12);
  });
});

test('Antigravity usage scan returns summaries from persisted cache when current RPC omits old cascades', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let includeCascade = true;
  const cacheStore = memoryAntigravityCacheStore();
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini 3 Pro', modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' } }] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: includeCascade ? {
          cached: {
            summary: 'Cached work',
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        } : {},
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'exec-cached',
            stepIndices: [1],
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const first = await scanAntigravityUsageFromServers(
      context({ nowMs }),
      [serverInfo],
      Date.now() + 10_000,
      cacheStore,
    );
    includeCascade = false;
    const second = await scanAntigravityUsageFromServers(
      context({ nowMs: nowMs + 20_000 }),
      [serverInfo],
      Date.now() + 10_000,
      cacheStore,
    );

    assert.equal(first.summaries.has(summaryKey(serverInfo, 'cached')), true);
    assert.equal(second.summaries.has(summaryKey(serverInfo, 'cached')), true);
    assert.equal(second.ledgerSources.length, 1);
  });
});

test('Antigravity cache ledger source is idempotent across repeated scans', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const cacheStore = memoryAntigravityCacheStore();
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) {
      sendJson(res, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini 3 Pro', modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' } }] } } });
      return;
    }
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      sendJson(res, {
        trajectorySummaries: {
          stable: {
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
      return;
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      sendJson(res, {
        generatorMetadata: [
          {
            executionId: 'exec-stable',
            stepIndices: [1],
            chatModel: {
              responseModel: 'MODEL_GEMINI_3_PRO',
              usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const first = await scanAntigravityUsageFromServers(
      context({ nowMs }),
      [serverInfo],
      Date.now() + 10_000,
      cacheStore,
    );
    const afterFirst = await first.ledgerSources[0].importIntoSnapshot(emptyUsageLedgerSnapshot(), nowMs);
    const second = await scanAntigravityUsageFromServers(
      context({ nowMs: nowMs + 20_000 }),
      [serverInfo],
      Date.now() + 10_000,
      cacheStore,
    );
    const afterSecond = await second.ledgerSources[0].importIntoSnapshot(afterFirst, nowMs + 20_000);
    const row = afterSecond.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Gemini 3 Pro')];

    assert.equal(row.requestCount, 1);
    assert.equal(row.totalTokens, 170);
  });
});

test('Antigravity empty usage cache clears stale provider ledger rows', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  const cacheStore = memoryAntigravityCacheStore();
  const usage = await scanAntigravityUsageFromServers(
    context({ nowMs }),
    [],
    Date.now() + 10_000,
    cacheStore,
  );
  const snapshot = emptyUsageLedgerSnapshot();
  snapshot.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Old Gemini')] = {
    ...emptyUsageAggregate(),
    requestCount: 1,
    totalTokens: 123,
  };
  snapshot.monthlyModel[monthModelKey('2026-06-01', 'antigravity', 'Old Gemini')] = {
    ...emptyUsageAggregate(),
    requestCount: 1,
    totalTokens: 123,
  };
  snapshot.dailyModel[dayModelKey('2026-06-01', 'claude', 'Sonnet')] = {
    ...emptyUsageAggregate(),
    requestCount: 1,
    totalTokens: 456,
  };

  const next = await usage.ledgerSources[0].importIntoSnapshot(snapshot, nowMs);

  assert.equal(usage.ledgerSources.length, 1);
  assert.equal(next.dailyModel[dayModelKey('2026-06-01', 'antigravity', 'Old Gemini')], undefined);
  assert.equal(next.monthlyModel[monthModelKey('2026-06-01', 'antigravity', 'Old Gemini')], undefined);
  assert.equal(next.dailyModel[dayModelKey('2026-06-01', 'claude', 'Sonnet')].totalTokens, 456);
});

test('Antigravity session discovery returns near deadline when trajectory summaries are slow', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      setTimeout(() => sendJson(res, {
        trajectorySummaries: {
          slow: {
            createdTime: new Date(nowMs).toISOString(),
            workspaces: [{ workspaceFolderAbsoluteUri: 'file:///C:/repo/app' }],
          },
        },
      }), 700);
      return;
    }
    sendJson(res, {});
  }, async serverInfo => {
    const started = performance.now();
    const sessions = await discoverAntigravitySessionsFromServers(
      context({ nowMs, scanBudgetMs: 50 }),
      [serverInfo],
    );
    const elapsed = performance.now() - started;

    assert.deepEqual(sessions, []);
    assert.ok(elapsed < 500, `discovery took ${elapsed}ms`);
  });
});
