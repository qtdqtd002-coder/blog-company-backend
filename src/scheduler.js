'use strict';
/* 2시간 주기 스케줄러 골격(node-cron).
   - 신작 글 자동 생성 트리거 자리. 2a 에선 runner.autoGenerate() stub 호출만.
   - AUTO_GEN_ENABLED=false 면 스케줄 등록은 하되 실행 시 skip(안전 기본값). */
const cron = require('node-cron');
const config = require('./config');
const runner = require('./agent/runner');
const reclaim = require('./reclaim');

let task = null;
let reclaimTask = null;

function start(store) {
  // ---- stale 'processing' 회수 스윕 (상시 동작 — autoGen 과 무관) ----
  // 작성 러너(PC)가 처리 중 중단돼 'processing' 에 박힌 요청을 주기적으로 복구한다.
  const rexpr = config.reclaim.sweepCron;
  if (cron.validate(rexpr)) {
    reclaimTask = cron.schedule(rexpr, async () => {
      try {
        const res = await reclaim.reclaimStale(store);
        if (res.requeued.length || res.failed.length) {
          console.log(`[reclaim] stale processing 회수 — 재시도(received)=${res.requeued.length}, 종결(failed)=${res.failed.length}`);
        }
      } catch (err) {
        console.error('[reclaim] 스윕 실패:', err);
      }
    });
    console.log(`[reclaim] 등록됨: "${rexpr}" (afterMs=${config.reclaim.afterMs}, maxAttempts=${config.reclaim.maxAttempts})`);
  } else {
    console.error(`[reclaim] 잘못된 cron 식: "${rexpr}" → 회수 스윕 비활성화.`);
  }

  // ---- 자동 신작 생성 트리거(기존 골격, AUTO_GEN_ENABLED 로 게이트) ----
  const expr = config.scheduler.autoGenCron;
  if (!cron.validate(expr)) {
    console.error(`[scheduler] 잘못된 cron 식: "${expr}" → 자동생성 스케줄러 비활성화.`);
    return reclaimTask;
  }
  task = cron.schedule(expr, async () => {
    if (!config.scheduler.autoGenEnabled) {
      console.log('[scheduler] tick — AUTO_GEN_ENABLED=false 라 skip.');
      return;
    }
    try {
      // 2b: autoGenerate() 가 주제 선정 후 pipeline.handleRequest 로 이어지도록 확장.
      await runner.autoGenerate(store);
    } catch (err) {
      console.error('[scheduler] autoGenerate 실패:', err);
    }
  });
  console.log(`[scheduler] 등록됨: "${expr}" (자동생성 enabled=${config.scheduler.autoGenEnabled})`);
  return task;
}

function stop() {
  if (task) { task.stop(); task = null; }
  if (reclaimTask) { reclaimTask.stop(); reclaimTask = null; }
}

module.exports = { start, stop };
