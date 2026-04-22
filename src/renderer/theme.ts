// ─── Theme 타입 정의 ────────────────────────────────────────────────────────

export interface Theme {
  // 헤더 (항상 다크, 라이트/다크 공통)
  headerBg:     string;
  headerText:   string;
  headerAccent: string;  // 오렌지 로고
  headerSub:    string;  // 헤더 서브텍스트
  headerBorder: string;

  // 바디 배경
  bg:       string;
  bgCard:   string;
  bgRow:    string;
  bgHover:  string;

  // 테두리
  border:    string;
  borderSub: string;

  // 텍스트
  text:      string;
  textDim:   string;
  textMuted: string;

  // 강조
  accent:    string;
  accentDim: string;

  // 상태
  active:     string;
  waiting:    string;
  idle:       string;
  compacting: string;

  // 토큰 타입 (In / Out / CW / CR)
  input:  string;
  output: string;
  cacheW: string;
  cacheR: string;

  // 모델
  opus:   string;
  sonnet: string;
  haiku:  string;
  gpt:    string;
  gpt5:   string;
  gptCodex: string;
  gpt4:   string;
  codexMini: string;

  // 진행 바
  barGreen:  string;
  barOrange: string;
  barRed:    string;
  barYellow: string;

  // 캐시 등급
  gradeExcellentBg:    string;
  gradeExcellentColor: string;
  gradeGoodBg:         string;
  gradeGoodColor:      string;
  gradeFairBg:         string;
  gradeFairColor:      string;
  gradePoorBg:         string;
  gradePoorColor:      string;

  // ETA 경고
  etaWarning: string;

  // 폰트
  fontMono: string;
  fontSans: string;
}

// ─── Light 테마 ─────────────────────────────────────────────────────────────

export const LIGHT: Theme = {
  headerBg:     '#0f172a',
  headerText:   '#ffffff',
  headerAccent: '#f5a623',
  headerSub:    '#94a3b8',
  headerBorder: '#1e293b',

  bg:       '#f4f4f8',
  bgCard:   '#ffffff',
  bgRow:    '#ebebf2',
  bgHover:  '#e0e0ec',

  border:    '#d0d0e0',
  borderSub: '#e0e0ec',

  text:      '#1a1a30',
  textDim:   '#505070',
  textMuted: '#9090a8',

  accent:    '#0f766e',
  accentDim: '#0f766e22',

  active:     '#2a7a48',
  waiting:    '#a06010',
  idle:       '#9090a8',
  compacting: '#1a62a0',

  input:  '#2a68b8',
  output: '#287428',
  cacheW: '#a06010',
  cacheR: '#0f766e',

  opus:   '#b45309',
  sonnet: '#1878b4',
  haiku:  '#2a9040',
  gpt:    '#6d28d9',
  gpt5:   '#4f46e5',
  gptCodex: '#d4602a',
  gpt4:   '#0891b2',
  codexMini: '#7c3aed',

  barGreen:  '#2a7a48',
  barOrange: '#a06010',
  barRed:    '#7a2828',
  barYellow: '#d4a017',

  gradeExcellentBg:    '#e6f7ee', gradeExcellentColor: '#1e7e44',
  gradeGoodBg:         '#e6f0ff', gradeGoodColor:      '#1a5fb4',
  gradeFairBg:         '#fff4e0', gradeFairColor:      '#9a5c00',
  gradePoorBg:         '#fde8e8', gradePoorColor:      '#8b1a1a',

  etaWarning: '#c0392b',

  fontMono: "'JetBrains Mono', monospace",
  fontSans: "'Noto Sans', 'Noto Sans KR', sans-serif",
};

// ─── Dark 테마 ──────────────────────────────────────────────────────────────

export const DARK: Theme = {
  headerBg:     '#13151a',
  headerText:   '#e8eaf0',
  headerAccent: '#fbbf24',
  headerSub:    '#8b90a0',
  headerBorder: 'rgba(255,255,255,0.06)',

  bg:       '#0d0f13',
  bgCard:   '#161920',
  bgRow:    '#1e2230',
  bgHover:  '#262a38',

  border:    'rgba(255,255,255,0.06)',
  borderSub: 'rgba(255,255,255,0.04)',

  text:      '#e8eaf0',
  textDim:   '#8b90a0',
  textMuted: '#5a5f72',

  accent:    '#0D9488',
  accentDim: '#0D948822',

  active:     '#34d399',
  waiting:    '#fbbf24',
  idle:       '#5a5f72',
  compacting: '#60a5fa',

  input:  '#60a5fa',
  output: '#34d399',
  cacheW: '#fbbf24',
  cacheR: '#2dd4bf',

  opus:   '#f59e0b',
  sonnet: '#60a5fa',
  haiku:  '#34d399',
  gpt:    '#a78bfa',
  gpt5:   '#818cf8',
  gptCodex: '#fb923c',
  gpt4:   '#38bdf8',
  codexMini: '#c084fc',

  barGreen:  '#34d399',
  barOrange: '#fbbf24',
  barRed:    '#f87171',
  barYellow: '#fbbf24',

  gradeExcellentBg:    '#132820', gradeExcellentColor: '#34d399',
  gradeGoodBg:         '#131f30', gradeGoodColor:      '#60a5fa',
  gradeFairBg:         '#2a2210', gradeFairColor:      '#fbbf24',
  gradePoorBg:         '#2a1515', gradePoorColor:      '#f87171',

  etaWarning: '#f87171',

  fontMono: "'JetBrains Mono', monospace",
  fontSans: "'Noto Sans', 'Noto Sans KR', sans-serif",
};

