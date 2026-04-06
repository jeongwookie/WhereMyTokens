import React, { useState } from 'react';
import { C } from '../theme';
import ViewHeader from '../components/ViewHeader';

interface Props { onBack: () => void }
type Lang = 'en' | 'ko';
type CardId = 'plan' | 'bridge' | 'sessions' | 'cost' | 'activity' | 'alerts' | 'projects' | 'models';

interface Card {
  id: CardId;
  icon: string;
  en: { title: string; sub: string; detail: React.ReactNode };
  ko: { title: string; sub: string; detail: React.ReactNode };
}

const B = ({ children }: { children: React.ReactNode }) => (
  <span style={{ color: C.text, fontWeight: 600 }}>{children}</span>
);

const CARDS: Card[] = [
  {
    id: 'plan',
    icon: '📊',
    en: {
      title: 'Plan Usage',
      sub: '5h · 1w · Sonnet',
      detail: (
        <>
          <div><B>5h</B> window aligned to Anthropic's API schedule · <B>1w</B> resets on billing cycle · <B>Sonnet</B> separate weekly cap.</div>
          <div style={{ marginTop: 5 }}>Bar colors: purple → amber (50%) → orange (75%) → red (90%). Reset timer shown next to bar.</div>
          <div style={{ marginTop: 5 }}><B>Extra Usage</B> card appears if monthly add-on credits are enabled on your account.</div>
        </>
      ),
    },
    ko: {
      title: '플랜 사용량',
      sub: '5h · 1w · Sonnet',
      detail: (
        <>
          <div><B>5h</B> Anthropic API 스케줄 기준 윈도우 · <B>1w</B> 빌링 주기 리셋 · <B>Sonnet</B> 독립 주간 상한.</div>
          <div style={{ marginTop: 5 }}>바 색상: 보라 → 황(50%) → 주황(75%) → 적(90%). 옆에 리셋 타이머 표시.</div>
          <div style={{ marginTop: 5 }}><B>Extra Usage</B> 카드는 계정에 월간 추가 크레딧이 활성화된 경우에만 표시.</div>
        </>
      ),
    },
  },
  {
    id: 'bridge',
    icon: '🔗',
    en: {
      title: 'Bridge',
      sub: 'Live data from Claude Code',
      detail: (
        <>
          <div>Registers a <B>statusLine</B> plugin so Claude Code pipes rate limit data in real time — no polling needed.</div>
          <div style={{ marginTop: 5 }}><B>Setup:</B> Settings → Claude Code Integration → Setup.</div>
          <div style={{ marginTop: 5 }}>Header dot: <span style={{ color: '#4ade80', fontWeight: 600 }}>●</span> connected · <span style={{ color: '#f87171', fontWeight: 600 }}>●</span> API unreachable. Hover for error detail.</div>
        </>
      ),
    },
    ko: {
      title: 'Bridge',
      sub: 'Claude Code 실시간 연동',
      detail: (
        <>
          <div><B>statusLine</B> 플러그인으로 등록 — Claude Code가 실행될 때마다 제한량 데이터를 직접 전달.</div>
          <div style={{ marginTop: 5 }}><B>설정:</B> Settings → Claude Code Integration → Setup.</div>
          <div style={{ marginTop: 5 }}>헤더 점: <span style={{ color: '#4ade80', fontWeight: 600 }}>●</span> 연결됨 · <span style={{ color: '#f87171', fontWeight: 600 }}>●</span> API 불가. 호버 시 오류 메시지.</div>
        </>
      ),
    },
  },
  {
    id: 'sessions',
    icon: '🖥',
    en: {
      title: 'Sessions',
      sub: 'State · Context · Tools',
      detail: (
        <>
          <div>States: <B style={{ color: '#2a7a48' }}>active</B> · <B style={{ color: '#a06010' }}>waiting</B> · <B style={{ color: '#9090a8' }}>idle</B> · <B style={{ color: '#1a62a0' }}>compacting</B></div>
          <div style={{ marginTop: 5 }}><B>Context bar</B> — shown per session. Amber ≥50%, orange ≥80%, red ≥95%.</div>
          <div style={{ marginTop: 5 }}><B>Tool bar</B> — color-coded proportional bar + top tool names.</div>
        </>
      ),
    },
    ko: {
      title: '세션',
      sub: '상태 · 컨텍스트 · 툴',
      detail: (
        <>
          <div>상태: <B style={{ color: '#2a7a48' }}>active</B> · <B style={{ color: '#a06010' }}>waiting</B> · <B style={{ color: '#9090a8' }}>idle</B> · <B style={{ color: '#1a62a0' }}>compacting</B></div>
          <div style={{ marginTop: 5 }}><B>컨텍스트 바</B> — 세션별 인라인 표시. 황 ≥50%, 주황 ≥80%, 적 ≥95%.</div>
          <div style={{ marginTop: 5 }}><B>툴 바</B> — 비례 색상 바 + 상위 툴 이름 표시.</div>
        </>
      ),
    },
  },
  {
    id: 'cost',
    icon: '💰',
    en: {
      title: 'Cost',
      sub: 'API-equivalent estimate',
      detail: (
        <>
          <div>The cost shown is <B>not your actual bill.</B></div>
          <div style={{ marginTop: 5 }}>Max / Pro subscriptions are flat monthly fees. This shows the API-equivalent value of your usage — useful for comparing models.</div>
        </>
      ),
    },
    ko: {
      title: '비용',
      sub: 'API 환산 추정값',
      detail: (
        <>
          <div>표시된 비용은 <B>실제 청구액이 아닙니다.</B></div>
          <div style={{ marginTop: 5 }}>Max / Pro는 월정액. 여기서 보이는 건 동일한 사용량을 API로 구매했을 때의 가격 — 모델 비교에 유용.</div>
        </>
      ),
    },
  },
  {
    id: 'activity',
    icon: '🟩',
    en: {
      title: 'Activity',
      sub: '7d · 5mo · Hourly · Weekly',
      detail: (
        <>
          <div><B>7d</B> — 7-day × 24-hour heatmap.</div>
          <div style={{ marginTop: 4 }}><B>5mo</B> — 5-month GitHub-style calendar. Hover for date + tokens.</div>
          <div style={{ marginTop: 4 }}><B>Hourly</B> — token distribution by hour (last 30 days).</div>
          <div style={{ marginTop: 4 }}><B>Weekly</B> — last 4 weeks bar chart.</div>
        </>
      ),
    },
    ko: {
      title: 'Activity',
      sub: '7d · 5mo · Hourly · Weekly',
      detail: (
        <>
          <div><B>7d</B> — 7일 × 24시간 히트맵.</div>
          <div style={{ marginTop: 4 }}><B>5mo</B> — 5개월 GitHub 스타일 캘린더. 날짜+토큰 호버.</div>
          <div style={{ marginTop: 4 }}><B>Hourly</B> — 시간대별 토큰 분포 (최근 30일).</div>
          <div style={{ marginTop: 4 }}><B>Weekly</B> — 최근 4주 바 차트.</div>
        </>
      ),
    },
  },
  {
    id: 'alerts',
    icon: '🔔',
    en: {
      title: 'Alerts',
      sub: 'Threshold notifications',
      detail: (
        <>
          <div>Windows toast when <B>5h / weekly / Sonnet</B> usage reaches 50%, 80%, or 90%.</div>
          <div style={{ marginTop: 5 }}>1-hour cooldown per alert. Re-arms after the limit resets. Configure in the <B>Alerts</B> tab.</div>
        </>
      ),
    },
    ko: {
      title: '알림',
      sub: '임계값 도달 시 토스트',
      detail: (
        <>
          <div><B>5h / 주간 / Sonnet</B> 사용량이 50%, 80%, 90% 도달 시 Windows 알림.</div>
          <div style={{ marginTop: 5 }}>알림당 1시간 쿨다운. 리셋 후 자동 재활성화. 하단 <B>Alerts</B> 탭에서 설정.</div>
        </>
      ),
    },
  },
  {
    id: 'projects',
    icon: '👁',
    en: {
      title: 'Projects',
      sub: 'Hide · Exclude',
      detail: (
        <>
          <div>Hover a project name in the session list to reveal two controls:</div>
          <div style={{ marginTop: 5 }}><B>✕</B> Hide — removes from UI. Data still tracked.</div>
          <div style={{ marginTop: 4 }}><B>⊘</B> Exclude — stops all tracking. Restore from the same area.</div>
        </>
      ),
    },
    ko: {
      title: '프로젝트',
      sub: '숨기기 · 제외',
      detail: (
        <>
          <div>세션 목록에서 프로젝트 이름 호버 시 두 가지 컨트롤 표시:</div>
          <div style={{ marginTop: 5 }}><B>✕</B> 숨기기 — UI에서만 제거. 데이터는 계속 추적.</div>
          <div style={{ marginTop: 4 }}><B>⊘</B> 제외 — 모든 추적 중단. 동일한 위치에서 복원.</div>
        </>
      ),
    },
  },
  {
    id: 'models',
    icon: '🤖',
    en: {
      title: 'Model Usage',
      sub: 'All-time breakdown',
      detail: (
        <>
          <div>Cumulative token usage and cost per model across all time.</div>
          <div style={{ marginTop: 5 }}>Shown as a bar chart in the <B>Model Usage</B> section on the main screen.</div>
        </>
      ),
    },
    ko: {
      title: '모델 사용량',
      sub: '전체 기간 집계',
      detail: (
        <>
          <div>전체 기간의 모델별 누적 토큰 사용량과 비용.</div>
          <div style={{ marginTop: 5 }}>메인 화면 <B>Model Usage</B> 섹션에 바 차트로 표시.</div>
        </>
      ),
    },
  },
];

