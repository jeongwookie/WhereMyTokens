import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import trackerModule from '../dist/main/providers/antigravity/gmTracker.js';
import cacheModule from '../dist/main/providers/antigravity/usageCacheStore.js';
import identityModule from '../dist/main/providers/antigravity/serverIdentity.js';

const { AntigravityGmTracker } = trackerModule;
const { AntigravityUsageCacheStore, emptyAntigravityUsageCacheSnapshot } = cacheModule;
const { antigravityServerOwnerKey } = identityModule;

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

function memoryStore(initial = emptyAntigravityUsageCacheSnapshot()) {
  let value = initial;
  return {
    get(key) {
      assert.equal(key, 'cache');
      return value;
    },
    set(key, next) {
      assert.equal(key, 'cache');
      value = next;
    },
  };
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

function cascadeCacheKey(serverInfo, cascadeId = 'c1') {
  return `${antigravityServerOwnerKey(serverInfo)}:${cascadeId}`;
}

function userStatus() {
  return {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Gemini 3 Pro', modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' } },
        ],
      },
    },
  };
}

function gmCall({
  executionId = 'exec-1',
  input = 100,
  output = 20,
  cacheRead = 50,
  stepIndices = [1],
  responseModel = 'MODEL_GEMINI_3_PRO',
} = {}) {
  return {
    executionId,
    stepIndices,
    chatModel: {
      responseModel,
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: 0,
      },
    },
  };
}

test('Antigravity GM tracker keeps cached IDLE cascades without refetching GM', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let gmRequests = 0;
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Idle work',
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      gmRequests += 1;
      return sendJson(res, { generatorMetadata: [gmCall()] });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], Date.now() + 10_000);
    await tracker.fetchAllFromServers(context({ nowMs: nowMs + 20_000 }), [serverInfo], Date.now() + 10_000);

    assert.equal(gmRequests, 1);
    assert.equal(Object.keys(cache.getSnapshot().cascades[cascadeCacheKey(serverInfo)].calls).length, 1);
  });
});

test('Antigravity GM tracker refetches when RUNNING becomes IDLE', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let round = 0;
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      round += 1;
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Run then idle',
            lastModifiedTime: new Date(nowMs + round).toISOString(),
            stepCount: 2,
            status: round === 1 ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      return sendJson(res, {
        generatorMetadata: [
          round === 1
            ? gmCall({ executionId: 'exec-1', input: 100, output: 20, stepIndices: [1] })
            : gmCall({ executionId: 'exec-2', input: 200, output: 30, stepIndices: [2] }),
        ],
      });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], Date.now() + 10_000);
    await tracker.fetchAllFromServers(context({ nowMs: nowMs + 20_000 }), [serverInfo], Date.now() + 10_000);

    assert.equal(Object.keys(cache.getSnapshot().cascades[cascadeCacheKey(serverInfo)].calls).length, 2);
  });
});

test('Antigravity GM tracker refetches idle cascades when lastModified changes without step growth', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let round = 0;
  let gmRequests = 0;
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      round += 1;
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Idle enriched later',
            lastModifiedTime: new Date(nowMs + round * 1000).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      gmRequests += 1;
      return sendJson(res, {
        generatorMetadata: [
          round === 1
            ? gmCall({ executionId: 'exec-1', input: 100, output: 20, stepIndices: [1] })
            : gmCall({ executionId: 'exec-2', input: 200, output: 30, stepIndices: [2] }),
        ],
      });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], Date.now() + 10_000);
    await tracker.fetchAllFromServers(context({ nowMs: nowMs + 20_000 }), [serverInfo], Date.now() + 10_000);

    assert.equal(gmRequests, 2);
    assert.equal(Object.keys(cache.getSnapshot().cascades[cascadeCacheKey(serverInfo)].calls).length, 2);
  });
});

test('Antigravity GM tracker enriches lightweight metadata from full trajectory', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Enriched',
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 350,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      return sendJson(res, { generatorMetadata: [gmCall({ input: 10, output: 1, cacheRead: 0 })] });
    }
    if (req.url.endsWith('/GetCascadeTrajectory')) {
      return sendJson(res, {
        trajectory: {
          generatorMetadata: [gmCall({ input: 100, output: 20, cacheRead: 50 })],
        },
      });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], Date.now() + 10_000);
    const call = Object.values(cache.getSnapshot().cascades[cascadeCacheKey(serverInfo)].calls)[0];

    assert.equal(call.inputTokens, 100);
    assert.equal(call.outputTokens, 20);
    assert.equal(call.cacheReadTokens, 50);
  });
});

test('Antigravity GM tracker keeps stale cache when a later GM RPC fails', async () => {
  const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
  let failGm = false;
  await withAntigravityServer((req, res) => {
    if (req.url.endsWith('/GetUserStatus')) return sendJson(res, userStatus());
    if (req.url.endsWith('/GetAllCascadeTrajectories')) {
      return sendJson(res, {
        trajectorySummaries: {
          c1: {
            summary: 'Failure keeps cache',
            lastModifiedTime: new Date(nowMs).toISOString(),
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
        },
      });
    }
    if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      if (failGm) return sendStatus(res, 500, { error: 'temporary failure' });
      return sendJson(res, { generatorMetadata: [gmCall()] });
    }
    return sendJson(res, {});
  }, async serverInfo => {
    const cache = new AntigravityUsageCacheStore(memoryStore());
    const tracker = new AntigravityGmTracker(cache);
    await tracker.fetchAllFromServers(context({ nowMs }), [serverInfo], Date.now() + 10_000);
    failGm = true;
    const result = await tracker.fetchAllFromServers(context({ nowMs: nowMs + 20_000 }), [serverInfo], Date.now() + 10_000);

    assert.equal(result.partial, true);
    assert.equal(Object.keys(cache.getSnapshot().cascades[cascadeCacheKey(serverInfo)].calls).length, 1);
  });
});
