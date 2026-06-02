<p align="center">
  <img src="assets/source-icon.png" width="88" alt="WhereMyTokens icon" />
</p>

<h1 align="center">WhereMyTokens</h1>

<p align="center">
  <strong>이제 Codex와 Antigravity도 함께 추적합니다.</strong>
</p>

<p align="center">
  <img alt="Codex tracking" src="https://img.shields.io/badge/Codex_tracking-new-4f46e5?style=for-the-badge">
  <img alt="Antigravity local RPC" src="https://img.shields.io/badge/Antigravity-local_RPC-0f766e?style=for-the-badge">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-supported-d97706?style=for-the-badge">
  <img alt="Local only" src="https://img.shields.io/badge/Local_only-no_cloud_sync-0f766e?style=for-the-badge">
</p>

<p align="center">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%2F11-0078d4?style=for-the-badge">
  <img alt="Release" src="https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.17.0/WhereMyTokens-Setup.exe"><strong>v1.17.0 다운로드</strong></a>
  ·
  <a href="#주요-기능">주요 기능</a>
  ·
  <a href="#screenshots">스크린샷</a>
</p>

<p align="center">
  <em>Antigravity 지원은 다음 패키지 릴리스용 소스에 포함되어 있으며, v1.17.0 다운로드에는 아직 포함되지 않습니다.</em>
</p>

<p align="center">
  Claude Code, Codex, Antigravity의 토큰, 비용, 세션, 캐시, 모델별 사용량, quota를 한눈에 보여주는 로컬 우선 Windows 트레이 앱입니다.
</p>

<a id="screenshots"></a>

<table>
  <tr>
    <th>다크 오버뷰</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-overview-dark.png" alt="WhereMyTokens 다크 오버뷰" /></td>
  </tr>
  <tr>
    <th>라이트 오버뷰</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-overview-light.png" alt="WhereMyTokens 라이트 오버뷰" /></td>
  </tr>
</table>

> Claude Code를 매일 사용하는 한국인 개발자가 직접 만들고 쓰고 있는 앱입니다.

## 최신 업데이트

| 버전 | 날짜 | 주요 변경 |
|------|------|---------|
| **[v1.17.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.17.0)** | 6/2 | Plan Usage를 provider quota snapshot 기반으로 재구성하고, target별 Rich/Simple/None 표시 그룹과 안전한 quota 상태 복원/마이그레이션을 추가 |
| **[v1.16.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.16.1)** | 5/27 | 잘린 full-history ledger import나 실패한 source가 있어도 budgeted warmup을 계속 예약하고 stale provider completion marker를 피하도록 수정 |
| **[v1.16.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.16.0)** | 5/26 | 지속 사용량 ledger, 즉시 시작 snapshot, cost/token 히스토리와 git 순 라인 산출을 함께 보는 Trend 카드를 추가 |
| **[v1.15.3](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.3)** | 5/25 | Refresh 작업을 scheduler로 직렬화하고 기본 budget을 적용해 startup, watcher, history, manual refresh 중에도 tray UI와 hotkey popup 반응성을 유지 |
| **[v1.15.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.2)** | 5/21 | Codex 아카이브 로그와 Claude agent 로그를 all-time 사용량에 포함하고, all-time 세션 수를 전체 사용 기록 기준으로 표시 |

