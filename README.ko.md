<img src="assets/source-icon.png" width="80" align="right" />

# WhereMyTokens

**Claude Code 토큰 사용량을 실시간으로 모니터링하는 Windows 시스템 트레이 앱.**

Claude Code를 매일 사용하는 한국인 개발자가 직접 만들고 쓰고 있는 앱입니다.

작업표시줄에 조용히 상주하며 Claude Code 사용량 — 토큰, 비용, 세션 활동, 속도 제한 — 을 한눈에 보여줍니다.

![Platform](https://img.shields.io/badge/platform-Windows_10%2F11-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Release](https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens)

> [English](README.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [Español](README.es.md)

> 💾 **클라우드 동기화 없음** — 로컬 Claude 파일만 읽습니다. 데이터가 외부로 전송되지 않습니다.

<table>
  <tr>
    <th width="50%">라이트 모드</th>
    <th width="50%">다크 모드</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-light.png" alt="Light mode" /></td>
    <td><img src="assets/screenshot-dark.png" alt="Dark mode" /></td>
  </tr>
</table>

<table>
  <tr>
    <th width="33%">Rhythm & 피크 통계</th>
    <th width="33%">7일 히트맵</th>
    <th width="33%">설정</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-rhythm.png" alt="Rhythm tab" /></td>
    <td><img src="assets/screenshot-heatmap.png" alt="7-day heatmap" /></td>
    <td><img src="assets/screenshot-settings.png" alt="Settings" /></td>
  </tr>
</table>

## 최신 업데이트

| 버전 | 날짜 | 주요 변경 |
|------|------|---------|
| **[v1.9.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.9.2)** | 4/20 | NSIS 인스톨러, 세션 추적 정확도 및 안정성 개선 |
| **[v1.9.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.9.1)** | 4/17 | 7d 히트맵 호버 툴팁 수정; zh-CN · es README 추가 |
| **[v1.9.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.9.0)** | 4/17 | 틸 테마, 시스템 다크모드, 증분 JSONL 캐싱, idle 6h+ 자동 숨김 |

[→ 전체 변경 이력](https://github.com/jeongwookie/WhereMyTokens/releases)

---

## 다운로드

**[⬇ 최신 릴리즈 다운로드](https://github.com/jeongwookie/WhereMyTokens/releases/latest)**

다운로드 또는 설치 시 [최종 사용자 라이선스 계약 (EULA)](EULA.ko.txt)에 동의하는 것으로 간주됩니다.

**옵션 A — 인스톨러** _(권장)_
1. `WhereMyTokens-Setup.exe` 다운로드
2. 인스톨러 실행 후 안내에 따라 설치
3. 앱이 자동으로 열리고 시스템 트레이에 상주합니다

**옵션 B — 포터블 ZIP** _(설치 불필요)_
1. `WhereMyTokens-v1.9.2-win-x64.zip` 다운로드
2. 원하는 위치에 압축 해제
3. `WhereMyTokens.exe` 실행

---

## 주요 기능

### 세션 추적
- **실시간 세션 감지** — Terminal, VS Code, Cursor, Windsurf 등, 실시간 상태: `active` / `waiting` / `idle` / `compacting`
- **2단계 그루핑** — git 프로젝트 → 브랜치별 그루핑, 프로젝트별 커밋·라인 통계
- **Idle 자동 숨김** — idle 세션은 단계적 축소; 6시간 이상은 자동 숨김 (펼치기 가능)
- **컨텍스트 창 경고** — 세션별 바; 50% 황색, 80% 주황, 95%+ 적색
- **툴 사용 바** — 비례 색상 바 + 툴 칩 (Bash, Edit, Read 등)

### 속도 제한 & 알림
- **속도 제한 바** — Anthropic API 5시간·주간 사용량, 프로그레스 바, 리셋 카운터, 캐시 효율 등급
- **Claude Code 브리지** — `statusLine` 플러그인으로 API 폴링 없이 실시간 데이터 수신
- **Windows 토스트 알림** — 사용량 임계값(50% / 80% / 90%)에서 알림
- **Extra Usage 예산** — 월간 크레딧 사용량 / 한도 / 이용률 표시

### 분석 & 활동
- **헤더 통계** — today/all-time 토글: 비용, API 호출, 세션, 캐시 적중률, 절약 비용, 토큰 분석(In/Out/Cache)
- **활동 탭** — 7일 히트맵, 5개월 캘린더(GitHub 스타일), 시간대별 분포, 4주 비교
- **Rhythm 탭** — 시간대별 비용 분포 (Morning/Afternoon/Evening/Night), 그라데이션 바, 피크 상세 통계, 로컬 타임존
- **모델별 분석** — 모델별 토큰·비용 합계, 그라데이션 바
- **Activity Breakdown** — 세션별 output 토큰 10개 카테고리 분석 (Thinking, Edit/Write, Read, Search, Git 등)

### Code Output & 생산성
- **Git 기반 지표** — 커밋 수, 순 라인 변경, **$/100 Lines** (100 라인 추가당 비용)
- **Today vs All-time** — 오늘 실제 비용과 전체 평균 비교
- **자동 발견** — `~/.claude/projects/` 히스토리로 Claude 사용 전체 프로젝트 포함
- **본인 커밋만** — `git config user.email` 기준 필터링

### 커스터마이징
- **Auto/Light/Dark 테마** — 기본값은 시스템 설정 따름
- **비용 표시** — USD 또는 KRW, 환율 설정 가능
- **항상 위 위젯** — 다른 창 위에 고정; 헤더 버튼, 트레이 아이콘, 전역 단축키로 최소화
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
- **통화** — USD 또는 KRW
- **알림** — 사용량 임계값 설정 (50% / 80% / 90%)
- **테마** — Auto (시스템 설정 따름) / Light / Dark
- **트레이 라벨** — 작업표시줄에 표시할 정보 선택

---

## Claude Code 연동 (브리지)

WhereMyTokens는 공식 `statusLine` 플러그인 메커니즘을 통해 Claude Code로부터 실시간 속도 제한 데이터를 받을 수 있습니다 — API 폴링 불필요.

**동작 방식:**
1. **Settings → Claude Code Integration → Setup** 실행
2. `~/.claude/settings.json`에 WhereMyTokens를 `statusLine` 명령으로 등록
3. Claude Code 실행 시마다 세션 데이터(속도 제한, 컨텍스트 %, 모델, 비용)를 stdin으로 전달
4. 앱이 즉시 업데이트 — 폴링 지연 없음

브리지는 컨텍스트 창 %, 모델, 비용 등 보조 데이터를 제공합니다. 속도 제한 퍼센트는 항상 Anthropic API를 권위 있는 소스로 사용하며, API를 사용할 수 없을 때만 브리지 값으로 폴백합니다.

---

## 속도 제한 동작 방식

두 가지 데이터 소스를 우선순위 순서로 사용:

| 우선순위 | 소스 | 설명 |
|---------|------|------|
| 1순위 | **Anthropic API** | `/api/oauth/usage` — 웹 대시보드와 동일한 권위 있는 데이터. 3분마다 조회, 429 시 지수 백오프. |
| 2순위 | **브리지 (stdin)** | `statusLine`을 통해 Claude Code에서 전달되는 실시간 데이터. API 불가 시 폴백. |
| 폴백 | **마지막 알려진 값** | API 실패 시 마지막 성공 값 유지. 리셋 시각이 지난 stale 데이터는 자동 초기화. |

헤더의 점은 API 연결 상태를 표시합니다 (초록 = 연결됨, 빨강 = 연결 불가). 점에 마우스를 올리면 오류 메시지를 볼 수 있습니다.

---

## 수치 계산 기준

모든 토큰 수는 **input + output + 캐시 생성 + 캐시 읽기** 포함. 비용은 항상 API 환산 추정값.

| 표시 위치 | 범위 | 포함 내용 |
|---------|------|----------|
| 헤더 (today) | 오늘 자정 이후 | In/Out/Cache + 호출 수, 세션 수, 캐시 절약 |
| 헤더 (all) | 전체 기간 | In/Out/Cache + 호출 수, 세션 수, 캐시 절약 |
| Plan Usage (5h / 1w) | 현재 빌링 창 | 모든 토큰 유형 |
| Model Usage | 전체 기간, 모델별 | 모든 토큰 유형 |

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

세션 행의 **Breakdown** 버튼을 클릭하면 카테고리별 output 토큰 분석 패널이 펼쳐집니다. 한 번에 하나만 열림.

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

## 데이터 & 개인정보

WhereMyTokens는 로컬 파일만 읽습니다 — 클라우드 동기화 없음, 텔레메트리 없음.

| 파일 | 용도 |
|------|------|
| `~/.claude/sessions/*.json` | 세션 메타데이터 (pid, cwd, 모델) |
| `~/.claude/projects/**/*.jsonl` | 대화 로그 (토큰 수, 비용) |
| `~/.claude/.credentials.json` | OAuth 토큰 — Anthropic에서 본인 사용량 조회용 |
| `%APPDATA%\WhereMyTokens\live-session.json` | `statusLine` 플러그인 브리지 데이터 |

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
