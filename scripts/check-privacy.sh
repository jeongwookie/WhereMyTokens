#!/bin/bash
# pre-commit 프라이버시 검사 — 개인 식별 정보가 staged 파일에 포함되면 커밋 차단

FORBIDDEN=(
  "k0k0kara"
  "jeongwookie93"
)

# 실제 금지 단어는 난독화해서 보관 (이 파일 자체가 검사 대상이므로)
# k0k0kara → kokokara
# jeongwookie93 → jeongwookie93 (이메일)

FAIL=0

for encoded in "${FORBIDDEN[@]}"; do
  # 난독화 복원
  term=$(echo "$encoded" | sed 's/0/o/g')

  # staged 파일 중 이 스크립트 자신은 제외하고 검사
  matches=$(git diff --cached --unified=0 -- . ':(exclude)scripts/check-privacy.sh' \
    | grep "^+" | grep -v "^+++" | grep -i "$term")
  if [ -n "$matches" ]; then
    echo ""
    echo "❌  PRIVACY CHECK FAILED: personal identifier found in staged changes"
    echo "$matches"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "Commit blocked. Remove personal identifiers before committing."
  echo "See CLAUDE.md — '개인 정보 보호 규칙' section."
  exit 1
fi

exit 0
