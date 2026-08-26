import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  findWindowsProcessCandidates,
  parseWindowsProcessCandidates,
  WINDOWS_LANGUAGE_SERVER_NAMES,
} from '../dist/main/providers/antigravity/processFinder.js';

test('Antigravity process finder parses Windows CIM JSON arrays and filters unrelated processes', () => {
  const rows = [
    {
      ProcessId: 101,
      CommandLine: 'language_server_windows_x64.exe --csrf_token secret-a --app_data_dir antigravity --extension_server_port 54321 --server_port 12345 --workspace_id ws-1',
      CreationDate: '20260601090000.000000+480',
    },
    {
      ProcessId: 102,
      CommandLine: 'language_server_windows_x64.exe --csrf_token secret-b --app_data_dir other --extension_server_port 33333',
    },
  ];

  const candidates = parseWindowsProcessCandidates(JSON.stringify(rows));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].pid, 101);
  assert.equal(candidates[0].csrfToken, 'secret-a');
  assert.equal(candidates[0].extensionPort, 54321);
  assert.equal(candidates[0].serverPort, 12345);
  assert.equal(candidates[0].workspaceId, 'ws-1');
  assert.equal('commandLine' in candidates[0], false);
});

test('Antigravity process finder parses single-object CIM JSON output', () => {
  const candidate = parseWindowsProcessCandidates(JSON.stringify({
    ProcessId: '201',
    CommandLine: 'language_server_windows_x64.exe --csrf_token="secret-c" --app_data_dir="antigravity" --extension_server_port=23456',
  }));

  assert.equal(candidate.length, 1);
  assert.equal(candidate[0].pid, 201);
  assert.equal(candidate[0].csrfToken, 'secret-c');
  assert.equal(candidate[0].extensionPort, 23456);
});

test('Antigravity process finder accepts absolute Antigravity app data paths', () => {
  const candidate = parseWindowsProcessCandidates(JSON.stringify({
    ProcessId: '301',
    CommandLine: 'language_server_windows_x64.exe --csrf_token="secret-d" --app_data_dir="C:\\Users\\example\\AppData\\Roaming\\Antigravity" --extension_server_port=34567',
  }));

  assert.equal(candidate.length, 1);
  assert.equal(candidate[0].pid, 301);
  assert.equal(candidate[0].csrfToken, 'secret-d');
  assert.equal(candidate[0].extensionPort, 34567);
});

test('Antigravity process finder supports current and legacy Windows executable names', () => {
  assert.deepEqual(WINDOWS_LANGUAGE_SERVER_NAMES, [
    'language_server.exe',
    'language_server_windows_x64.exe',
  ]);
});

test('Antigravity process finder falls back when the primary name query is empty', async () => {
  const scripts = [];
  const candidate = {
    ProcessId: 401,
    CommandLine: 'language_server.exe --csrf_token secret-e --app_data_dir antigravity --extension_server_port 45678',
  };
  const result = await findWindowsProcessCandidates(1_000, async script => {
    scripts.push(script);
    return scripts.length === 1 ? '[]' : JSON.stringify(candidate);
  });

  assert.equal(scripts.length, 2);
  assert.match(scripts[0], /language_server\.exe/);
  assert.match(scripts[0], /language_server_windows_x64\.exe/);
  assert.match(scripts[1], /CommandLine/);
  assert.equal(result[0].pid, 401);
  assert.equal(result[0].csrfToken, 'secret-e');
});

test('Antigravity process finder threads a discovery timeout through process and port probes', () => {
  const source = fs.readFileSync('src/main/providers/antigravity/processFinder.ts', 'utf8');

  assert.match(source, /function remainingTimeoutMs\(stopAt: number, maxMs: number\)/);
  assert.match(source, /findWindowsProcessCandidates\(remainingTimeoutMs\(stopAt, 15_000\)\)/);
  assert.match(source, /findWorkingPort\(candidate, stopAt\)/);
  assert.match(source, /testPortWithProtocol\(port, candidate\.csrfToken, 'http', remainingTimeoutMs\(stopAt, 3_000\)\)/);
  assert.match(source, /testPortWithProtocol\(port, candidate\.csrfToken, 'https', remainingTimeoutMs\(stopAt, 3_000\)\)/);
});
