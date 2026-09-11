import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../ThemeContext';
import type { AccountingRevisionStatus } from '../../shared/accountingRevision';

export default function AccountingRevisionNotice({ persistent = false }: { persistent?: boolean }) {
  const { t } = useTranslation();
  const C = useTheme();
  const [status, setStatus] = useState<AccountingRevisionStatus | null>(null);
  const [page, setPage] = useState(0);
  const failed = () => setStatus({ state: 'failed', checkedSources: 0, totalSources: 0, notice: true, report: null });
  useEffect(() => {
    let alive = true, updates = 0;
    const unsubscribe = window.wmt.onAccountingRevision(next => { updates++; if (alive) { setStatus(next); setPage(0); } });
    void window.wmt.getAccountingRevision().then(next => { if (alive && !updates) setStatus(next); }).catch(() => { if (alive) failed(); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  if (!status || !persistent && !status.notice) return null;
  const report = status.report;
  const details = report?.sources.filter(source => source.outcome !== 'unchanged')
    .sort((a, b) => Number(b.correctedEntries > 0) - Number(a.correctedEntries > 0) || a.source.localeCompare(b.source)) ?? [];
  const running = status.state === 'running';
  const button: React.CSSProperties = { background: C.bgRow, color: C.textDim, border: `1px solid ${C.border}`,
    borderRadius: 4, padding: '4px 8px', cursor: running ? 'wait' : 'pointer', fontSize: 11 };
  const money = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <section aria-label={t('accountingRevision.title')} style={{ margin: persistent ? '8px 0' : 8,
    padding: 10, border: `1px solid ${C.border}`, borderRadius: 6, background: C.bgRow, fontSize: 11, lineHeight: 1.5 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
      <strong>{t('accountingRevision.title')}</strong>
      {!persistent && !running && <button type="button" style={button} onClick={() => {
        void window.wmt.dismissAccountingRevision().then(setStatus).catch(failed);
      }}>{t('accountingRevision.dismiss')}</button>}
    </div>
    {running && <div role="status">{t('accountingRevision.running', { count: status.checkedSources, total: status.totalSources })}</div>}
    {status.state === 'failed' && <div role="alert">{t('accountingRevision.failed')}</div>}
    {report && <>
      <div>{t('accountingRevision.corrected', { count: report.correctedEntries, amount: money(report.savedCostUSD) })}</div>
      <div style={{ color: C.textMuted }}>{t('accountingRevision.preserved', { count: report.preservedSources })}</div>
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer' }}>{t('accountingRevision.details')}</summary>
        <div style={{ color: C.textMuted, margin: '4px 0' }}>{t('accountingRevision.checked', { count: report.checkedSources, unchanged: report.unchangedSources })}</div>
        <div style={{ maxHeight: 300, overflowY: 'auto', overflowWrap: 'anywhere' }}>
          {details.slice(page * 25, (page + 1) * 25).map(source => <div key={source.source} style={{ borderTop: `1px solid ${C.border}`, padding: '6px 0' }}>
            <div>{t('accountingRevision.source', { id: source.source })} · {t(`accountingRevision.outcomes.${source.outcome}`)}</div>
            {source.fromMs !== null && <div style={{ color: C.textMuted }}>{new Date(source.fromMs).toLocaleString()} – {new Date(source.toMs!).toLocaleString()}</div>}
            {source.correctedEntries > 0 && <div>{t('accountingRevision.corrected', { count: source.correctedEntries, amount: money(source.savedCostUSD) })}</div>}
            {source.reason && <div style={{ color: C.textMuted }}>{t(`accountingRevision.reasons.${source.reason}`)}</div>}
          </div>)}
        </div>
        {details.length > 25 && <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <button type="button" style={button} disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('accountingRevision.previous')}</button>
          <span>{page + 1} / {Math.ceil(details.length / 25)}</span>
          <button type="button" style={button} disabled={(page + 1) * 25 >= details.length} onClick={() => setPage(p => p + 1)}>{t('accountingRevision.next')}</button>
        </div>}
        <div style={{ color: C.textMuted, marginTop: 6 }}>{t('accountingRevision.backup')}</div>
      </details>
    </>}
    {(persistent || status.state === 'failed' || !!report?.preservedSources) && <button type="button" disabled={running}
      style={{ ...button, marginTop: 8 }} onClick={() => { void window.wmt.retryAccountingRevision().then(setStatus).catch(failed); }}>
      {t('accountingRevision.recheck')}
    </button>}
  </section>;
}
