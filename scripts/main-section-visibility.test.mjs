import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('settings model persists hidden main sections', () => {
  const types = fs.readFileSync('src/renderer/types.ts', 'utf8');
  const ipc = fs.readFileSync('src/main/ipc.ts', 'utf8');
  const app = fs.readFileSync('src/renderer/App.tsx', 'utf8');

  assert.match(types, /hiddenMainSections: MainSectionId\[\]/);
  assert.match(ipc, /hiddenMainSections: string\[\]/);
  assert.match(ipc, /hiddenMainSections: \[\]/);
  assert.match(app, /hiddenMainSections: \[\]/);
});

test('main sections normalize hidden cards and preserve one visible card', () => {
  const sections = fs.readFileSync('src/renderer/mainSections.ts', 'utf8');
  assert.match(sections, /normalizeHiddenMainSections/);
  assert.match(sections, /if \(normalized\.length >= ordered\.length\)/);
});

test('MainView filters hidden main sections before rendering', () => {
  const mainView = fs.readFileSync('src/renderer/views/MainView.tsx', 'utf8');
  assert.match(mainView, /normalizeHiddenMainSections/);
  assert.match(mainView, /visibleMainSections/);
  assert.match(mainView, /visibleMainSections\.map\(renderMainSection\)/);
});

test('SettingsView can show and hide dashboard cards', () => {
  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');
  assert.match(settingsView, /hiddenMainSections/);
  assert.match(settingsView, /toggleMainSectionHidden/);
  assert.match(settingsView, /visibleSectionCount/);
  assert.match(settingsView, /\? 'Show' : 'Hide'/);
});
