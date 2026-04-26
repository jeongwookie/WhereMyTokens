import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

function normalizeRendererReason(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    };
  }
  return { value: String(reason) };
}

window.wmt.isDebugInstrumentationEnabled().then((enabled) => {
  if (!enabled) return;

  window.addEventListener('error', (event) => {
    window.wmt.reportDebugRendererEvent({
      type: 'renderer-error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: normalizeRendererReason(event.error),
    }).catch(() => {});
  });

  window.addEventListener('unhandledrejection', (event) => {
    window.wmt.reportDebugRendererEvent({
      type: 'renderer-unhandledrejection',
      reason: normalizeRendererReason(event.reason),
    }).catch(() => {});
  });
}).catch(() => {});

const el = document.getElementById('root');
if (!el) throw new Error('root not found');
createRoot(el).render(<App />);
