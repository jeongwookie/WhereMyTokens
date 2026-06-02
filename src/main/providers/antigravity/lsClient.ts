import * as http from 'http';
import * as https from 'https';
import type {
  AntigravityGeneratorMetadataResponse,
  AntigravityServerInfo,
  AntigravityTrajectoryResponse,
  AntigravityTrajectorySummariesResponse,
  AntigravityUserStatusResponse,
} from './types';

type RpcProtocol = 'http' | 'https';
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;

function requestJson<T>(
  server: AntigravityServerInfo,
  method: string,
  body: unknown,
  protocol: RpcProtocol,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    let settled = false;
    const fail = (error: Error | unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const done = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const lib = protocol === 'https' ? https : http;
    const options: http.RequestOptions & https.RequestOptions = {
      hostname: '127.0.0.1',
      port: server.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': server.csrfToken,
      },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    };

    const req = lib.request(options, res => {
      let raw = '';
      let rawBytes = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        rawBytes += Buffer.byteLength(chunk, 'utf8');
        if (rawBytes > MAX_RPC_RESPONSE_BYTES) {
          fail(new Error(`Antigravity RPC ${method} response too large`));
          req.destroy();
          return;
        }
        raw += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          fail(new Error(`Antigravity RPC ${method} HTTP ${res.statusCode}`));
          return;
        }
        try {
          done(JSON.parse(raw || '{}') as T);
        } catch (error) {
          fail(error);
        }
      });
    });

    req.on('error', fail);
    req.on('timeout', () => {
      req.destroy();
      fail(new Error(`Antigravity RPC ${method} timeout`));
    });
    req.write(payload);
    req.end();
  });
}

export class AntigravityLsClient {
  constructor(private readonly server: AntigravityServerInfo) {}

  async call<T>(method: string, body: unknown = {}, timeoutMs = 6_000): Promise<T> {
    const startedAt = Date.now();
    try {
      return await requestJson<T>(this.server, method, body, 'http', timeoutMs);
    } catch {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      return requestJson<T>(this.server, method, body, 'https', remainingMs);
    }
  }

  getUserStatus(timeoutMs = 6_000): Promise<AntigravityUserStatusResponse> {
    return this.call('GetUserStatus', {
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en',
      },
    }, timeoutMs);
  }

  getAllCascadeTrajectories(timeoutMs = 6_000): Promise<AntigravityTrajectorySummariesResponse> {
    return this.call('GetAllCascadeTrajectories', {}, timeoutMs);
  }

  getCascadeTrajectoryGeneratorMetadata(
    cascadeId: string,
    timeoutMs = 8_000,
  ): Promise<AntigravityGeneratorMetadataResponse> {
    return this.call('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId,
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
      },
    }, timeoutMs);
  }

  getCascadeTrajectory(cascadeId: string, timeoutMs = 8_000): Promise<AntigravityTrajectoryResponse> {
    return this.call('GetCascadeTrajectory', {
      cascadeId,
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
      },
    }, timeoutMs);
  }
}