// ─── 테마 선택 ───────────────────────────────────────────────────────────────

export function getTheme(mode: 'light' | 'dark'): Theme {
  return mode === 'dark' ? DARK : LIGHT;
}

// ─── 유틸 함수 (Theme 인자 필요) ─────────────────────────────────────────────

export function pctColor(pct: number, C: Theme): string {
  if (pct >= 80) return C.barRed;
  if (pct >= 50) return C.barOrange;
  return C.barGreen;
}

export function modelColor(model: string, C: Theme): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus'))   return C.opus;
  if (lower.includes('sonnet')) return C.sonnet;
  if (lower.includes('haiku'))  return C.haiku;
  if (lower.includes('codex-mini')) return C.codexMini;
  if (lower.includes('gpt-5') && lower.includes('codex')) return C.gptCodex;
  if (lower.includes('gpt-5')) return C.gpt5;
  if (lower.includes('gpt-4')) return C.gpt4;
  if (lower.includes('gpt'))    return C.gpt;
  return C.accent;
}

export function stateColor(state: string, C: Theme): string {
  switch (state) {
    case 'active':     return C.active;
    case 'waiting':    return C.waiting;
    case 'compacting': return C.compacting;
    default:           return C.idle;
  }
}

export function stateLabel(state: string): string {
  switch (state) {
    case 'active':     return 'active';
    case 'waiting':    return 'waiting';
    case 'compacting': return 'compacting';
    default:           return 'idle';
  }
}

// ─── 포매팅 유틸 (테마 무관) ─────────────────────────────────────────────────

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

// 헤더용 간결 비용 표시
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

// ─── CSS Custom Properties ──────────────────────────────────────────────────

// Theme 토큰 → CSS 변수 이름 매핑
const CSS_VAR_MAP: Record<keyof Theme, string> = {
  headerBg: '--wmt-header-bg', headerText: '--wmt-header-text', headerAccent: '--wmt-header-accent',
  headerSub: '--wmt-header-sub', headerBorder: '--wmt-header-border',
  bg: '--wmt-bg', bgCard: '--wmt-bg-card', bgRow: '--wmt-bg-row', bgHover: '--wmt-bg-hover',
  border: '--wmt-border', borderSub: '--wmt-border-sub',
  text: '--wmt-text', textDim: '--wmt-text-dim', textMuted: '--wmt-text-muted',
  accent: '--wmt-accent', accentDim: '--wmt-accent-dim',
  active: '--wmt-active', waiting: '--wmt-waiting', idle: '--wmt-idle', compacting: '--wmt-compacting',
  input: '--wmt-input', output: '--wmt-output', cacheW: '--wmt-cache-w', cacheR: '--wmt-cache-r',
  opus: '--wmt-opus', sonnet: '--wmt-sonnet', haiku: '--wmt-haiku', gpt: '--wmt-gpt',
  gpt5: '--wmt-gpt-5', gptCodex: '--wmt-gpt-codex', gpt4: '--wmt-gpt-4', codexMini: '--wmt-codex-mini',
  barGreen: '--wmt-bar-green', barOrange: '--wmt-bar-orange', barRed: '--wmt-bar-red', barYellow: '--wmt-bar-yellow',
  gradeExcellentBg: '--wmt-grade-excellent-bg', gradeExcellentColor: '--wmt-grade-excellent-color',
  gradeGoodBg: '--wmt-grade-good-bg', gradeGoodColor: '--wmt-grade-good-color',
  gradeFairBg: '--wmt-grade-fair-bg', gradeFairColor: '--wmt-grade-fair-color',
  gradePoorBg: '--wmt-grade-poor-bg', gradePoorColor: '--wmt-grade-poor-color',
  etaWarning: '--wmt-eta-warning',
  fontMono: '--wmt-font-mono', fontSans: '--wmt-font-sans',
};

/**
 * 현재 테마의 색상값을 CSS 커스텀 프로퍼티로 :root에 설정.
 * index.html의 body/scrollbar 등 CSS 레벨 스타일에서 var(--wmt-*) 참조 가능.
 */
export function applyThemeCssVars(theme: Theme): void {
  const root = document.documentElement;
  for (const [key, varName] of Object.entries(CSS_VAR_MAP)) {
    root.style.setProperty(varName, theme[key as keyof Theme]);
  }
}

// 새 코드는 useTheme() 훅 사용 권장
