import React, { useState } from 'react';
import { C } from '../theme';
import ViewHeader from '../components/ViewHeader';

interface Props { onBack: () => void }

type Lang = 'en' | 'ko';

function SectionBlock({ title, icon, content }: { title: string; icon: string; content: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${C.border}` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', background: 'none', border: 'none', padding: '10px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', color: C.text }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>{icon} {title}</span>
        <span style={{ fontSize: 11, color: C.textMuted }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ paddingBottom: 12, fontSize: 11, color: C.textDim, lineHeight: 1.7 }}>
          {content}
        </div>
      )}
    </div>
  );
}

function Kw({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span style={{ color: C.text, fontWeight: 600, ...style }}>{children}</span>;
}

export default function HelpView({ onBack }: Props) {
  const [lang, setLang] = useState<Lang>('en');

  const en = lang === 'en';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title="Help" onBack={onBack} />

      {/* language toggle */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 16px 0', gap: 4, flexShrink: 0 }}>
        {(['en', 'ko'] as Lang[]).map(l => (
          <button key={l} onClick={() => setLang(l)} style={{
            padding: '2px 8px', fontSize: 10, border: 'none', borderRadius: 10, cursor: 'pointer',
            background: lang === l ? C.accent : '#0000000a',
            color: lang === l ? '#fff' : C.textDim,
            fontWeight: lang === l ? 700 : 400,
          }}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px' }}>

        <SectionBlock icon="📊" title={en ? 'Usage Limits (5h / 1w / Sonnet)' : 'Usage Limits (5h / 1w / So)'} content={en ? (
          <>
            <div>Claude Code has three independent usage limits.</div>
            <div style={{ marginTop: 8 }}>
              <Kw>5h (5-hour limit)</Kw> — Rolling 5-hour window. Measures API requests in the last 5 hours. Auto-resets after ~5 hours.
            </div>
            <div style={{ marginTop: 6 }}>
              <Kw>1w (weekly limit)</Kw> — Resets every Monday. Measures total requests for the current week.
            </div>
            <div style={{ marginTop: 6 }}>
              <Kw>Sonnet limit</Kw> — Weekly token limit applied to Sonnet models only. Resets independently around Tuesday. Same as the "Sonnet only" bar on claude.ai.
            </div>
            <div style={{ marginTop: 8, color: C.textMuted }}>Data is fetched from the Anthropic API every ~30s. Hit ↺ to refresh immediately.</div>
          </>
        ) : (
          <>
            <div>Claude Code has three independent usage limits.</div>
            <div style={{ marginTop: 8 }}>
              <Kw>5h (5-hour limit)</Kw> — Rolling 5-hour window. Auto-resets after ~5 hours.
            </div>
            <div style={{ marginTop: 6 }}>
              <Kw>1w (weekly limit)</Kw> — Resets every Monday afternoon.
            </div>
            <div style={{ marginTop: 6 }}>
              <Kw>Sonnet limit</Kw> — Weekly token limit for Sonnet models only. Resets independently around Tuesday. Same as the "Sonnet only" bar on claude.ai.
            </div>
            <div style={{ marginTop: 8, color: C.textMuted }}>Values are fetched from the Anthropic API. Hit ↺ to refresh immediately.</div>
          </>
        )} />

        <SectionBlock icon="📦" title={en ? 'Token Cards (5h / 1w)' : 'Token Cards (5h / 1w)'} content={en ? (
          <>
            <div>Shows actual token usage for each window (5h and weekly).</div>
            <div style={{ marginTop: 8 }}>
              <Kw style={{ color: C.input }}>In</Kw> — Tokens you sent to Claude (input).
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw style={{ color: C.output }}>Out</Kw> — Tokens Claude generated in response.
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw style={{ color: C.cacheW }}>C.Wr (cache write)</Kw> — Tokens written to cache on first request.
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw style={{ color: C.cacheR }}>C.Rd (cache read)</Kw> — Tokens read from cache (cheaper). High ratio = cost savings.
            </div>
          </>
        ) : (
          <>
            <div>Actual token usage for each window (5h / 1w).</div>
            <div style={{ marginTop: 8 }}>
              <Kw style={{ color: C.input }}>In</Kw> — Tokens you sent to Claude (input).
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw style={{ color: C.output }}>Out</Kw> — Tokens Claude generated in response.
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw style={{ color: C.cacheW }}>C.Wr (cache write)</Kw> — Tokens written to cache when storing context.
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw style={{ color: C.cacheR }}>C.Rd (cache read)</Kw> — Tokens read from stored cache. Higher ratio = more cost savings.
            </div>
          </>
        )} />

        <SectionBlock icon="💰" title={en ? 'Cost Display (API equivalent)' : 'Cost Display (API equivalent)'} content={en ? (
          <>
            <div>The cost shown is <Kw>not your actual bill.</Kw></div>
            <div style={{ marginTop: 8 }}>
              Max / Pro subscriptions are flat monthly fees. The cost in WhereMyTokens is the <Kw>equivalent API price</Kw> if you had purchased the same usage directly via the API.
            </div>
            <div style={{ marginTop: 6 }}>e.g. "$1,299 / week" means your weekly usage would cost $1,299 at API rates — but you only pay your subscription fee.</div>
            <div style={{ marginTop: 6, color: C.textMuted }}>Useful for understanding usage value and comparing model cost efficiency.</div>
          </>
        ) : (
          <>
            <div>The cost shown is <Kw>not your actual bill.</Kw></div>
            <div style={{ marginTop: 8 }}>
              Max / Pro subscriptions are flat monthly fees. The cost in WhereMyTokens is the <Kw>equivalent API price</Kw> for the same usage purchased directly via the API.
            </div>
            <div style={{ marginTop: 6, color: C.textMuted }}>Useful for understanding usage value and comparing model cost efficiency.</div>
          </>
        )} />

        <SectionBlock icon="🟩" title={en ? 'Activity Charts' : 'Activity Charts'} content={en ? (
          <>
            <div>Four views for visualizing your usage patterns:</div>
            <div style={{ marginTop: 8 }}>
              <Kw>7d</Kw> — Heatmap of the last 7 days, by day × hour. Darker = more tokens.
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw>30d</Kw> — 30 daily cells, oldest to today. Hover for date + token count.
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw>Hourly</Kw> — Bar chart of token usage by hour of day (last 30 days aggregated).
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw>Weekly</Kw> — Last 4 weeks compared. "current" is this week.
            </div>
          </>
        ) : (
          <>
            <div>Four views for visualizing your usage patterns:</div>
            <div style={{ marginTop: 8 }}>
              <Kw>7d</Kw> — Last 7 days × 24-hour heatmap. Darker = more tokens.
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw>30d</Kw> — 30 daily cells (oldest → today). Hover for date + token count.
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw>Hourly</Kw> — Bar chart of token usage by hour (last 30 days).
            </div>
            <div style={{ marginTop: 4 }}>
              <Kw>Weekly</Kw> — Last 4 weeks compared. "current" is this week.
            </div>
          </>
        )} />

        <SectionBlock icon="🤖" title={en ? 'Model Breakdown' : 'Model Breakdown'} content={en ? (
          <>
            <div>All-time cumulative usage per model (Opus / Sonnet / Haiku / etc.).</div>
            <div style={{ marginTop: 8 }}>
              Token count = input + output only (cache excluded). Cost includes cache.
            </div>
            <div style={{ marginTop: 6 }}>
              <Kw>Opus</Kw> is the most expensive, <Kw>Sonnet</Kw> balances speed and cost, <Kw>Haiku</Kw> is cheapest. Claude Code defaults to Sonnet and uses Opus for complex tasks.
            </div>
          </>
        ) : (
          <>
            <div>All-time cumulative usage per model (Opus / Sonnet / Haiku / etc.).</div>
            <div style={{ marginTop: 8 }}>
              Token count = input + output only (cache excluded). Cost includes cache.
            </div>
          </>
        )} />

        <SectionBlock icon="📐" title={en ? 'Context Window' : 'Context Window'} content={en ? (
          <>
            <div>Shows the <Kw>context window usage</Kw> of the currently active session.</div>
            <div style={{ marginTop: 8 }}>
              Claude's context window is 200K tokens. As conversation grows, usage increases. When full, Claude Code auto-compacts (summarizes older context).
            </div>
            <div style={{ marginTop: 6, color: C.textMuted }}>During compaction the session state shows "compacting".</div>
          </>
        ) : (
          <>
            <div>Shows the <Kw>context window usage</Kw> of the currently active session.</div>
            <div style={{ marginTop: 8 }}>
              Claude's context window is 200K tokens. When full, Claude Code auto-compacts.
            </div>
            <div style={{ marginTop: 6, color: C.textMuted }}>During compaction the session state shows "compacting".</div>
          </>
        )} />

        <SectionBlock icon="🔔" title={en ? 'Alert System' : 'Alert System'} content={en ? (
          <>
            <div>Windows notifications when usage reaches configured thresholds (50% / 80% / 90%).</div>
            <div style={{ marginTop: 8 }}>
              <Kw>Cooldown</Kw> — No duplicate alerts for the same target within 1 hour.<br />
              <Kw>Re-arm after reset</Kw> — Alerts re-enable once the limit resets.<br />
              <Kw>Condition</Kw> — Only fires when usage is actually rising.
            </div>
          </>
        ) : (
          <>
            <div>Windows notifications when usage reaches configured thresholds (50% / 80% / 90%).</div>
            <div style={{ marginTop: 8 }}>
              <Kw>Cooldown</Kw> — No duplicate alerts for the same target within 1 hour.<br />
              <Kw>Re-arm after reset</Kw> — Alerts re-enable once the limit resets.
            </div>
          </>
        )} />

        <SectionBlock icon="👁" title={en ? 'Hiding Projects' : 'Hiding Projects'} content={en ? (
          <>
            <div>You can hide projects you don't want to see in the main view.</div>
            <div style={{ marginTop: 8 }}>
              Hover over a project name in the session list → click <Kw>✕</Kw> to hide it.
            </div>
            <div style={{ marginTop: 6 }}>
              Hidden projects are listed at the bottom of the session area. Click to expand and restore them.
            </div>
            <div style={{ marginTop: 6, color: C.textMuted }}>Usage data from hidden projects is still counted in the totals.</div>
          </>
        ) : (
          <>
            <div>You can hide projects you don't want to see in the main view.</div>
            <div style={{ marginTop: 8 }}>
              Hover over a project name in the session list → click <Kw>✕</Kw> to hide it.
            </div>
            <div style={{ marginTop: 6 }}>
              Hidden projects are listed at the bottom of the session area. Click to restore.
            </div>
            <div style={{ marginTop: 6, color: C.textMuted }}>Usage data from hidden projects is still counted in the totals.</div>
          </>
        )} />

      </div>
    </div>
  );
}
