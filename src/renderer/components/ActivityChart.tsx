import React, { useRef, useEffect, useState } from 'react';
import { HourlyBucket, WeeklyTotal, TimeOfDayBucket } from '../types';
import { useTheme } from '../ThemeContext';
import { fmtTokens, fmtCost } from '../theme';

type ChartTab = '7d' | '5mo' | 'Hourly' | 'Weekly' | 'Rhythm';

const TAB_LABELS: Record<ChartTab, string> = {
  '7d': '7d', '5mo': '5mo', 'Hourly': 'Hourly', 'Weekly': 'Weekly', 'Rhythm': 'Rhythm',
};

function blueIntensity(i: number): string {
  const sat = Math.round(55 + i * 30);
  const lgt = Math.round(88 - i * 45);
  return `hsl(244, ${sat}%, ${lgt}%)`;
}

// --- 7-day heatmap (7 rows × 24 cols) ---
function Heatmap7({ data }: { data: HourlyBucket[] }) {
  const C = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const HOURS = 24, DAYS = 7;
    const LEFT = 18, TOP = 14;
    const cw = Math.floor((W - LEFT) / HOURS);
    const ch = cw;
    canvas.height = TOP + DAYS * ch + 18;

    ctx.clearRect(0, 0, W, canvas.height);

    ctx.fillStyle = C.accentDim;
    for (let d = 0; d < DAYS; d++)
      for (let h = 0; h < HOURS; h++)
        ctx.fillRect(LEFT + h * cw + 1, TOP + d * ch + 1, cw - 2, ch - 2);

    const max = Math.max(...data.map(d => d.tokens), 1);
    for (const b of data) {
      if (b.tokens === 0) continue;
      ctx.fillStyle = blueIntensity(b.tokens / max);
      ctx.fillRect(LEFT + b.hour * cw + 1, TOP + b.dayIndex * ch + 1, cw - 2, ch - 2);
    }

    ctx.font = '7px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'center';
    for (let h = 0; h <= 18; h += 6)
      ctx.fillText(`${h}`, LEFT + h * cw + cw / 2, TOP - 3);

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const now = new Date();
    ctx.textAlign = 'right';
    for (let d = 0; d < DAYS; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - (6 - d));
      ctx.fillText(dayNames[date.getDay()], LEFT - 3, TOP + d * ch + ch / 2 + 3);
    }

    // 하단 시간 축 라벨
    ctx.textAlign = 'center';
    ctx.fillStyle = C.textMuted;
    for (const h of [0, 6, 12, 18, 23])
      ctx.fillText(`${h}h`, LEFT + h * cw + cw / 2, TOP + DAYS * ch + 12);
  }, [data, C]);

  return <canvas ref={canvasRef} width={330} style={{ width: '100%', display: 'block' }} />;
}

