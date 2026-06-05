'use strict';
/* stale 'processing' 회수기.
   ------------------------------------------------------------
   2b 설계(Option 2)에서 실제 작성·발행은 PC의 Claude Code 러너가 한다.
   러너가 요청을 'processing' 으로 표시한 뒤 (앱 종료/토큰 소진/세션 중단/크래시 등으로)
   완료하지 못하면, 그 요청은 'processing' 인 채로 영구히 고아가 된다
   (다음 폴링은 ?status=received 만 보므로 영영 안 잡힘).

   이 모듈은 statusAt 이 임계시간(config.reclaim.afterMs)을 넘은 'processing' 요청을:
     - attempts < maxAttempts  → 'received' 로 되돌려 재시도(다음 러너 회차가 다시 잡음)
     - attempts >= maxAttempts → 'failed' 로 종결(첨부 정리 + 사유 기록)
   로 자동 복구한다. 백엔드 node-cron(상시) 과 관리자 엔드포인트(러너 트리거) 양쪽에서 호출한다.

   attempts 는 routes.js 의 상태 갱신에서 'processing' 전환마다 +1 된다.
   임계시간은 정상 파이프라인 최대 소요보다 넉넉히 둬서, 실제로 작성 중인 요청을
   섣불리 되돌려 중복 발행하는 일을 막는다(기본 60분). */
const fs = require('fs');
const path = require('path');
const config = require('./config');

// 1회용 첨부 파일 삭제(routes.js 와 동일 동작 — 종료 상태가 되면 정리).
function deleteAttachmentFile(storedAs) {
  if (!storedAs) return;
  try { fs.unlinkSync(path.join(config.uploadDir, path.basename(String(storedAs)))); } catch (_) {}
}

/* stale processing 요청들을 한 번 훑어 복구한다.
   반환: { requeued: [id...], failed: [{id, attempts}...], checked, now } */
async function reclaimStale(store, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const afterMs = config.reclaim.afterMs;
  const maxAttempts = config.reclaim.maxAttempts;

  const all = store.requests.all();
  const result = { requeued: [], failed: [], checked: 0, now: t };

  for (const r of all) {
    if (!r || r.status !== 'processing') continue;
    result.checked += 1;
    const since = r.statusAt || r.createdAt || 0;
    if (t - since < afterMs) continue; // 아직 진행 중일 수 있음 — 건드리지 않음

    const attempts = r.attempts || 0;
    if (attempts >= maxAttempts) {
      // 반복 실패 → 종결. 1회용 첨부 정리.
      const patch = {
        status: 'failed',
        statusAt: t,
        reclaimedAt: t,
        error: `작성 에이전트 미완료로 회수 — 'processing' 상태가 ${Math.round((t - since) / 60000)}분 이상 지속(시도 ${attempts}회 초과).`,
      };
      if (r.attachment && r.attachment.storedAs && !r.attachmentDeletedAt) {
        deleteAttachmentFile(r.attachment.storedAs);
        patch.attachmentDeletedAt = t;
      }
      await store.requests.update(r.id, patch);
      result.failed.push({ id: r.id, attempts });
    } else {
      // 재시도 가능 → received 로 되돌림(첨부는 보존: 재시도에 그대로 쓰임).
      await store.requests.update(r.id, { status: 'received', statusAt: t, reclaimedAt: t });
      result.requeued.push(r.id);
    }
  }
  return result;
}

module.exports = { reclaimStale };
