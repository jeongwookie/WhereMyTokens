/**
 * Notification history management (up to 50 entries)
 * Stored in electron-store, persists across app restarts
 */
import Store from 'electron-store';

export type NotifType = 'alert';

export interface HistoryItem {
  id: string;
  type: NotifType;
  title: string;
  body: string;
  timestamp: number;
  icon: string;  // emoji
}

const MAX_HISTORY = 50;

let histStore: Store<{ items: HistoryItem[] }> | null = null;

function getStore(): Store<{ items: HistoryItem[] }> {
  if (!histStore) {
    histStore = new Store({ name: 'notification-history', defaults: { items: [] } });
  }
  return histStore;
}

export function addNotification(type: NotifType, title: string, body: string): HistoryItem {
  const store = getStore();
  const item: HistoryItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    title,
    body,
    timestamp: Date.now(),
    icon: '⚠️',
  };
  const items = [item, ...store.get('items')].slice(0, MAX_HISTORY);
  store.set('items', items);
  return item;
}

export function getHistory(): HistoryItem[] {
  return getStore().get('items');
}

export function clearHistory(): void {
  getStore().set('items', []);
}