[→ 전체 변경 이력](https://github.com/jeongwookie/WhereMyTokens/releases)

---

## 다운로드

**[⬇ 인스톨러 다운로드 (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.17.0/WhereMyTokens-Setup.exe)** — 받아서 실행하면 끝

**[⬇ 포터블 ZIP 다운로드](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.17.0/WhereMyTokens-v1.17.0-win-x64.zip)** — 설치 없이 실행

다운로드 또는 설치 시 [최종 사용자 라이선스 계약 (EULA)](EULA.ko.txt)에 동의하는 것으로 간주됩니다.

**옵션 A — 인스톨러** _(권장)_
1. 위 링크에서 `WhereMyTokens-Setup.exe` 다운로드
2. 인스톨러 실행 후 안내에 따라 설치
3. 앱이 자동으로 열리고 시스템 트레이에 상주합니다

**옵션 B — 포터블 ZIP** _(설치 불필요)_
1. 릴리즈 페이지에서 `WhereMyTokens-v1.17.0-win-x64.zip` 다운로드
2. 원하는 위치에 압축 해제
3. `WhereMyTokens.exe` 실행

---

## 주요 기능

### 세션 추적
- **Provider 선택** — Claude Code, Codex, Antigravity를 하나의 대시보드에서 켜고 끄며 추적
- **실시간 세션 감지** — Terminal, VS Code, Cursor, Windsurf 등, 실시간 상태: `active` / `waiting` / `idle` / `compacting`
- **Compact 그루핑** — git 프로젝트 → 브랜치별 그루핑, 반복 provider 세션은 provider/source/model/state 기준으로 stack 처리
- **브랜치 row 제한** — 각 브랜치는 기본 3개 행만 표시하고 나머지는 "Show N more"로 펼침
- **컨텍스트 창 경고** — 세션별 바; 70% 황색, 85% 주황, 95%+ 적색
- **툴 사용 바** — 비례 색상 바 + 툴 칩 (Bash, Edit, Read 등)

### 속도 제한 & 알림
- **Provider quota 바** — Claude, Codex, Antigravity와 이후 provider가 `providerQuotas` snapshot으로 유효 quota를 게시합니다. Claude는 Anthropic API/statusLine/cache, Codex는 live usage/cache/local-log, Antigravity는 IDE 실행 중 127.0.0.1 local RPC에서 모델 quota를 읽습니다
- **Target별 quota 표시** — 각 provider window 또는 model target을 Settings에서 Rich, Simple, 숨김으로 설정할 수 있습니다. 이 설정은 Plan Usage와 Floating widget 표시만 바꿉니다
- **Quota Pace 보기** — 사용한 한도 %와 경과 시간 %를 비교해, 노랑/빨강으로 리셋 전 사용 속도가 빠른 상태를 알려줌
- **Claude Code 브리지** — `statusLine` 플러그인으로 API 폴링 없이 실시간 데이터 수신
- **Windows 토스트 알림** — 사용량 임계값(50% / 80% / 90%)에서 알림
- **Claude Extra Usage 예산** — Claude 월간 크레딧 사용량 / 한도 / 이용률 표시

### 분석 & 활동
- **헤더 통계** — today/all-time 토글: 비용, API 호출, 세션, 캐시 효율, 절약 비용, 컴팩트한 provider 메타데이터, provider별 health/fallback 상태. `all`의 세션 수는 현재 표시 중인 행이 아니라 전체 사용 기록 기준입니다
- **즉시 시작 snapshot** — 마지막으로 정상 표시된 UI 상태를 즉시 복원하고, fresh scan은 백그라운드에서 이어서 실행
- **시작 친화적 히스토리 동기화** — 현재 세션과 최근 사용량을 먼저 보여주고, 오래된 히스토리는 budgeted refresh scheduler를 통해 백그라운드에서 계속 동기화되어 hotkey popup과 UI 반응성을 유지
- **지속 사용량 ledger** — 로컬 JSONL 사용량을 aggregate ledger로 저장해 오래된 합계가 JSONL cache eviction에 덜 의존하고, 필요하면 Settings에서 재빌드 가능
- **Trend 카드** — 일/주/월 cost/token 히스토리와 git 순 라인 산출을 함께 표시하며, 일부 데이터가 비어도 0처럼 이어 그리지 않음
- **활동 탭** — 7일 히트맵, 5개월 캘린더(GitHub 스타일), 시간대별 분포, 4주 비교
- **Rhythm 탭** — 시간대별 비용 분포 (Morning/Afternoon/Evening/Night), 그라데이션 바, 피크 상세 통계, 로컬 타임존
- **모델별 분석** — 상위 모델별 토큰·비용 합계, 그라데이션 바
- **Activity Breakdown** — Claude는 output 토큰 기준, Codex는 tool event 기준으로 10개 카테고리 분석 (Thinking, Edit/Write, Read, Search, Git 등)

### Code Output & 생산성
- **Git 기반 지표** — 커밋 수, 순 라인 변경, **$/100 Added** (100 추가 라인당 비용)
- **Today vs All-time** — 오늘의 추가 라인당 실제 비용과 전체 평균 비교
- **Output 성장 그래프** — 최근 7일 로컬 날짜별로 전체 누적 순 라인 증가 흐름 표시
- **현재 세션 repo 범위** — Code Output은 현재 추적 중인 세션에 연결된 repo 기준으로 집계된다는 라벨을 함께 표시
- **브랜치 반영 전체 기간** — Code Output의 전체 기간은 로컬 브랜치 전체의 커밋과 라인 변경을 로컬 git 작성자 이메일 기준으로 집계
- **자동 발견** — Claude 프로젝트는 `~/.claude/projects/`에서 agent 사용 로그까지 포함하고, Codex 세션은 `~/.codex/sessions/`, `~/.codex/archived_sessions/`, `~/.codex/session-cleanup-archive/`에서 자동 포함하며, Antigravity는 실행 중인 로컬 language server의 cascade를 local RPC로 읽습니다
- **본인 커밋만** — `git config user.email` 기준 필터링

### 커스터마이징
- **Auto/Light/Dark 테마** — 기본값은 시스템 설정 따름
- **비용 표시** — USD 또는 KRW, 환율 설정 가능
- **Floating usage widget** — 항상 위에 표시되는 작은 Quota Pace 창; 메인 헤더, 트레이 메뉴, Settings, 위젯 버튼에서 표시/숨김 가능. Waiting 애니메이션은 기본 꺼짐이며 Settings에서 다시 켤 수 있습니다
- **트레이 라벨** — 사용량 %, 토큰 수, 비용 직접 표시
- **프로젝트 관리** — 숨기기 또는 추적에서 완전 제외
- **Windows 시작 시 자동 실행** — 선택적 자동 실행

---

## 빠른 시작

### 1. 대시보드 열기
트레이 아이콘 클릭 (또는 전역 단축키 `Ctrl+Shift+D`).

### 2. Claude Code 브리지 연결 (선택)
**Settings → Claude Code Integration → Setup** — API 폴링 없이 실시간 속도 제한 데이터 수신.

### 3. 설정
- **Tracking providers** — Claude Code, Codex, Antigravity 체크박스를 켜고 끕니다
- **통화** — USD 또는 KRW
- **알림** — 사용량 임계값 설정 (50% / 80% / 90%)
- **테마** — Auto (시스템 설정 따름) / Light / Dark
- **트레이 라벨** — 작업표시줄에 표시할 정보 선택
- **Floating usage widget** — 작은 Quota Pace 창을 켤 수 있고, 이후 메인 헤더 토글이나 트레이 메뉴로 다시 표시/숨김 가능

---

## 아키텍처

WhereMyTokens는 local-first Electron 트레이 앱입니다. renderer는 로컬 파일이나 자격 증명을 직접 읽지 않으며, 파일 시스템, provider API, 트레이, 설정 작업은 Electron main process에서 처리하고 preload bridge를 통해서만 renderer에 전달합니다.

| 계층 | 역할 |
|------|------|
| Electron main | Provider 세션 발견, JSONL/local RPC 사용량 조회, 트레이/창 상태 관리, 앱 설정 저장. |
| Preload bridge | `contextIsolation` 경계를 유지하면서 typed `window.wmt` IPC 표면만 노출. |
| React renderer | 트레이 대시보드, 설정, 알림, 활동 차트, compact quota 위젯 표시. |
| `statusLine` bridge | `src/bridge/bridge.ts`가 Claude Code stdin JSON을 받아 main process가 감시하는 로컬 bridge snapshot을 기록. |

| 데이터 흐름 | 소스 | 목적지 | 네트워크 |
|-------------|------|--------|----------|
| Claude 세션 | `~/.claude/sessions/*.json`, `~/.claude/projects/**/*.jsonl` | main process parser/cache, 이후 renderer state | 없음 |
| Claude 브리지 | Claude Code `statusLine` stdin | `%APPDATA%\WhereMyTokens\live-session.json` | 없음 |
| Claude 사용량 한도 | `~/.claude/.credentials.json` OAuth token | Anthropic `/api/oauth/usage` | 있음, Anthropic 직접 호출 |
| Codex 세션 | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl`, `~/.codex/session-cleanup-archive/**/*.jsonl` | main process parser/cache, 이후 renderer state | 없음 |
| Codex 사용량 한도 | `~/.codex/auth.json` OAuth token | ChatGPT/Codex usage endpoint | 있음, OpenAI/ChatGPT 직접 호출 |
| Antigravity 세션/quota | 실행 중인 Antigravity language server | 127.0.0.1 local RPC, 이후 renderer state | 없음 |

Quota 우선순위는 provider별로 다릅니다. Claude는 Anthropic API를 1순위로 사용하고 `statusLine` bridge를 폴백으로 사용합니다. Codex는 live usage를 1순위로 사용하고 JSONL 로그의 로컬 `rate_limits` 이벤트를 폴백으로 사용합니다. Antigravity는 실행 중인 IDE의 127.0.0.1 local RPC만 사용하며, 마지막 성공 값은 stale 상태가 되기 전까지만 유지합니다.

---

## 보안 & 개인정보

WhereMyTokens는 로컬 파일을 읽고, 활성화된 경우 본인 계정의 provider 사용량 API만 직접 호출합니다. 클라우드 동기화와 텔레메트리는 없습니다.

| 로컬 경로 | 용도 |
|-----------|------|
| `~/.claude/sessions/*.json` | pid, cwd, 모델 같은 Claude 세션 메타데이터. |
| `~/.claude/projects/**/*.jsonl` | 토큰 수, 비용, 컨텍스트, 활동 요약 계산용 Claude 대화 로그. |
| `~/.claude/.credentials.json` | Anthropic 사용량 조회와 만료된 access token refresh에만 쓰는 Claude OAuth 정보. |
| `~/.codex/sessions/**/*.jsonl` | 최근 Codex 세션의 토큰, cached input, 모델, rate-limit 이벤트, tool 활동 계산용 로그. |
| `~/.codex/archived_sessions/**/*.jsonl` | all-time 사용량 합계에 포함되는 Codex 아카이브 세션 로그. |
| `~/.codex/session-cleanup-archive/**/*.jsonl` | all-time 사용량 합계에 포함되는 Codex 세션 정리 아카이브 로그. |
| `~/.codex/auth.json` | Codex 사용량 snapshot 조회에만 쓰는 ChatGPT OAuth 정보. 앱 storage에 복사하거나 로그로 남기지 않습니다. |
| Antigravity local RPC | 실행 중인 Antigravity IDE의 language server에서 세션, 모델 quota, generator metadata를 읽습니다. Google OAuth, refresh token, Google cloud usage endpoint, 오프라인 DB fallback은 사용하지 않습니다. |
| `%APPDATA%\WhereMyTokens\live-session.json` | Claude Code `statusLine` bridge가 쓰는 로컬 bridge snapshot. |
| Electron app data (`%APPDATA%\WhereMyTokens`) | 앱 설정, 로컬 캐시, 알림 기록, bridge 상태. |

자격 증명 처리는 좁게 제한되어 있습니다. WhereMyTokens는 공식 CLI의 로컬 credential 파일을 읽고, API key를 직접 입력받지 않으며, 별도 credential 백업을 저장하지 않습니다. Claude access token이 만료되면 Anthropic을 통해 refresh하고 갱신된 credentials를 `~/.claude/.credentials.json`에 원자적으로 다시 쓸 수 있습니다.

네트워크 접근은 활성화한 provider 체크박스의 usage endpoint와 로컬 loopback으로 제한됩니다. Claude usage polling은 최대 5분마다 실행하고 429 backoff를 적용합니다. Codex live usage는 HTTPS-only 요청, timeout, 응답 크기 제한, cache, backoff를 적용합니다. Antigravity 추적은 127.0.0.1 local RPC만 사용하며 Google OAuth, refresh token, Google cloud usage endpoint, 오프라인 DB fallback을 사용하지 않습니다. 로컬 JSONL 파싱, Antigravity local RPC, `statusLine` bridge는 세션 내용을 외부로 보내지 않습니다.

Claude Code bridge를 끄려면 **Settings -> Claude Code Integration -> Disable**을 누릅니다. 앱은 WhereMyTokens bridge command가 소유한 `statusLine` entry만 제거하며, 다른 custom `statusLine`은 덮어쓰거나 삭제하지 않습니다. 수동으로는 `~/.claude/settings.json`에서 WhereMyTokens `statusLine` entry를 삭제한 뒤 Claude Code를 재시작하면 됩니다.

---

## 시작 & 헤더 상태

시작 직후에는 현재 세션과 최근 사용량을 먼저 보여줍니다. `Partial History`가 보이면 오래된 히스토리를 budgeted background slice로 계속 동기화 중이라는 뜻이며, 트레이 앱과 hotkey popup이 빠르게 반응하도록 하기 위한 동작입니다.

헤더의 작은 PiP 버튼은 Floating Quota Pace 위젯을 바로 켜고 끕니다. 헤더 상태 pill은 provider/API 관련 핵심 상태를 한 곳에 요약합니다. 대표 라벨은 `Claude local`, `Claude partial`, `Claude refresh`, `Claude login`, `Claude limited`, `Claude offline`, `refresh failed`입니다. Quota Pace 위젯은 `Claude OK`, `Codex OK`, `Antigravity OK`처럼 provider별 health 칩을 따로 보여주며, pill이나 칩에 마우스를 올리면 최신 상세 사유를 볼 수 있습니다.

---

## Provider 추적 상세

### Claude Code 브리지

WhereMyTokens는 Claude Code의 공식 `statusLine` 플러그인 메커니즘을 통해 컨텍스트, 모델, 비용, 폴백용 속도 제한 데이터를 실시간으로 받을 수 있습니다. **Settings -> Claude Code Integration -> Setup**으로 등록하고, **Disable**로 WhereMyTokens가 소유한 bridge entry를 제거합니다.

### Codex 추적

WhereMyTokens는 Codex의 로컬 JSONL 로그(`~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl`, `~/.codex/session-cleanup-archive/**/*.jsonl`)도 읽을 수 있습니다. Settings에서 추적할 provider 체크박스를 켭니다.

**Codex 추적에 포함되는 내용:**
- 세션 상태, 프로젝트/브랜치 그루핑, VS Code 또는 Codex Exec 같은 source 표시
- GPT/Codex 모델별 사용량과 API 환산 비용 추정
- input, cached input, output 토큰, 캐시 절약액, 전체 기간 모델별 합계
- live Codex usage가 가능할 때 Codex 5h/1w 사용률과 reset 시간, 실패 시 캐시/로컬 `rate_limits` 폴백
- Codex 로그는 tool별 output token이 아니라 tool call을 제공하므로, Activity Breakdown은 tool event count 기준으로 표시

### Antigravity 추적

Antigravity 추적은 실행 중인 Antigravity IDE의 language server에 127.0.0.1 local RPC로만 연결합니다. 세션 cascade, 모델 quota, generator metadata를 읽어 providerQuotas와 사용량 ledger에 반영하며, Google OAuth, refresh token, Google cloud usage endpoint, 오프라인 DB fallback은 사용하지 않습니다.

**Prompt 캐시 계산식:** Codex 로그는 `input_tokens`와 `cached_input_tokens`를 제공합니다. WhereMyTokens는 uncached input을 `input_tokens - cached_input_tokens`로, cached input을 cache-read token으로 저장합니다. Codex와 Antigravity는 cache read가 prompt token에서 차지하는 비율을 캐시 효율로 표시합니다.

```text
cache_read_tokens / (uncached_input_tokens + cache_creation_tokens + cache_read_tokens)
```

Codex에서는 이 값이 `cached_input_tokens / input_tokens`와 같습니다. Claude는 cache write/read 효율을 사용합니다.

```text
cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens)
```

## 수치 계산 기준

모든 토큰 수는 가능한 경우 **input + output + 캐시 생성 + 캐시 읽기**를 포함합니다. 비용은 앱 내부 가격표를 사용한 API 환산 추정값입니다.

Claude는 input, output, cache creation, cache read를 제공합니다. Codex는 raw input, cached input, output을 제공하므로, WhereMyTokens는 raw input을 uncached input과 cached input으로 나눠 캐시 절약액과 모델별 합계가 중복 계산되지 않게 합니다.

| 표시 위치 | 범위 | 포함 내용 |
|---------|------|----------|
| 헤더 (today) | 오늘 자정 이후 | In/Out/Cache + 호출 수, 세션 수, 캐시 절약 |
| 헤더 (all) | 전체 기간 | In/Out/Cache + 호출 수, 세션 수, 캐시 절약 |
| Plan Usage (provider quotas) | Provider reset window | Provider 토큰 유형 + `providerQuotas[provider]` window, status, source, credit, target별 Rich/Simple/None 표시 모드 |
| Model Usage | 전체 기간, provider별 상위 4개 모델 | 모든 토큰 유형 |

> **참고:** `$` 값은 추정값으로 실제 청구액이 아닙니다. Claude Max/Pro 구독은 월정액이며, 비용 표시는 구독에서 얻는 사용 가치를 보여줍니다.

---

## 활동 탭

| 탭 | 설명 |
|----|------|
| 7d | 7일 히트맵 (요일 × 시간 그리드), 시간축 + 색상 범례 |
| 5mo | 5개월 캘린더 그리드 (GitHub 스타일, 날짜+토큰 호버) |
| Hourly | 최근 30일의 시간대별 토큰 분포 |
| Weekly | 최근 4주 가로 바 차트 |
| Rhythm | 시간대별 비용 분포 — Morning ☀️ / Afternoon 🔥 / Evening 🌆 / Night 🌙, 그라데이션 바, 피크 상세 통계, 로컬 타임존 (30일) |

---

## Activity Breakdown

세션 행의 **Details** 버튼을 클릭하면 카테고리별 활동 분석 패널이 펼쳐집니다. Claude 세션은 output token 배분을 표시하고, Codex 세션은 tool별 output token 대신 function/tool call 로그가 있으므로 tool event count를 표시합니다. 한 번에 하나만 열림.

| 카테고리 | 색상 | 소스 |
|---------|------|------|
| 💭 Thinking | 틸 | 확장 사고 블록 |
| 💬 Response | 슬레이트 | 텍스트 블록 — 최종 응답 |
| 📄 Read | 블루 | `Read` 툴 |
| ✏️ Edit / Write | 바이올렛 | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| 🔍 Search | 스카이 | `Grep`, `Glob`, `LS`, `TodoRead`, `TodoWrite` |
| 🌿 Git | 그린 | `Bash` — `git` 명령 |
| ⚙️ Build / Test | 오렌지 | `Bash` — `npm`, `tsc`, `jest`, `cargo`, `python` 등 |
| 💻 Terminal | 앰버 | 기타 `Bash` 명령; `mcp__*` 툴 |
| 🤖 Subagents | 핑크 | `Agent` 툴 |
| 🌐 Web | 퍼플 | `WebFetch`, `WebSearch` |

> **토큰 배분:** 각 턴의 output 토큰을 컨텐츠 블록 문자 수 비율로 분배 (`블록 문자 수 ÷ 전체 문자 수 × output 토큰`). 값이 0인 카테고리는 숨김.

---

## 소스에서 설치

### 요구 사항

- Windows 10 / 11
- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) 설치 및 로그인 상태

### 빌드 & 실행

```bash
git clone https://github.com/jeongwookie/WhereMyTokens.git
cd WhereMyTokens
npm install
npm run build
npm start
```

### 설치 파일 빌드

```bash
npm run dist
# -> release/WhereMyTokens Setup x.x.x.exe  (NSIS 설치 파일)
# -> release/WhereMyTokens x.x.x.exe         (포터블)
```

> **참고:** Windows에서 NSIS 설치 파일 빌드 시 개발자 모드 활성화가 필요합니다 (설정 → 개발자용 → 개발자 모드). `release/win-unpacked/`의 포터블 `.exe`는 개발자 모드 없이도 동작합니다.

---

## 데모

<div align="center">

https://github.com/user-attachments/assets/98b6f8d7-6fc6-4c12-aef1-af6300db0728

</div>

---

## 면책 조항

표시되는 비용은 **API 환산 추정값**이며 실제 청구 금액이 아닙니다. Claude Max/Pro 구독은 월정액이며, 비용 표시는 구독에서 얼마나 많은 사용 가치를 얻고 있는지를 보여줍니다.

---

## 기여하기

이슈와 풀 리퀘스트를 환영합니다. 변경하고 싶은 사항이 있으면 먼저 이슈를 열어주세요.

---

## 감사의 말

macOS 버전인 [duckbar](https://github.com/rofeels/duckbar)에서 영감을 받았습니다.

---

## 라이선스

MIT
