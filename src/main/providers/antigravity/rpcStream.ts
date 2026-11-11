export type JsonSelection = true | { readonly [key: string]: JsonSelection };

interface Frame {
  array: boolean;
  state: 'key' | 'keyAfterComma' | 'colon' | 'value' | 'valueAfterComma' | 'comma';
  key: string;
  index: number;
  selection?: JsonSelection;
  value?: any;
  recordIndex?: number;
}

export class RpcArrayReader {
  private frames: Frame[] = [];
  private rootRead = false;
  private mode: 'normal' | 'string' | 'literal' = 'normal';
  private token = '';
  private capture = false;
  private escaped = false;
  private unicodeDigits = 0;
  private selectedBytes = 0;
  private records: Array<{ index: number; value: Record<string, any> }> = [];

  constructor(private readonly arrayKey: string, private readonly selection: JsonSelection) {}

  write(chunk: string): void {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (this.mode === 'string') {
        if (this.capture) {
          this.token += ch;
          this.selectedBytes += 1;
          if (this.selectedBytes > 128 * 1024) throw new Error('Antigravity RPC selected record too large');
        }
        if (this.unicodeDigits) {
          if (!/[0-9a-f]/i.test(ch)) throw new Error('Invalid Antigravity RPC JSON escape');
          this.unicodeDigits -= 1;
        } else if (this.escaped) {
          if (ch === 'u') this.unicodeDigits = 4;
          else if (!'"\\/bfnrt'.includes(ch)) throw new Error('Invalid Antigravity RPC JSON escape');
          this.escaped = false;
        } else if (ch === '\\') this.escaped = true;
        else if (ch === '"') {
          this.mode = 'normal';
          const frame = this.frames[this.frames.length - 1];
          const value = this.capture ? JSON.parse(this.token) : undefined;
          if (frame && !frame.array && (frame.state === 'key' || frame.state === 'keyAfterComma')) {
            frame.key = value;
            frame.state = 'colon';
          } else this.consume(value);
          this.token = '';
        } else if (ch.charCodeAt(0) < 32) throw new Error('Invalid Antigravity RPC JSON string');
        continue;
      }
      if (this.mode === 'literal') {
        if (!/[\s,\]}]/.test(ch)) {
          this.token += ch;
          if (this.token.length > 128) throw new Error('Invalid Antigravity RPC JSON value');
          continue;
        }
        this.consume(JSON.parse(this.token));
        this.token = '';
        this.mode = 'normal';
      }
      if (/\s/.test(ch)) continue;
      const frame = this.frames[this.frames.length - 1];
      if (ch === '"') {
        this.capture = !!frame && !frame.array && (frame.state === 'key' || frame.state === 'keyAfterComma')
          || this.valueSelection() === true;
        this.token = this.capture ? '"' : '';
        this.mode = 'string';
      } else if (ch === '{' || ch === '[') {
        const selection = this.valueSelection();
        const recordIndex = frame?.array && this.frames.length === 2 && frame.key === this.arrayKey
          ? frame.index : undefined;
        if (recordIndex !== undefined) this.selectedBytes = 0;
        const value = selection ? ch === '[' ? [] : {} : undefined;
        this.consume(value, true);
        this.frames.push({ array: ch === '[', state: ch === '[' ? 'value' : 'key', key: '', index: 0,
          selection, value, recordIndex });
        if (this.frames.length === 2 && frame?.key === this.arrayKey) {
          this.frames[this.frames.length - 1].key = this.arrayKey;
        }
        if (this.frames.length > 64) throw new Error('Antigravity RPC JSON nesting too deep');
      } else if (ch === '}' || ch === ']') {
        if (!frame || frame.array !== (ch === ']')
          || !['comma', frame.array ? 'value' : 'key'].includes(frame.state)) {
          throw new Error('Invalid Antigravity RPC JSON container');
        }
        this.frames.pop();
        if (frame.recordIndex !== undefined) {
          this.records.push({ index: frame.recordIndex, value: frame.value ?? {} });
        }
      } else if (ch === ':') {
        if (!frame || frame.array || frame.state !== 'colon') throw new Error('Invalid Antigravity RPC JSON colon');
        frame.state = 'value';
      } else if (ch === ',') {
        if (!frame || frame.state !== 'comma') throw new Error('Invalid Antigravity RPC JSON comma');
        frame.state = frame.array ? 'valueAfterComma' : 'keyAfterComma';
      } else {
        this.mode = 'literal';
        this.token = ch;
      }
    }
  }

  takeRecords(): Array<{ index: number; value: Record<string, any> }> {
    const records = this.records;
    this.records = [];
    return records;
  }

  end(): void {
    if (this.mode === 'literal') {
      this.consume(JSON.parse(this.token));
      this.mode = 'normal';
    }
    if (!this.rootRead || this.mode !== 'normal' || this.frames.length) throw new Error('Incomplete Antigravity RPC JSON');
  }

  private valueSelection(): JsonSelection | undefined {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return undefined;
    if (this.frames.length === 1) return undefined;
    if (this.frames.length === 2 && frame.array && frame.key === this.arrayKey) return this.selection;
    if (frame.selection === true) return true;
    const key = frame.array ? '*' : frame.key;
    return frame.selection && Object.prototype.hasOwnProperty.call(frame.selection, key) ? frame.selection[key] : undefined;
  }

  private consume(value: unknown, container = false): void {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) {
      if (this.rootRead) throw new Error('Multiple Antigravity RPC JSON values');
      this.rootRead = true;
      return;
    }
    if (frame.state !== 'value' && frame.state !== 'valueAfterComma') throw new Error('Invalid Antigravity RPC JSON value');
    if (!container && this.frames.length === 2 && frame.array && frame.key === this.arrayKey) {
      this.records.push({ index: frame.index, value: {} });
    }
    if (frame.value !== undefined && value !== undefined) {
      this.selectedBytes += typeof value === 'object' ? 32 : 8;
      if (this.selectedBytes > 128 * 1024) throw new Error('Antigravity RPC selected record too large');
      if (frame.array) frame.value.push(value);
      else if (frame.key !== '__proto__') frame.value[frame.key] = value;
    }
    frame.index += 1;
    frame.state = 'comma';
  }
}

export const STEP_SELECTION: JsonSelection = {
  status: true,
  metadata: { createdAt: true },
};

export const GENERATOR_SELECTION: JsonSelection = {
  executionId: true, error: true, stepIndices: { '*': true }, createdAt: true, timestamp: true,
  plannerConfig: { truncationThresholdTokens: true },
  chatModel: {
    model: true, responseModel: true,
    usage: { model: true, inputTokens: true, outputTokens: true, cacheReadTokens: true,
      cacheCreationTokens: true, thinkingOutputTokens: true, responseOutputTokens: true },
    chatStartMetadata: { createdAt: true, startTime: true, contextWindowMetadata: { maxTokens: true } },
    tools: { '*': { name: true } },
    messagePrompts: { '*': { toolCalls: { '*': { name: true } } } },
  },
};
