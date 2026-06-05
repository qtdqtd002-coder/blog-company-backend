#!/usr/bin/env bash
# ============================================================
# 쓰담 백엔드 — VM 한 줄 재배포 스크립트
# ------------------------------------------------------------
# 사용법(VM SSH 접속 후, 저장소 폴더에서):
#     ./deploy.sh
# 하는 일:
#   1) git pull (최신 코드)
#   2) npm install --omit=dev (운영 의존성만; multer 등 신규 의존성 자동 설치)
#   3) .env 없으면 .env.example 에서 생성
#   4) ADMIN_TOKEN 이 비어 있으면 자동 발급해 .env 에 기록(있으면 보존)
#   5) pm2 또는 systemd 로 무중단 재시작(둘 중 구동 중인 쪽 자동 감지)
#   6) 헬스체크 + ADMIN_TOKEN 출력(PC 러너 .runner.config.json 에 넣을 값)
#
# 안전: 기존 .env 값은 덮어쓰지 않는다(ADMIN_TOKEN 도 비어 있을 때만 발급).
#       VAPID 키는 PWA 와 짝이라 자동 생성하지 않는다(없으면 경고만).
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=".env"
PORT_DEFAULT=8080

echo "==> [1/6] git pull"
if [ -d .git ]; then
  git pull --ff-only || { echo "    git pull 실패(로컬 변경/충돌?) — 수동 확인 필요"; exit 1; }
else
  echo "    (git 저장소 아님 — pull 건너뜀)"
fi

echo "==> [2/6] npm install --omit=dev"
npm install --omit=dev

echo "==> [3/6] .env 확인"
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "    .env 없어 .env.example 에서 생성함 — VAPID/CORS 등 값 채우세요."
fi

echo "==> [4/6] ADMIN_TOKEN 확인/발급"
# .env 에서 현재 ADMIN_TOKEN 값을 읽는다(주석/공백 제외, 첫 매치).
CUR_TOKEN="$(grep -E '^ADMIN_TOKEN=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
if [ -z "${CUR_TOKEN}" ]; then
  NEW_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  if grep -qE '^ADMIN_TOKEN=' "$ENV_FILE"; then
    # 기존 빈 줄을 치환(값에 특수문자 없으므로 안전)
    sed -i "s|^ADMIN_TOKEN=.*$|ADMIN_TOKEN=${NEW_TOKEN}|" "$ENV_FILE"
  else
    printf '\nADMIN_TOKEN=%s\n' "${NEW_TOKEN}" >> "$ENV_FILE"
  fi
  CUR_TOKEN="${NEW_TOKEN}"
  echo "    ADMIN_TOKEN 새로 발급함."
else
  echo "    기존 ADMIN_TOKEN 보존."
fi

# VAPID 키 경고(자동 생성 안 함 — PWA api.js 공개키와 짝이라 수동 동기화 필요)
if ! grep -qE '^VAPID_PUBLIC_KEY=.+' "$ENV_FILE"; then
  echo "    ⚠ VAPID_PUBLIC_KEY 비어 있음 — 푸시 쓰려면 'npm run gen:vapid' 후 .env + PWA api.js 동기화."
fi

echo "==> [5/6] 서비스 재시작"
RESTARTED=""
if command -v pm2 >/dev/null 2>&1; then
  # pm2 로 구동 중이거나 ecosystem 으로 띄울 수 있으면 pm2 사용
  pm2 reload ecosystem.config.js --update-env >/dev/null 2>&1 || pm2 start ecosystem.config.js >/dev/null 2>&1
  pm2 save >/dev/null 2>&1 || true
  RESTARTED="pm2"
elif systemctl list-unit-files 2>/dev/null | grep -q '^blog-company-backend.service'; then
  sudo systemctl restart blog-company-backend
  RESTARTED="systemd"
else
  echo "    ⚠ pm2/systemd 둘 다 감지 안 됨 — 최초 1회 설정 필요(README §3). 지금은 코드/의존성만 갱신됨."
fi
[ -n "$RESTARTED" ] && echo "    재시작 완료($RESTARTED)."

echo "==> [6/6] 헬스체크"
PORT="$(grep -E '^PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"; PORT="${PORT:-$PORT_DEFAULT}"
BASEP="$(grep -E '^BASE_PATH=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
sleep 1
if curl -fsS "http://127.0.0.1:${PORT}${BASEP}/health" >/dev/null 2>&1; then
  echo "    OK — http://127.0.0.1:${PORT}${BASEP}/health 응답함."
else
  echo "    ⚠ 헬스체크 실패 — 로그 확인: pm2 logs blog-company-backend  또는  journalctl -u blog-company-backend -f"
fi

echo ""
echo "============================================================"
echo " 재배포 완료. PC 러너(.runner.config.json)에 넣을 ADMIN_TOKEN:"
echo "   ${CUR_TOKEN}"
echo " (이 토큰은 외부에 노출하지 마세요.)"
echo "============================================================"
