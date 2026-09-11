import { scanJsonlLines } from '../shared/jsonlLineScanner';
import { usageVector, type TokenVector } from './accounting';

export interface CounterRevisionEvidence {
  kind: 'mixed-origin' | 'duplicate-notification';
  timestampMs: number;
  faulty: TokenVector;
  correct: TokenVector;
  responseKey: string;
  ownerTimestampMs: number;
}

const same = (a: TokenVector, b: TokenVector) => a.every((n, i) => n === b[i]);
function difference(a: TokenVector, b: TokenVector): TokenVector | null {
  const d = a.map((n, i) => n - b[i]) as TokenVector;
  if (d[0] < 0 || d[2] < 0) return null;
  d[1] = Math.min(d[0], Math.max(0, d[1]));
  d[3] = Math.min(d[2], Math.max(0, d[3]));
  return d;
}

/** Recognizes exact historical defect equations, not an alternative usage parser. */
export async function readCounterRevisionEvidence(file: string, endOffset: number, sourceId: string): Promise<Map<number, CounterRevisionEvidence>> {
  const result = new Map<number, CounterRevisionEvidence>();
  let thread: TokenVector | null = null;
  let notification: TokenVector | null = null;
  let notificationOffset: TokenVector | null = null;
  let mappedNotification: TokenVector | null = null;
  let notificationTurn = '';
  let turn = '';
  let validSource = false;
  let detail: { usage: TokenVector; total: TokenVector; turnTotal: TokenVector | null; timestampMs: number; responseKey: string; turn: string } | null = null;
  await scanJsonlLines(file, 0, undefined, line => {
    let object: Record<string, any>;
    try { object = JSON.parse(line); } catch { return; }
    const p = object.payload;
    if (!p || typeof p !== 'object') return;
    if (object.type === 'session_meta') {
      validSource = `codex:${p.id}` === sourceId && !p.forked_from_id;
      return;
    }
    if (!validSource) return;
    if (object.type === 'event_msg' && p.type === 'task_started') {
      turn = typeof p.turn_id === 'string' ? p.turn_id : '';
      return;
    }
    const timestampMs = typeof object.timestamp === 'string' ? Date.parse(object.timestamp) : NaN;
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) return;
    if (object.type === 'token_usage_record') {
      const total = usageVector(p.thread_token_usage), usage = usageVector(p.usage);
      const responseKey = typeof p.response_id === 'string' && p.response_id ? `codex:response:${p.response_id}` : '';
      if (total && usage && responseKey) {
        const delta = thread && difference(total, thread);
        const faulty = notification && difference(total, notification);
        if (delta && same(delta, usage) && faulty && !same(faulty, usage)
          && mappedNotification && thread && same(mappedNotification, thread)) {
          result.set(timestampMs, { kind: 'mixed-origin', timestampMs, faulty, correct: usage, responseKey, ownerTimestampMs: timestampMs });
        }
        // A delayed record cannot displace the evidence for the latest execution.
        if (!thread || total[0] >= thread[0] && total[2] >= thread[2]) {
          thread = total;
          detail = { usage, total, turnTotal: usageVector(p.turn_token_usage), timestampMs, responseKey,
            turn: typeof p.turn_id === 'string' ? p.turn_id : turn };
        }
      }
      return;
    }
    if (object.type === 'event_msg' && p.type === 'token_count') {
      const total = usageVector(p.info?.total_token_usage), last = usageVector(p.info?.last_token_usage);
      if (total && detail && (same(total, detail.total)
        || turn && detail.turn === turn && detail.turnTotal && same(total, detail.turnTotal))) {
        const offset = detail.total.map((n, i) => n - total[i]) as TokenVector;
        if (offset.every(n => n >= 0)) notificationOffset = offset;
      }
      mappedNotification = total && notificationOffset ? total.map((n, i) => n + notificationOffset![i]) as TokenVector : null;
      if (total && last && notification && same(total, notification) && turn && turn === notificationTurn
        && detail && detail.turn === turn && same(last, detail.usage) && timestampMs > detail.timestampMs
        && mappedNotification && same(mappedNotification, detail.total)) {
        result.set(timestampMs, { kind: 'duplicate-notification', timestampMs, faulty: last, correct: [0, 0, 0, 0],
          responseKey: detail.responseKey, ownerTimestampMs: detail.timestampMs });
      }
      if (total) { notification = total; notificationTurn = turn; }
    }
  }, endOffset);
  return result;
}
