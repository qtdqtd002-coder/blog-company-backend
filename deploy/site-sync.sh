#!/usr/bin/env bash
# 쓰담 사이트 사본 동기화 (2026-11-24 3단계) — systemd 타이머(sseudam-site-sync.timer)가 1분마다 부른다.
# /srv/sseudam = BlogPreview 저장소의 얕은 사본(depth 1). PC 드레이너가 GitHub 에 푸시하면 1분 안에 여기 반영된다.
# 저장소가 비공개여도 읽기 전용 배포 키(~/.ssh/sseudam_site_deploy)로 받는다.
set -euo pipefail
DIR=/srv/sseudam
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/sseudam_site_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
cd "$DIR"
old=$(git rev-parse HEAD)
git fetch -q --depth 1 origin main
new=$(git rev-parse FETCH_HEAD)
if [ "$old" != "$new" ]; then
  git reset -q --hard FETCH_HEAD
  echo "$(date -Is) $old -> $new" >> "$HOME/logs/site-sync.log"
fi
# 얕은 사본이 쌓이지 않게 하루 한 번 정리(03:00 회차)
if [ "$(date +%H%M)" = "0300" ]; then
  git reflog expire --expire=now --all && git gc -q --prune=now || true
fi