// --- 90-day heatmap: GitHub-style calendar grid (weeks × weekdays) ---
function Heatmap90({ data }: { data: HourlyBucket[] }) {
  const C = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; date: string; tokens: number } | null>(null);

  const DAYS = 150;
  const ROWS = 7;   // days of week (0=Sun ... 6=Sat)
  const LEFT = 24;  // space for day labels (Sun/Mon/... all shown)
  const TOP = 14;   // space for month labels (same as 7d)

  // Build date→tokens map (absolute dates)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dateMap = new Map<string, { tokens: number; dayIndex: number }>();
  for (const b of data) {
    const d = new Date(today);
    d.setDate(today.getDate() - (DAYS - 1 - b.dayIndex));
    const key = d.toISOString().slice(0, 10);
    const existing = dateMap.get(key);
    if (existing) existing.tokens += b.tokens;
    else dateMap.set(key, { tokens: b.tokens, dayIndex: b.dayIndex });
  }
  const maxTokens = Math.max(...Array.from(dateMap.values()).map(v => v.tokens), 1);

  // Compute grid dimensions
  const startDate = new Date(today); startDate.setDate(today.getDate() - (DAYS - 1));
  // first Sunday on or before startDate
  const gridStart = new Date(startDate);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const daySpan = Math.floor((today.getTime() - gridStart.getTime()) / 86400000) + 1;
  const COLS = Math.ceil(daySpan / 7);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const cw = Math.floor((W - 18) / 24);
    const ch = cw;
    canvas.height = TOP + ROWS * ch + 2;
    ctx.clearRect(0, 0, W, canvas.height);

    let lastMonth = -1;

    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const cellDate = new Date(gridStart);
        cellDate.setDate(gridStart.getDate() + col * 7 + row);
        const daysFromToday = Math.round((today.getTime() - cellDate.getTime()) / 86400000);
        const inRange = daysFromToday >= 0 && daysFromToday < DAYS;

        const x = LEFT + col * cw + 1;
        const y = TOP + row * ch + 1;

        if (!inRange) continue;

        const key = cellDate.toISOString().slice(0, 10);
        const cell = dateMap.get(key);
        const tokens = cell?.tokens ?? 0;

        ctx.fillStyle = tokens > 0 ? blueIntensity(tokens / maxTokens) : C.accentDim;
        ctx.fillRect(x, y, cw - 2, ch - 2);

        // Today border
        if (daysFromToday === 0) {
          ctx.strokeStyle = blueIntensity(0.8);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.75, y + 0.75, cw - 3.5, ch - 3.5);
        }

        // Month label at top of column when month changes (only on row 0)
        if (row === 0) {
          const m = cellDate.getMonth();
          if (m !== lastMonth) {
            lastMonth = m;
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            ctx.font = '7px sans-serif';
            ctx.fillStyle = C.textMuted;
            ctx.textAlign = 'left';
            ctx.fillText(months[m], LEFT + col * cw, TOP - 4);
          }
        }
      }
    }

    // Day-of-week labels — all 7 days
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    ctx.font = '7px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'right';
    for (let row = 0; row < ROWS; row++) {
      ctx.fillText(dayNames[row], LEFT - 3, TOP + row * ch + ch / 2 + 3);
    }
  }, [data, COLS, C]);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);

    const cw = Math.floor((canvas.width - 18) / 24);
    const col = Math.floor((mx - LEFT) / cw);
    const row = Math.floor((my - TOP) / cw);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) { setTooltip(null); return; }

    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + col * 7 + row);
    const daysFromToday = Math.round((today.getTime() - cellDate.getTime()) / 86400000);
    if (daysFromToday < 0 || daysFromToday >= DAYS) { setTooltip(null); return; }

    const key = cellDate.toISOString().slice(0, 10);
    const cell = dateMap.get(key);

    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      date: cellDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      tokens: cell?.tokens ?? 0,
    });
  }

  return (
    <div style={{ position: 'relative' }}>
      <canvas ref={canvasRef} width={330}
        style={{ width: '100%', display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove} onMouseLeave={() => setTooltip(null)} />
      {tooltip && (
        <div style={{
          position: 'absolute', left: Math.min(tooltip.x + 4, 220), top: Math.max(tooltip.y - 32, 0),
          background: C.bgCard, border: `1px solid ${C.border}`,
          borderRadius: 4, padding: '3px 7px', fontSize: 10, pointerEvents: 'none', zIndex: 10,
        }}>
          <span style={{ color: C.textMuted }}>{tooltip.date} </span>
          <span style={{ color: tooltip.tokens > 0 ? C.text : C.textMuted, fontWeight: 600 }}>
            {tooltip.tokens > 0 ? fmtTokens(tooltip.tokens) + ' tok' : 'none'}
          </span>
        </div>
      )}
    </div>
  );
}