export default function HelpView({ onBack }: Props) {
  const [lang, setLang] = useState<Lang>('en');
  const [selected, setSelected] = useState<CardId | null>(null);

  const selectedCard = CARDS.find(c => c.id === selected);
  const t = (c: Card) => c[lang];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <ViewHeader title="Help" onBack={onBack} />

      {/* 언어 토글 */}
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

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px 14px' }}>

        {/* 카드 그리드 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {CARDS.map(card => {
            const isSelected = selected === card.id;
            return (
              <button
                key={card.id}
                onClick={() => setSelected(isSelected ? null : card.id)}
                style={{
                  background: isSelected ? C.accent + '10' : C.bgCard,
                  border: `1px solid ${isSelected ? C.accent + '66' : C.border}`,
                  borderRadius: 8,
                  padding: '11px 12px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                <div style={{ fontSize: 20, marginBottom: 6, lineHeight: 1 }}>{card.icon}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: isSelected ? C.accent : C.text }}>
                  {t(card).title}
                </div>
                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
                  {t(card).sub}
                </div>
              </button>
            );
          })}
        </div>

        {/* 상세 패널 */}
        {selectedCard && (
          <div style={{
            marginTop: 10,
            background: C.bgCard,
            border: `1px solid ${C.border}`,
            borderLeft: `3px solid ${C.accent}`,
            borderRadius: 8,
            padding: '12px 14px',
            fontSize: 11,
            color: C.textDim,
            lineHeight: 1.7,
            animation: 'fadeIn 0.15s ease',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>
              {selectedCard.icon} {t(selectedCard).title}
            </div>
            {t(selectedCard).detail}
          </div>
        )}

      </div>
    </div>
  );
}
