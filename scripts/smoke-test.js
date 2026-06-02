'use strict';
/* 스모크 테스트 — 서버 없이 핵심 모듈 로직만 빠르게 검증한다.
   사용:  npm run smoke   (의존성 설치 후)
   - store insert/list/upsert/remove
   - routes 계약(POST/GET /requests, /health) via supertest 없이 express 직접 호출은 생략,
     여기선 순수 로직(store, runner)만 확인. 통합 검증은 README 의 curl 절차 참고. */
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-smoke-'));
process.env.PORT = '0';

const { initStore } = require('../src/store');
const runner = require('../src/agent/runner');

(async () => {
  const store = initStore(tmp);

  // store
  await store.requests.insert({ id: 'a', topic: 't', createdAt: 1, status: 'received' });
  await store.requests.insert({ id: 'b', topic: 'u', createdAt: 2, status: 'received' });
  assert.strictEqual(store.requests.all().length, 2, 'insert 2건');
  await store.requests.update('a', { status: 'processing' });
  assert.strictEqual(store.requests.find((r) => r.id === 'a').status, 'processing', 'update');

  // subscriptions upsert(endpoint 중복 방지)
  await store.subscriptions.upsertBy((x) => x.endpoint, { id: 's1', endpoint: 'E1' });
  await store.subscriptions.upsertBy((x) => x.endpoint, { id: 's2', endpoint: 'E1' });
  assert.strictEqual(store.subscriptions.all().length, 1, 'upsert 중복 1건');
  const removed = await store.subscriptions.removeBy((x) => x.endpoint === 'E1');
  assert.strictEqual(removed, 1, 'removeBy 1건');

  // runner stub 처리
  const result = await runner.processRequest({ id: 'a', topic: 't', material: 'm', writer: '봄딩' });
  assert.ok(result.post && result.post.title, 'runner: post 생성');
  assert.strictEqual(result.publish.published, false, 'runner: 2a 는 발행 stub(false)');

  // 정리
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ smoke-test 통과 (store + runner stub)');
})().catch((err) => {
  console.error('✗ smoke-test 실패:', err);
  process.exit(1);
});
