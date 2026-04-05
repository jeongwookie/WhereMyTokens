import { Notification } from 'electron';

export function notifyThresholdExceeded(totalTokens: number, threshold: number) {
  if (!Notification.isSupported()) return;

  new Notification({
    title: 'WhereMyTokens — Usage Alert',
    body: `Today's token usage has exceeded ${threshold.toLocaleString()}. (Current: ${totalTokens.toLocaleString()})`,
    silent: false,
  }).show();
}

export function notifyNewSession(projectName: string) {
  if (!Notification.isSupported()) return;

  new Notification({
    title: 'WhereMyTokens — New Session',
    body: `${projectName} session has started.`,
    silent: true,
  }).show();
}