// --- Hourly distribution bar chart ---
function HourlyDistribution({ data }: { data: HourlyBucket[] }) {
  const C = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; hour: number; tokens: number } | null>(null);

  const hourlyTotals = Array(24).fill(0) as number[];
  for (const b of data) hourlyTotals[b.hour] += b.tokens;
  const maxTokens = Math.max(...hourlyTotals, 1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = 110;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const BOTTOM = H - 18;
    const TOP = 8;
    const slotW = W / 24;
    const barW = Math.max(3, slotW - 3);

    for (let h = 0; h < 24; h++) {
      const pct = hourlyTotals[h] / maxTokens;
      const barH = Math.max(hourlyTotals[h] > 0 ? 3 : 0, Math.round((BOTTOM - TOP) * pct));
      const x = h * slotW + (slotW - barW) / 2;
      const y = BOTTOM - barH;
      const r = Math.min(3, barW / 2);

      if (hourlyTotals[h] === 0) {
        ctx.fillStyle = C.accentDim;
        ctx.fillRect(x, BOTTOM - 2, barW, 2);
        continue;
      }

      ctx.fillStyle = C.accent;
      ctx.beginPath();
      if (barH > r * 2) {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + barW - r, y);
        ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
        ctx.lineTo(x + barW, BOTTOM);
        ctx.lineTo(x, BOTTOM);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
      } else {
        ctx.rect(x, y, barW, barH);
      }
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = C.border;
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, BOTTOM + 1); ctx.lineTo(W, BOTTOM + 1); ctx.stroke();

    ctx.font = '7px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'center';
    for (let h = 0; h <= 21; h += 3)
      ctx.fillText(`${h}`, h * slotW + slotW / 2, H - 4);
  }, [data, C]);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const h = Math.min(23, Math.max(0, Math.floor(mx / (canvas.width / 24))));
    const slotW = rect.width / 24;
    setTooltip({ x: (h + 0.5) * slotW, hour: h, tokens: hourlyTotals[h] });
  }

  return (
    <div style={{ position: 'relative' }}>
      <canvas ref={canvasRef} width={330}
        style={{ width: '100%', display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove} onMouseLeave={() => setTooltip(null)} />
      {tooltip && tooltip.tokens > 0 && (
        <div style={{
          position: 'absolute', top: 6, left: Math.min(tooltip.x, 220),
          background: C.bgCard, border: `1px solid ${C.border}`,
          borderRadius: 4, padding: '3px 7px', fontSize: 10, pointerEvents: 'none', zIndex: 10,
        }}>
          <span style={{ color: C.textMuted }}>{tooltip.hour}h </span>
          <span style={{ color: C.text, fontWeight: 600 }}>{fmtTokens(tooltip.tokens)} tok</span>
        </div>
      )}
    </div>
  );
}

