import * as http from 'http';
import * as https from 'https';
import { GENERATOR_SELECTION, RpcArrayReader, STEP_SELECTION, type JsonSelection } from './rpcStream';
import type {
  AntigravityQuotaSummaryResponse, AntigravityServerInfo,
  AntigravityTrajectorySummariesResponse, AntigravityUserStatusResponse,
} from './types';

type RpcProtocol = 'http' | 'https';
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
class RpcResponseError extends Error {}

function openResponse(server: AntigravityServerInfo, method: string, body: unknown, protocol: RpcProtocol, timeoutMs: number) {
  return new Promise<{ response: http.IncomingMessage; dispose(): void }>((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const lib = protocol === 'https' ? https : http;
    const req = lib.request({
      hostname: '127.0.0.1', port: server.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': server.csrfToken },
      rejectUnauthorized: false,
    }, response => {
      if (response.statusCode && response.statusCode >= 400) {
        clearTimeout(timer);
        response.destroy();
        reject(new RpcResponseError(`Antigravity RPC ${method} HTTP ${response.statusCode}`));
        return;
      }
      resolve({ response, dispose: () => { clearTimeout(timer); response.destroy(); req.destroy(); } });
    });
    const timer = setTimeout(() => req.destroy(new RpcResponseError(`Antigravity RPC ${method} timeout`)), timeoutMs);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(payload);
  });
}

export class AntigravityLsClient {
  constructor(private readonly server: AntigravityServerInfo) {}

  async call<T>(method: string, body: unknown = {}, timeoutMs = 6_000): Promise<T> {
    const { response, dispose } = await openResponse(this.server, method, body, this.server.protocol, timeoutMs);
    try {
      let raw = '';
      let bytes = 0;
      response.setEncoding('utf8');
      for await (const chunk of response) {
        bytes += Buffer.byteLength(chunk as string);
        if (bytes > MAX_RPC_RESPONSE_BYTES) throw new RpcResponseError(`Antigravity RPC ${method} response too large`);
        raw += chunk;
      }
      return JSON.parse(raw || '{}') as T;
    } finally {
      dispose();
    }
  }

  private async *streamArray(method: string, body: unknown, key: string, selection: JsonSelection, timeoutMs: number) {
    const { response, dispose } = await openResponse(this.server, method, body, this.server.protocol, timeoutMs);
    const reader = new RpcArrayReader(key, selection);
    try {
      response.setEncoding('utf8');
      for await (const chunk of response) {
        reader.write(chunk as string);
        yield* reader.takeRecords();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      reader.end();
      yield* reader.takeRecords();
    } finally {
      dispose();
    }
  }

  streamGeneratorMetadata(cascadeId: string, offset: number, timeoutMs = 8_000) {
    return this.streamArray('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId, generatorMetadataOffset: offset, includeMessages: false,
    }, 'generatorMetadata', GENERATOR_SELECTION, timeoutMs);
  }

  streamSteps(cascadeId: string, offset: number, timeoutMs = 8_000) {
    return this.streamArray('GetCascadeTrajectorySteps', {
      cascadeId, stepOffset: offset, trajectoryVerbosity: 2, disableRehydration: true,
    }, 'steps', STEP_SELECTION, timeoutMs);
  }

  getUserStatus(timeoutMs = 6_000): Promise<AntigravityUserStatusResponse> {
    return this.call('GetUserStatus', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    }, timeoutMs);
  }

  retrieveUserQuotaSummary(timeoutMs = 6_000): Promise<AntigravityQuotaSummaryResponse> {
    return this.call('RetrieveUserQuotaSummary', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    }, timeoutMs);
  }

  getAllCascadeTrajectories(timeoutMs = 6_000): Promise<AntigravityTrajectorySummariesResponse> {
    return this.call('GetAllCascadeTrajectories', {}, timeoutMs);
  }
}
