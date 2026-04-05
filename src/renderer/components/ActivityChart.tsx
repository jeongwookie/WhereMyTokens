import React, { useRef, useEffect, useState } from 'react';
import { HourlyBucket, WeeklyTotal } from '../types';
import { C, fmtTokens } from '../theme';

type ChartTab = '7d' | '90d' | 'Hourly' | 'Weekly';

function blueIntensity(i: number): string {
  const sat = Math.round(55 + i * 35);
  const lgt = Math.round(80 - i * 38);
  return `hsl(213, ${sat}%, ${lgt}%)`;
}

// --- 7-day heatmap (7 rows × 24 cols) ---
function Heatmap7({ data }: { data: HourlyBucket[] }) {
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
    canvas.height = TOP + DAYS * ch + 2;

    ctx.clearRect(0, 0, W, canvas.height);

    ctx.fillStyle = '#dbeafe44';
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
  }, [data]);

  return <canvas ref={canvasRef} width={330} style={{ width: '100%', display: 'block' }} />;
}

// --- 30-day heatmap: simple 30 cells (date order, oldest → today) ---
function Heatmap30({ data }: { data: HourlyBucket[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; date: string; tokens: number } | null>(null);

  const now = new Date();
  const DAYS = 30;

  // aggregate tokens per dayIndex
  const dayTotals = new Map<number, { tokens: number; date: Date }>();
  for (const b of data) {
    const existing = dayTotals.get(b.dayIndex);
    if (existing) {
      existing.tokens += b.tokens;
    } else {
      const d = new Date(now);
      d.setDate(d.getDate() - (DAYS - 1 - b.dayIndex));
      d.setHours(0, 0, 0, 0);
      dayTotals.set(b.dayIndex, { tokens: b.tokens, date: d });
    }
  }
  const maxTokens = Math.max(...Array.from(dayTotals.values()).map(v => v.tokens), 1);

  // layout: 5 rows × 6 cols = 30 cells
  const COLS = 6;
  const ROWS = 5;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const PAD = 2;
    const cw = Math.floor((W - PAD * (COLS + 1)) / COLS);
    const ch = cw;
    canvas.height = PAD + ROWS * (ch + PAD);

    ctx.clearRect(0, 0, W, canvas.height);

    for (let i = 0; i < DAYS; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = PAD + col * (cw + PAD);
      const y = PAD + row * (ch + PAD);

      const cell = dayTotals.get(i);
      const tokens = cell?.tokens ?? 0;

      if (tokens === 0) {
        ctx.fillStyle = '#dbeafe44';
      } else {
        ctx.fillStyle = blueIntensity(tokens / maxTokens);
      }
      ctx.fillRect(x, y, cw, ch);

      // today border
      if (i === DAYS - 1) {
        ctx.strokeStyle = blueIntensity(0.8);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.75, y + 0.75, cw - 1.5, ch - 1.5);
      }
    }
  }, [data]);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);

    const PAD = 2;
    const cw = Math.floor((canvas.width - PAD * (COLS + 1)) / COLS);
    const ch = cw;

    const col = Math.floor((mx - PAD) / (cw + PAD));
    const row = Math.floor((my - PAD) / (ch + PAD));
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) { setTooltip(null); return; }

    const i = row * COLS + col;
    if (i >= DAYS) { setTooltip(null); return; }

    const cell = dayTotals.get(i);
    const date = cell?.date ?? (() => {
      const d = new Date(now);
      d.setDate(d.getDate() - (DAYS - 1 - i));
      return d;
    })();

    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
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