// --- Weekly growth chart (last 4 weeks) ---
function WeeklyGrowthChart({ data }: { data: WeeklyTotal[] }) {
  const C = useTheme();
  const recent = data.slice(-4);

  if (recent.length === 0) {
    return (
      <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: C.textMuted }}>
        No data
      </div>
    );
  }

  const maxTokens = Math.max(...recent.map(d => d.tokens), 1);
  const totalTokens = recent.reduce((sum, d) => sum + d.tokens, 0);
  const peakEntry = recent.reduce((a, b) => a.tokens >= b.tokens ? a : b);
  const n = recent.length;

  function rowLabel(i: number): string {
    const ago = n - 1 - i;
    return ago === 0 ? 'current' : `${ago}w ago`;
  }

  function weekRange(i: number): string {
    const weeksAgo = n - 1 - i;
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const mon = new Date(now);
    mon.setDate(now.getDate() + daysToMon - weeksAgo * 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    return `${fmt(mon)}~${fmt(sun)}`;
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {recent.map((entry, i) => {
        const pct = entry.tokens / maxTokens;
        const isCurrent = i === n - 1;
        const isPeak = entry.tokens === peakEntry.tokens && entry.tokens > 0;
        const label = rowLabel(i);

        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
            <div style={{
              width: 52, fontSize: 9, fontWeight: isCurrent ? 700 : 400,
              color: isCurrent ? C.accent : C.textMuted, textAlign: 'right', flexShrink: 0,
              letterSpacing: -0.2,
            }}>
              {label}
              <div style={{ fontSize: 8, color: C.textMuted, fontWeight: 400 }}>{weekRange(i)}</div>
            </div>

            <div style={{ flex: 1, position: 'relative', height: 14 }}>
              <div style={{ position: 'absolute', inset: 0, background: C.accentDim, borderRadius: 3 }} />
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${Math.max(pct * 100, entry.tokens > 0 ? 2 : 0)}%`,
                background: C.accent, borderRadius: 3,
                opacity: isCurrent ? 1 : isPeak ? 0.85 : 0.6,
              }} />
            </div>

            <div style={{
              width: 62, fontSize: 10, fontWeight: isCurrent ? 700 : 400,
              color: isCurrent ? C.text : C.textDim, textAlign: 'right', flexShrink: 0,
            }}>
              {fmtTokens(entry.tokens)}
            </div>
          </div>
        );
      })}

      <div style={{
        marginTop: 4, paddingTop: 5, borderTop: `1px solid ${C.border}`,
        display: 'flex', justifyContent: 'space-between',
        fontSize: 9, color: C.textMuted,
      }}>
        <span>
          <span style={{ color: C.textDim }}>4-week total </span>
          <span style={{ color: C.text, fontWeight: 600 }}>{fmtTokens(totalTokens)}</span>
        </span>
        <span>
          <span style={{ color: C.textDim }}>peak </span>
          <span style={{ color: C.accent, fontWeight: 600 }}>
            {rowLabel(recent.indexOf(peakEntry))} ({fmtTokens(peakEntry.tokens)})
          </span>
        </span>
      </div>
    </div>
  );
}

// --- TOD (Time-of-Day) Rhythm Panel — 리디자인: 아이콘+풀네임+그라데이션 ---
const TOD_ORDER: TimeOfDayBucket['period'][] = ['morning', 'afternoon', 'evening', 'night'];

const TOD_INFO: Record<string, { icon: string; name: string; time: string; gradient: string; color: string }> = {
  morning:   { icon: '☀️', name: 'Morning',   time: '6–12h',  gradient: 'linear-gradient(90deg, #fbbf24, #f59e0b)', color: '#fbbf24' },
  afternoon: { icon: '🔥', name: 'Afternoon', time: '12–18h', gradient: 'linear-gradient(90deg, #fb923c, #f87171)', color: '#fb923c' },
  evening:   { icon: '🌆', name: 'Evening',   time: '18–24h', gradient: 'linear-gradient(90deg, #a78bfa, #f472b6)', color: '#a78bfa' },
  night:     { icon: '🌙', name: 'Night',     time: '0–6h',   gradient: 'linear-gradient(90deg, #60a5fa, #818cf8)', color: '#60a5fa' },
};

export function TODPanel({ data, currency, usdToKrw }: { data: TimeOfDayBucket[]; currency: string; usdToKrw: number }) {
  const C = useTheme();

  if (data.every(b => b.tokens === 0)) {
    return (
      <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: C.textMuted }}>
        No data
      </div>
    );
  }

  const sorted = TOD_ORDER.map(p => data.find(b => b.period === p)!).filter(Boolean);
  const maxTokens = Math.max(...sorted.map(b => b.tokens), 1);
  const totalTokens = sorted.reduce((s, b) => s + b.tokens, 0);
  const totalCost = sorted.reduce((s, b) => s + b.costUSD, 0);
  const peakPeriod = sorted.reduce((a, b) => a.tokens >= b.tokens ? a : b);

  return (
    <div style={{ padding: '4px 0' }}>
      {sorted.map(bucket => {
        const pct = bucket.tokens / maxTokens;
        const isPeak = bucket.period === peakPeriod.period && bucket.tokens > 0;
        const info = TOD_INFO[bucket.period];

        return (
          <div key={bucket.period} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, width: 18, textAlign: 'center' }}>{info.icon}</span>
            <span style={{
              fontSize: 10, width: 52, flexShrink: 0, fontFamily: C.fontMono,
              color: isPeak ? info.color : C.textDim,
              fontWeight: isPeak ? 600 : 400,
            }}>{info.name}</span>
            <span style={{ fontSize: 8, width: 34, flexShrink: 0, color: C.textMuted, fontFamily: C.fontMono }}>{info.time}</span>
            <div style={{ flex: 1, height: 8, background: '#252a38', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                width: `${Math.max(pct * 100, bucket.tokens > 0 ? 3 : 0)}%`,
                height: '100%', borderRadius: 4,
                background: info.gradient,
              }} />
            </div>
            <span style={{
              width: 70, fontSize: 9, textAlign: 'right', flexShrink: 0,
              fontFamily: C.fontMono,
              color: isPeak ? info.color : C.textDim,
              fontWeight: isPeak ? 600 : 400,
            }}>
              {fmtTokens(bucket.tokens)} · {fmtCost(bucket.costUSD, currency, usdToKrw)}
            </span>
          </div>
        );
      })}

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 10, color: C.textDim, fontFamily: C.fontMono }}>
          🔥 Peak: <strong style={{ color: TOD_INFO[peakPeriod.period]?.color ?? C.accent }}>
            {TOD_INFO[peakPeriod.period]?.name ?? peakPeriod.label} ({TOD_INFO[peakPeriod.period]?.time})
          </strong>
          <span style={{ color: C.textMuted, fontWeight: 400 }}> · {fmtTokens(totalTokens)} total · {fmtCost(totalCost, currency, usdToKrw)}</span>
        </div>
        <div style={{ fontSize: 8, color: C.textMuted, marginTop: 2, fontFamily: C.fontMono }}>
          Last 30 days · local timezone
        </div>
      </div>
    </div>
  );
}

// 색상 범례
function ColorLegend() {
  const C = useTheme();
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, marginTop: 3 }}>
      <span style={{ fontSize: 9, color: C.textMuted }}>less</span>
      {[0, 0.25, 0.5, 0.75, 1].map(i => (
        <div key={i} style={{ width: 7, height: 7, borderRadius: 1, background: blueIntensity(i) }} />
      ))}
      <span style={{ fontSize: 9, color: C.textMuted }}>more</span>
    </div>
  );
}

interface Props {
  heatmap: HourlyBucket[];
  heatmap30: HourlyBucket[];
  heatmap90: HourlyBucket[];
  weeklyTimeline: WeeklyTotal[];
  todBuckets: TimeOfDayBucket[];
  currency: string;
  usdToKrw: number;
}

export default function ActivityChart({ heatmap, heatmap30, heatmap90, weeklyTimeline, todBuckets, currency, usdToKrw }: Props) {
  const C = useTheme();
  const [tab, setTab] = useState<ChartTab>('7d');

  const tabs: ChartTab[] = ['7d', '5mo', 'Hourly', 'Weekly', 'Rhythm'];

  return (
    <div>
      {/* 헤더: 제목 + 탭 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px 5px 12px', background: C.bgRow, borderBottom: `1px solid ${C.border}` }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.8 }}>Activity</span>
          <span style={{ fontSize: 8, color: C.textMuted, fontFamily: C.fontMono, background: C.accentDim, padding: '1px 5px', borderRadius: 3 }}>
            {Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').pop()?.replace(/_/g, ' ') ?? 'Local'}
          </span>
        </span>
        <div style={{ display: 'flex', gap: 2 }}>
          {tabs.map(t => {
            const isRhythm = t === 'Rhythm';
            const isActive = tab === t;
            return (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '4px 8px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                border: isActive && isRhythm ? '1px solid rgba(251,191,36,0.2)' :
                        isActive ? `1px solid rgba(167,139,250,0.15)` : '1px solid transparent',
                background: isActive && isRhythm ? 'rgba(251,191,36,0.1)' :
                            isActive ? C.accent + '22' : 'none',
                color: isActive && isRhythm ? '#fbbf24' :
                       isActive ? C.accent :
                       isRhythm ? '#fb923c' : C.textMuted,
                fontWeight: isActive ? 700 : 400,
              }}>
                {TAB_LABELS[t]}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: '8px 14px', minHeight: 175 }}>
        {tab === '7d' && (
          <>
            <Heatmap7 data={heatmap} />
            <ColorLegend />
          </>
        )}
        {tab === '5mo' && (
          <>
            <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 3 }}>5mo activity</div>
            <Heatmap90 data={heatmap90} />
            <ColorLegend />
          </>
        )}
        {tab === 'Hourly' && (
          <>
            <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 3 }}>Hourly (30d)</div>
            <HourlyDistribution data={heatmap30} />
          </>
        )}
        {tab === 'Weekly' && (
          <>
            <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 3 }}>Weekly (4w)</div>
            <WeeklyGrowthChart data={weeklyTimeline} />
          </>
        )}
        {tab === 'Rhythm' && (
          <TODPanel data={todBuckets} currency={currency} usdToKrw={usdToKrw} />
        )}
      </div>
    </div>
  );
}
