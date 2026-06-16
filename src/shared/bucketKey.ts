export type BreakdownGrain = 'day' | 'week' | 'month';

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

export function bucketDateRange(grain: BreakdownGrain, bucketKey: string): { startDate: string; endDate: string } {
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
