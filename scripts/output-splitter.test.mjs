import test from 'node:test';
import assert from 'node:assert/strict';
import mod from '../dist/main/outputSplitter.js';

const { splitOutput, signatureProxyThinkingChars, CALIB, assertCalibInBand, compositionToDelta } = mod;

function weights(over = {}) {
  return {
    thinkingChars: 0, responseChars: 0,
    toolChars: { read: 0, editWrite: 0, search: 0, git: 0, buildTest: 0, terminal: 0, subagents: 0, web: 0 },
    ...over,
  };
}
const toolSum = o => Object.values(o.toolOutput).reduce((a, b) => a + b, 0);

test('exact-thinking path: thinking exact, remainder split response/tool by char proportion', () => {
  const w = weights({ responseChars: 60, toolChars: { read: 0, editWrite: 60, search: 0, git: 0, buildTest: 0, terminal: 0, subagents: 0, web: 0 } });
  const out = splitOutput(w, 400, 160);
  assert.equal(out.thinking, 160);
  assert.equal(out.response, 120);
  assert.equal(out.toolOutput.editWrite, 120);
  assert.equal(out.thinking + out.response + toolSum(out), 400);
});

test('proxy path: thinking weight from signature length, whole output split 3 ways', () => {
  const w = weights({ thinkingChars: signatureProxyThinkingChars(240), responseChars: 100 });
  const out = splitOutput(w, 200); // 100:100 chars
  assert.equal(out.thinking, 100);
  assert.equal(out.response, 100);
  assert.equal(out.thinking + out.response + toolSum(out), 200);
});

test('exact-sum AND non-negative in the pathological equal-weight remainder case (A3)', () => {
  // 8 equal tool weights + response, total 9 parts, outputTokens chosen so naive rounding overshoots.
  const w = weights({ responseChars: 1, toolChars: { read: 1, editWrite: 1, search: 1, git: 1, buildTest: 1, terminal: 1, subagents: 1, web: 1 } });
  const out = splitOutput(w, 100, 0); // remaining 100 across 9 equal parts
  const parts = [out.response, ...Object.values(out.toolOutput)];
  assert.ok(parts.every(v => v >= 0), 'every part >= 0');
  assert.equal(out.thinking + out.response + toolSum(out), 100);
});

test('exact-sum with rounding remainder (proxy path, 3 unequal weights)', () => {
  const w = weights({ thinkingChars: 33, responseChars: 33, toolChars: { read: 34, editWrite: 0, search: 0, git: 0, buildTest: 0, terminal: 0, subagents: 0, web: 0 } });
  const out = splitOutput(w, 100);
  assert.ok([out.thinking, out.response, out.toolOutput.read].every(v => v >= 0));
  assert.equal(out.thinking + out.response + toolSum(out), 100);
});

test('zero output yields all-zero composition (outputTokens === 0 is legal)', () => {
  const out = splitOutput(weights(), 0);
  assert.equal(out.thinking + out.response + toolSum(out), 0);
});

test('non-finite / negative outputTokens THROWS (fail-loud, not silent zero) — C3', () => {
  assert.throws(() => splitOutput(weights({ responseChars: 50 }), NaN), /non-finite\/negative outputTokens/);
  assert.throws(() => splitOutput(weights({ responseChars: 50 }), Infinity), /non-finite\/negative outputTokens/);
  assert.throws(() => splitOutput(weights({ responseChars: 50 }), -5), /non-finite\/negative outputTokens/);
});

test('exact thinking > output THROWS (fail-loud, not clamp) — B5', () => {
  // reasoning is a subset of output by source contract; exceeding it = upstream drift.
  assert.throws(() => splitOutput(weights({ responseChars: 50 }), 100, 500),
    /exactThinkingTokens .* outputTokens|reasoning .* exceeds output/);
});

test('exact thinking == output is the legal boundary: response/tool 0, exact sum', () => {
  const out = splitOutput(weights({ responseChars: 50 }), 100, 100);
  assert.equal(out.thinking, 100); assert.equal(out.response, 0); assert.equal(toolSum(out), 0);
});

test('non-finite exactThinkingTokens THROWS (B5)', () => {
  assert.throws(() => splitOutput(weights({ responseChars: 50 }), 100, NaN));
  assert.throws(() => splitOutput(weights({ responseChars: 50 }), 100, Infinity));
});

test('outputTokens 0 with positive/non-finite exact thinking THROWS (validated before zero-return) — F1', () => {
  assert.throws(() => splitOutput(weights(), 0, 5));
  assert.throws(() => splitOutput(weights(), 0, NaN));
});

test('invalid (NaN/negative) char weight THROWS (fail-loud, not coerced to 0) — F2', () => {
  assert.throws(() => splitOutput(weights({ responseChars: NaN }), 100));
  assert.throws(() => splitOutput(weights({ responseChars: -3 }), 100));
  assert.throws(() => splitOutput(weights({ toolChars: { read: -1, editWrite: 0, search: 0, git: 0, buildTest: 0, terminal: 0, subagents: 0, web: 0 } }), 100));
});

test('no char signal: non-thinking remainder goes entirely to response (deterministic)', () => {
  const out = splitOutput(weights(), 100, 40);
  assert.equal(out.thinking, 40); assert.equal(out.response, 60); assert.equal(toolSum(out), 0);
});

test('CALIB drift guard: observed-band ratios pass, scheme-change ratio throws', () => {
  assertCalibInBand(150, 100); // 1.5는 허용 범위 안이다.
  assertCalibInBand(265, 100); // 2.65는 CALIB 중심값에 가깝다.
  assertCalibInBand(379, 100); // 3.79는 짧은 블록에서 관측된 실제 outlier다.
  assert.throws(() => assertCalibInBand(1000, 100)); // 10x는 허용 범위 밖이다.
  assert.throws(() => assertCalibInBand(110, 100));  // 1.1은 CALIB_MIN 아래다.
});

test('compositionToDelta flattens nested toolOutput to flat row keys', () => {
  const comp = { thinking: 1, response: 2, toolOutput: { read: 0, editWrite: 5, search: 0, git: 0, buildTest: 0, terminal: 0, subagents: 0, web: 0 } };
  const d = compositionToDelta(comp);
  assert.equal(d.thinking, 1); assert.equal(d.response, 2); assert.equal(d.toolOutputEditWrite, 5);
  assert.equal(d.read, 0); // counts default zero
});
