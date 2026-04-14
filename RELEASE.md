# 릴리즈 가이드 — WhereMyTokens

## 배포 흐름 요약

```
버전 bump → 빌드 → ZIP 생성 → 커밋 → 푸시 → GitHub Release
```

---

## 1. 앱 종료

빌드 전 WhereMyTokens가 실행 중이면 `release/win-unpacked/` 내 DLL이 잠겨 빌드 실패.

```powershell
Get-Process -Name 'WhereMyTokens','electron' -ErrorAction SilentlyContinue | Stop-Process -Force
```

---

## 2. 버전 bump

`package.json`의 `"version"` 수정:

```
v1.0.x  — 버그 수정 / UX 개선 / 문서
v1.x.0  — 신기능 추가
```

---

## 3. 빌드

```bash
npm run build
```

오류 없이 완료되면 `dist/` 아래 컴파일 결과물 생성.

### NSIS 인스톨러 빌드 (Developer Mode 필요)

Windows 설정 → 개인 정보 및 보안 → 개발자용 → **개발자 모드 ON** 상태에서:

```bash
npm run dist
```

성공하면 `release/` 아래 `.exe` 인스톨러와 portable `.exe` 생성.

### Developer Mode 없이 포터블 ZIP만 배포

`npm run dist`가 winCodeSign symlink 오류로 실패하면, 패키징(win-unpacked)만 완료된 상태에서:

```powershell
Compress-Archive -Path 'release\win-unpacked\*' `
  -DestinationPath "release\WhereMyTokens-vX.Y.Z-win-x64.zip" -Force
```

> **원인**: electron-builder의 winCodeSign 패키지가 macOS 심볼릭 링크를 포함하는데,
> Windows는 Developer Mode 또는 관리자 권한 없이 심볼릭 링크 생성을 차단함.

---

## 4. 커밋 & 푸시

```bash
git add package.json
git commit -m "chore: 버전 vX.Y.Z — 변경 요약"
git push origin main
```

---

## 5. GitHub Release 생성

```bash
gh release create vX.Y.Z \
  "release/WhereMyTokens-vX.Y.Z-win-x64.zip" \
  --title "WhereMyTokens vX.Y.Z" \
  --notes "## What's New
..."
```

릴리즈 노트 항목:
- `### New Features` — 신기능
- `### Improvements` — 개선
- `### Fixes` — 버그 수정
- `## Install` — 설치 방법 (항상 포함)

---

## 6. 릴리즈 이력 업데이트 (이 파일)

아래 이력에 항목 추가.

---

## 릴리즈 이력

| 버전 | 날짜 | 주요 변경 |
|------|------|-----------|
| v1.5.0 | 2026-04-14 | 대시보드 리디자인 — 다크 테마 기본, 2단계 세션 그루핑, Code Output, Rhythm 탭, 스크롤바 커스텀, 타임존 배지, 설정 정리, 데모 영상 |
| v1.4.1 | 2026-04-07 | 신규 JSONL 파일 생성 시 usage 즉시 갱신, 헤더 토큰/비용 표시 간결화 |
| v1.4.0 | 2026-04-06 | Help 리디자인, Noto Sans 폰트 번들, Help JA 지원, tok 캐시 포함 통일 |
| v1.3.0 | 2026-04-05 | Extra Usage 예산 카드 (월 한도/사용량/% 표시) |
| v1.2.0 | 2026-04-05 | 항상 위젯 모드, 헤더 윈도우 컨트롤, 하단 refresh 탭, API 캐시, 히트맵 자정 정렬 |
| v1.1.0 | 2026-04-05 | 5개월 캘린더 히트맵, 스플래시 스크린, API 단절 UX 개선 |
| v1.0.1 | 2026-04-05 | Sonnet 비용 숨김, API 에러 툴팁, 대시 표시 |
| v1.0.0 | 2026-04-05 | 최초 릴리즈 |
