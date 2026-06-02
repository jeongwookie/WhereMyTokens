import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AntigravityLsClient } from '../dist/main/providers/antigravity/lsClient.js';

test('Antigravity LS client calls local Connect RPC with CSRF and protocol headers', async () => {
  let seenRequest = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seenRequest = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: JSON.parse(body),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new AntigravityLsClient({ pid: 10, port, csrfToken: 'csrf-test' });
    const result = await client.call('GetUserStatus', { wrapper_data: {} }, 1000);

    assert.deepEqual(result, { ok: true });
    assert.equal(seenRequest.url, '/exa.language_server_pb.LanguageServerService/GetUserStatus');
    assert.equal(seenRequest.method, 'POST');
    assert.equal(seenRequest.headers['x-codeium-csrf-token'], 'csrf-test');
    assert.equal(seenRequest.headers['connect-protocol-version'], '1');
    assert.deepEqual(seenRequest.body, { wrapper_data: {} });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
