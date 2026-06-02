'use strict';
/* 2시간 주기 스케줄러 골격(node-cron).
   - 신작 글 자동 생성 트리거 자리. 2a 에선 runner.autoGenerate() stub 호출만.
   - AUTO_GEN_ENABLED=false 면 스케줄 등록은 하되 실행 시 skip(안전 기본값). */
const cron = require('node-cron');
const config = require('./config');
const runner = require('./agent/runner');

let task = null;

function start(store) {
  const expr = config.scheduler.autoGenCron;
  if (!cron.validate(expr)) {
    console.error(`[scheduler] 잘못된 cron 식: "${expr}" → 스케줄러 비활성화.`);
    return null;
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
}

module.exports = { start, stop };
