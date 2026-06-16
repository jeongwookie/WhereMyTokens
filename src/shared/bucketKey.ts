export type BreakdownGrain = 'day' | 'week' | 'month';

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function keyFromDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dayKey(dateKey: string): string {
  return dateKey;
}

export function weekKey(dateKey: string): string {
  const date = dateFromKey(dateKey);
  const offset = (date.getDay() + 6) % 7; // Monday-start
  date.setDate(date.getDate() - offset);
  return keyFromDate(date);
}

export function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export function isBreakdownGrain(value: unknown): value is BreakdownGrain {
  return value === 'day' || value === 'week' || value === 'month';
}

function isValidDateKey(value: string): boolean {
  const match = DATE_KEY_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return keyFromDate(date) === value;
}

function isValidMonthKey(value: string): boolean {
  const match = MONTH_KEY_RE.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

export function isBucketKeyForGrain(grain: BreakdownGrain, bucketKey: unknown): bucketKey is string {
  if (typeof bucketKey !== 'string') return false;
  return grain === 'month' ? isValidMonthKey(bucketKey) : isValidDateKey(bucketKey);
}

export function bucketDateRange(grain: BreakdownGrain, bucketKey: string): { startDate: string; endDate: string } {
  if (!isBucketKeyForGrain(grain, bucketKey)) throw new Error(`invalid ${grain} bucket key ${bucketKey}`);
  if (grain === 'day') return { startDate: bucketKey, endDate: bucketKey };
  if (grain === 'week') {
    const start = dateFromKey(bucketKey);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { startDate: keyFromDate(start), endDate: keyFromDate(end) };
  }
  // month: bucketKey is `YYYY-MM`
  const [y, m] = bucketKey.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0); // day 0 of next month = last day
  return { startDate: keyFromDate(start), endDate: keyFromDate(end) };
}
