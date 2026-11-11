import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { generateKeyPairSync, sign } from 'node:crypto';

import { AntigravityLsClient } from '../dist/main/providers/antigravity/lsClient.js';

function ephemeralTls() {
  const der = (tag, ...values) => {
    const value = Buffer.concat(values);
    const length = value.length < 128 ? Buffer.from([value.length])
      : value.length < 256 ? Buffer.from([0x81, value.length]) : Buffer.from([0x82, value.length >> 8, value.length & 255]);
    return Buffer.concat([Buffer.from([tag]), length, value]);
  };
  const sequence = (...values) => der(0x30, ...values);
  const oid = hex => der(6, Buffer.from(hex, 'hex'));
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5, Buffer.alloc(0)));
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('localhost')))));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tbs = sequence(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    sequence(der(0x17, Buffer.from('260101000000Z')), der(0x17, Buffer.from('360101000000Z'))), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const certificate = sequence(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----` };
}

test('Antigravity uses the discovered HTTPS protocol for status and streamed records', async () => {
  const server = https.createServer(ephemeralTls(), (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/GetUserStatus')) res.end(JSON.stringify({ userStatus: { name: 'test' } }));
    else if (req.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) res.end(JSON.stringify({ generatorMetadata: [{ executionId: 'test' }] }));
    else res.end(JSON.stringify({ steps: [{ metadata: { createdAt: '2026-11-11T00:00:00Z' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new AntigravityLsClient({ pid: 1, port: server.address().port, protocol: 'https', csrfToken: 'test' });
    assert.equal((await client.getUserStatus()).userStatus.name, 'test');
    const metadata = [];
    for await (const row of client.streamGeneratorMetadata('sample', 0)) metadata.push(row);
    assert.equal(metadata[0].value.executionId, 'test');
    const steps = [];
    for await (const row of client.streamSteps('sample', 0)) steps.push(row);
    assert.equal(steps[0].value.metadata.createdAt, '2026-11-11T00:00:00Z');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

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
    const client = new AntigravityLsClient({ pid: 10, port, protocol: 'http', csrfToken: 'csrf-test' });
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

test('Antigravity LS client requests the grouped quota summary with IDE metadata', async () => {
  let seenRequest = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seenRequest = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: { groups: [] } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new AntigravityLsClient({ pid: 11, port: server.address().port, protocol: 'http', csrfToken: 'csrf-test' });
    await client.retrieveUserQuotaSummary(1_000);
    assert.equal(seenRequest.url, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');
    assert.deepEqual(seenRequest.body, {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