// --- 90-day heatmap: same cell size as 7d (24 cols × 4 rows) ---
function Heatmap90({ data }: { data: HourlyBucket[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; date: string; tokens: number } | null>(null);

  const now = new Date();
  const DAYS = 90;
  // Same layout constants as 7d heatmap
  const LEFT = 18;
  const TOP = 14;
  const COLS = 24; // same as 7d — identical cell width
  const ROWS = 7;  // same as 7d — identical overall height (168 slots, first 90 filled)

  const dayTotals = new Map<number, { tokens: number; date: Date }>();
  for (const b of data) {
    const existing = dayTotals.get(b.dayIndex);
    if (existing) {
      existing.tokens += b.tokens;
    } else {
      const d = new Date(now);
      d.setDate(d.getDate() - (DAYS - 1 - b.dayIndex));
      d.setHours(0, 0, 0, 0);
      dayTotals.set(b.dayIndex, { tokens: b.tokens, date: d });
    }
  }
  const maxTokens = Math.max(...Array.from(dayTotals.values()).map(v => v.tokens), 1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const cw = Math.floor((W - LEFT) / COLS); // identical formula to 7d
    const ch = cw;
    canvas.height = TOP + ROWS * ch + 2;

    ctx.clearRect(0, 0, W, canvas.height);

    // Empty background cells
    ctx.fillStyle = '#dbeafe44';
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        ctx.fillRect(LEFT + c * cw + 1, TOP + r * ch + 1, cw - 2, ch - 2);

    for (let i = 0; i < DAYS; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cell = dayTotals.get(i);
      const tokens = cell?.tokens ?? 0;
      if (tokens === 0) continue;
      ctx.fillStyle = blueIntensity(tokens / maxTokens);
      ctx.fillRect(LEFT + col * cw + 1, TOP + row * ch + 1, cw - 2, ch - 2);
    }

    // Today border
    const todayCol = (DAYS - 1) % COLS;
    const todayRow = Math.floor((DAYS - 1) / COLS);
    ctx.strokeStyle = blueIntensity(0.8);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(LEFT + todayCol * cw + 1.75, TOP + todayRow * ch + 1.75, cw - 3.5, ch - 3.5);

    // Row labels — only label rows that contain actual data (rows 0-3 for 90 days)
    ctx.font = '7px sans-serif';
    ctx.fillStyle = C.textMuted;
    ctx.textAlign = 'right';
    const dataRows = Math.ceil(DAYS / COLS); // 4 rows with data
    for (let r = 0; r < dataRows; r++) {
      const daysFromStart = r * COLS;
      const weeksAgo = Math.round((DAYS - daysFromStart) / 7);
      ctx.fillText(weeksAgo > 0 ? `-${weeksAgo}w` : 'now', LEFT - 3, TOP + r * ch + ch / 2 + 3);
    }
  }, [data]);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);

    const cw = Math.floor((canvas.width - LEFT) / COLS);
    const col = Math.floor((mx - LEFT) / cw);
    const row = Math.floor((my - TOP) / cw);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) { setTooltip(null); return; }

    const i = row * COLS + col;
    if (i >= DAYS) { setTooltip(null); return; }

    const cell = dayTotals.get(i);
    const date = cell?.date ?? (() => {
      const d = new Date(now);
      d.setDate(d.getDate() - (DAYS - 1 - i));
      return d;
    })();

    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
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
    const BAR_COLOR = 'hsl(213, 65%, 52%)';
    const BAR_EMPTY = '#dbeafe22';

    for (let h = 0; h < 24; h++) {
      const pct = hourlyTotals[h] / maxTokens;
      const barH = Math.max(hourlyTotals[h] > 0 ? 3 : 0, Math.round((BOTTOM - TOP) * pct));
      const x = h * slotW + (slotW - barW) / 2;
      const y = BOTTOM - barH;
      const r = Math.min(3, barW / 2);

      if (hourlyTotals[h] === 0) {
        ctx.fillStyle = BAR_EMPTY;
        ctx.fillRect(x, BOTTOM - 2, barW, 2);
        continue;
      }

      ctx.fillStyle = BAR_COLOR;
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
  }, [data]);

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
  const BAR_COLOR = 'hsl(213, 65%, 52%)';
  const n = recent.length;

  function rowLabel(i: number): string {
    const ago = n - 1 - i;
    return ago === 0 ? 'current' : `week+${ago}`;
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
              <div style={{ position: 'absolute', inset: 0, background: '#0000000a', borderRadius: 3 }} />
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${Math.max(pct * 100, entry.tokens > 0 ? 2 : 0)}%`,
                background: BAR_COLOR, borderRadius: 3,
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

// color legend
function ColorLegend() {
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
  currency: string;
  usdToKrw: number;
}

export default function ActivityChart({ heatmap, heatmap30, heatmap90, weeklyTimeline }: Props) {
  const [tab, setTab] = useState<ChartTab>('7d');
  const [collapsed, setCollapsed] = useState(false);

  const tabs: ChartTab[] = ['7d', '90d', 'Hourly', 'Weekly'];

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, padding: '8px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: collapsed ? 0 : 6 }}>
        <span style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Activity</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {!collapsed && (
            <div style={{ display: 'flex', gap: 2 }}>
              {tabs.map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: '2px 7px', fontSize: 10, border: 'none', borderRadius: 10, cursor: 'pointer',
                  background: tab === t ? C.accent : '#0000000a',
                  color: tab === t ? '#fff' : C.textDim,
                  fontWeight: tab === t ? 700 : 400,
                }}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <button onClick={() => setCollapsed(c => !c)} style={{
            background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer',
            fontSize: 11, padding: '0 2px', lineHeight: 1,
          }}>
            {collapsed ? '∨' : '∧'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {tab === '7d' && (
            <>
              <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 3 }}>7-day heatmap (day × hour)</div>
              <Heatmap7 data={heatmap} />
              <ColorLegend />
            </>
          )}
          {tab === '90d' && (
            <>
              <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 3 }}>90-day activity (oldest → today, 10×9 grid)</div>
              <Heatmap90 data={heatmap90} />
              <ColorLegend />
            </>
          )}
          {tab === 'Hourly' && (
            <>
              <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 3 }}>Hourly token usage (last 30 days)</div>
              <HourlyDistribution data={heatmap30} />
            </>
          )}
          {tab === 'Weekly' && (
            <>
              <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 3 }}>Weekly growth (last 4 weeks, Mon–Sun)</div>
              <WeeklyGrowthChart data={weeklyTimeline} />
            </>
          )}
        </>
      )}
    </div>
  );
}
