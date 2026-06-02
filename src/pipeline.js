'use strict';
/* 오케스트레이션 — 러너(생성·발행) + store 갱신 + 발행완료 푸시를 묶는다.
   라우트/스케줄러는 이 모듈만 호출한다(러너/푸시 내부는 몰라도 됨). */
const runner = require('./agent/runner');
const push = require('./push');

/* 요청 1건을 끝까지 처리: 상태전이 received → processing → published/failed.
   발행 성공 시 구독자에게 '발행 완료' 푸시. (2a 에선 stub 이라 published=false → 푸시 skip) */
async function handleRequest(store, request) {
  await store.requests.update(request.id, { status: 'processing', processingAt: Date.now() });
  try {
    const result = await runner.processRequest(request);

    if (result.publish && result.publish.published) {
      await store.requests.update(request.id, {
        status: 'published',
        publishedAt: Date.now(),
        publishUrl: result.publish.url || null,
        title: result.post.title,
      });
      // ===== 발행 완료 → 푸시 발송 =====
      await notifyPublished(store, result.post, result.publish);
    } else {
      // 2a: stub → 아직 발행 안 됨. '대기' 상태로 둠(2b에서 실제 발행되면 published 로).
      await store.requests.update(request.id, {
        status: 'pending_publish',
        title: result.post.title,
        runnerMode: result.post.meta && result.post.meta.mode,
      });
    }
    return result;
  } catch (err) {
    await store.requests.update(request.id, {
      status: 'failed',
      error: String((err && err.message) || err),
      failedAt: Date.now(),
    });
    console.error('[pipeline] 요청 처리 실패:', request.id, err);
    throw err;
  }
}

/* 발행 완료 푸시 — sw.js push 핸들러 페이로드 계약: { title, body, url, tag } */
async function notifyPublished(store, post, publish) {
  const payload = {
    title: '새 글이 발행됐어요',
    body: post.title || '블로그 컴퍼니에 새 글이 올라왔어요.',
    url: publish.url || './',
    tag: 'bc-published',
  };
  return push.broadcast(store, payload);
}

module.exports = { handleRequest, notifyPublished };
