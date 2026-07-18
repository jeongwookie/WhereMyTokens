import type { UsageEntry, UsageEntryProjection } from './types';
import type { ProviderId } from '../providers/types';

const INITIAL_CAPACITY = 256;

type ProjectionEntryInput = Pick<
  UsageEntry,
  | 'timestampMs'
  | 'provider'
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheCreationTokens'
  | 'cacheReadTokens'
  | 'costUSD'
  | 'cacheSavingsUSD'
>;

function emptyFloat64(): Float64Array {
  return new Float64Array(0);
}

function emptyUint32(): Uint32Array {
  return new Uint32Array(0);
}

function growFloat64(values: Float64Array, capacity: number): Float64Array {
  const next = new Float64Array(capacity);
  next.set(values);
  return next;
}

function growUint32(values: Uint32Array, capacity: number): Uint32Array {
  const next = new Uint32Array(capacity);
  next.set(values);
  return next;
}

function trimFloat64(values: Float64Array, count: number): Float64Array {
  if (values.length === count) return values;
  return values.slice(0, count);
}

function trimUint32(values: Uint32Array, count: number): Uint32Array {
  if (values.length === count) return values;
  return values.slice(0, count);
}

export function emptyUsageEntryProjection(): UsageEntryProjection {
  return {
    count: 0,
    providers: [],
    models: [],
    providerIndexes: emptyUint32(),
    timestampMs: emptyFloat64(),
    modelIndexes: emptyUint32(),
    inputTokens: emptyFloat64(),
    outputTokens: emptyFloat64(),
    cacheCreationTokens: emptyFloat64(),
    cacheReadTokens: emptyFloat64(),
    costUSD: emptyFloat64(),
    cacheSavingsUSD: emptyFloat64(),
  };
}

export class UsageEntryProjectionBuilder {
  private count = 0;
  private capacity: number;
  private readonly providers: ProviderId[] = [];
  private readonly providerIndexesByName = new Map<ProviderId, number>();
  private readonly models: string[] = [];
  private readonly modelIndexesByName = new Map<string, number>();
  private providerIndexes: Uint32Array<ArrayBufferLike>;
  private timestampMs: Float64Array<ArrayBufferLike>;
  private modelIndexes: Uint32Array<ArrayBufferLike>;
  private inputTokens: Float64Array<ArrayBufferLike>;
  private outputTokens: Float64Array<ArrayBufferLike>;
  private cacheCreationTokens: Float64Array<ArrayBufferLike>;
  private cacheReadTokens: Float64Array<ArrayBufferLike>;
  private costUSD: Float64Array<ArrayBufferLike>;
  private cacheSavingsUSD: Float64Array<ArrayBufferLike>;

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.capacity = Math.max(0, Math.floor(initialCapacity));
    this.providerIndexes = new Uint32Array(this.capacity);
    this.timestampMs = new Float64Array(this.capacity);
    this.modelIndexes = new Uint32Array(this.capacity);
    this.inputTokens = new Float64Array(this.capacity);
    this.outputTokens = new Float64Array(this.capacity);
    this.cacheCreationTokens = new Float64Array(this.capacity);
    this.cacheReadTokens = new Float64Array(this.capacity);
    this.costUSD = new Float64Array(this.capacity);
    this.cacheSavingsUSD = new Float64Array(this.capacity);
  }

  add(entry: ProjectionEntryInput): void {
    if (this.count >= this.capacity) this.grow();
    const index = this.count;
    this.providerIndexes[index] = this.providerIndex(entry.provider);
    this.timestampMs[index] = entry.timestampMs;
    this.modelIndexes[index] = this.modelIndex(entry.model);
    this.inputTokens[index] = entry.inputTokens;
    this.outputTokens[index] = entry.outputTokens;
    this.cacheCreationTokens[index] = entry.cacheCreationTokens;
    this.cacheReadTokens[index] = entry.cacheReadTokens;
    this.costUSD[index] = entry.costUSD;
    this.cacheSavingsUSD[index] = entry.cacheSavingsUSD;
    this.count += 1;
  }

  build(): UsageEntryProjection {
    if (this.count === 0) return emptyUsageEntryProjection();
    return {
      count: this.count,
      providers: [...this.providers],
      models: [...this.models],
      providerIndexes: trimUint32(this.providerIndexes, this.count),
      timestampMs: trimFloat64(this.timestampMs, this.count),
      modelIndexes: trimUint32(this.modelIndexes, this.count),
      inputTokens: trimFloat64(this.inputTokens, this.count),
      outputTokens: trimFloat64(this.outputTokens, this.count),
      cacheCreationTokens: trimFloat64(this.cacheCreationTokens, this.count),
      cacheReadTokens: trimFloat64(this.cacheReadTokens, this.count),
      costUSD: trimFloat64(this.costUSD, this.count),
      cacheSavingsUSD: trimFloat64(this.cacheSavingsUSD, this.count),
    };
  }

  private grow(): void {
    this.capacity = Math.max(INITIAL_CAPACITY, this.capacity * 2, this.count + 1);
    this.providerIndexes = growUint32(this.providerIndexes, this.capacity);
    this.timestampMs = growFloat64(this.timestampMs, this.capacity);
    this.modelIndexes = growUint32(this.modelIndexes, this.capacity);
    this.inputTokens = growFloat64(this.inputTokens, this.capacity);
    this.outputTokens = growFloat64(this.outputTokens, this.capacity);
    this.cacheCreationTokens = growFloat64(this.cacheCreationTokens, this.capacity);
    this.cacheReadTokens = growFloat64(this.cacheReadTokens, this.capacity);
    this.costUSD = growFloat64(this.costUSD, this.capacity);
    this.cacheSavingsUSD = growFloat64(this.cacheSavingsUSD, this.capacity);
  }

  private providerIndex(provider: ProviderId): number {
    const existing = this.providerIndexesByName.get(provider);
    if (existing !== undefined) return existing;
    const index = this.providers.length;
    this.providers.push(provider);
    this.providerIndexesByName.set(provider, index);
    return index;
  }

  private modelIndex(model: string): number {
    const existing = this.modelIndexesByName.get(model);
    if (existing !== undefined) return existing;
    const index = this.models.length;
    this.models.push(model);
    this.modelIndexesByName.set(model, index);
    return index;
  }
}

export function compactUsageEntries(entries: Iterable<UsageEntry>): UsageEntryProjection {
  const builder = new UsageEntryProjectionBuilder();
  for (const entry of entries) builder.add(entry);
  return builder.build();
}
