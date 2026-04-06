const LIGHT = {
  bg:        '#f4f4f8',
  bgCard:    '#ffffff',
  bgRow:     '#ebebf2',
  bgHover:   '#e0e0ec',
  border:    '#d0d0e0',
  borderSub: '#e0e0ec',
  text:      '#1a1a30',
  textDim:   '#505070',
  textMuted: '#9090a8',
  active:    '#2a7a48',
  waiting:   '#a06010',
  idle:      '#9090a8',
  compacting:'#1a62a0',
  input:    '#2a68b8',
  output:   '#287428',
  cacheW:   '#a06010',
  cacheR:   '#5e32a0',
  opus:    '#8b3ec8',
  sonnet:  '#1878b4',
  haiku:   '#2a9040',
  gpt:     '#d4602a',
  barGreen:  '#2a7a48',
  barOrange: '#a06010',
  barRed:    '#7a2828',
  accent:   '#5048b8',
  accentDim: '#5048b822',
};

// Fixed to light mode
export const C = LIGHT;

export function pctColor(pct: number): string {
  if (pct >= 80) return C.barRed;
  if (pct >= 50) return C.barOrange;
  return C.barGreen;
}

export function modelColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus'))   return C.opus;
  if (lower.includes('sonnet')) return C.sonnet;
  if (lower.includes('haiku'))  return C.haiku;
  if (lower.includes('gpt'))    return C.gpt;
  return C.accent;
}

export function stateColor(state: string): string {
  switch (state) {
    case 'active':    return C.active;
    case 'waiting':   return C.waiting;
    case 'compacting':return C.compacting;
    default:          return C.idle;
  }
}

export function stateLabel(state: string): string {
  switch (state) {
    case 'active':    return 'active';
    case 'waiting':   return 'waiting';
    case 'compacting':return 'compacting';
    default:          return 'idle';
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function fmtCost(usd: number, currency: string, rate: number): string {
  if (currency === 'KRW') return `₩${Math.round(usd * rate).toLocaleString()}`;
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd >= 1)   return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

// 헤더용 간결 비용 표시 (긴 금액을 K/M 단위로 축약)
export function fmtCostShort(usd: number, currency: string, rate: number): string {
  if (currency === 'KRW') {
    const krw = Math.round(usd * rate);
    if (krw >= 1_000_000) return `₩${(krw / 1_000_000).toFixed(1)}M`;
    if (krw >= 10_000)    return `₩${Math.round(krw / 1_000)}K`;
    return `₩${krw.toLocaleString()}`;
  }
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  if (usd >= 100)   return `$${Math.round(usd)}`;
  if (usd >= 1)     return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

export function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtRelative(isoStr: string | null): string {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
