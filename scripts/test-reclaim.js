'use strict';
/* reclaim.js 단위 검증 — 임시 데이터 디렉터리로 stale-processing 회수 동작 확인.
   실행: node scripts/test-reclaim.js  (성공 시 exit 0, 실패 시 exit 1) */
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcrec-'));

const config = require('../src/config');
config.dataDir = tmp;
config.uploadDir = path.join(tmp, 'uploads');
config.reclaim.afterMs = 1000;      // 테스트용 1초 임계
config.reclaim.maxAttempts = 3;

const { initStore } = require('../src/store');
const reclaim = require('../src/reclaim');

(async () => {
  const store = initStore(tmp);
  const now = Date.now();
  await store.requests.insert({ id: 'r1', status: 'processing', statusAt: now, attempts: 1, createdAt: now });                 // fresh → 유지
  await store.requests.insert({ id: 'r2', status: 'processing', statusAt: now - 5000, attempts: 1, createdAt: now - 9000 });   // stale att1 → received
  await store.requests.insert({ id: 'r3', status: 'processing', statusAt: now - 5000, attempts: 3, createdAt: now - 9000, attachment: { storedAs: 'nope.txt' } }); // stale att3 → failed
  await store.requests.insert({ id: 'r4', status: 'received', statusAt: now - 5000, createdAt: now - 9000 });                  // received → 무관

  await new Promise((r) => setTimeout(r, 50));
  const res = await reclaim.reclaimStale(store);
  await new Promise((r) => setTimeout(r, 50));

  const byId = Object.fromEntries(store.requests.all().map((x) => [x.id, x]));
  console.log('reclaim result:', JSON.stringify(res));
  console.log('r1(fresh)       =', byId.r1.status, '(expect processing)');
  console.log('r2(stale,att1)  =', byId.r2.status, '(expect received)');
  console.log('r3(stale,att3)  =', byId.r3.status, 'err=', !!byId.r3.error, '(expect failed)');
  console.log('r4(received)    =', byId.r4.status, '(expect received)');

  const ok =
    byId.r1.status === 'processing' &&
    byId.r2.status === 'received' &&
    byId.r3.status === 'failed' && !!byId.r3.error &&
    byId.r4.status === 'received' &&
    res.requeued.length === 1 && res.failed.length === 1;

  console.log(ok ? 'PASS ✅' : 'FAIL ❌');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
