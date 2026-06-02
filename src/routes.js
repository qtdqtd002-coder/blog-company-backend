'use strict';
/* API 라우트 — PWA app/api.js 의 BC_CONFIG 계약과 1:1 일치.
   계약:
     POST {base}/requests        body={topic, material, writer}  → 201 {id, status}
     GET  {base}/requests        → 200 [{id, topic, material, writer, status, createdAt, ...}]
     GET  {base}/health          → 200 {ok, ...}
     POST {base}/push/subscribe  body=PushSubscription(JSON)      → 201 {ok}
   (추가) POST {base}/push/test  → 구독자에게 테스트 푸시(운영 확인용)              */
const express = require('express');
const config = require('./config');
const push = require('./push');
const runner = require('./agent/runner');

function genId(prefix) {
  // 시간순 정렬 가능한 짧은 ID (crypto 난수 6바이트)
  const rnd = require('crypto').randomBytes(6).toString('hex');
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

function buildRouter(store) {
  const r = express.Router();

  // 관리자 인증 미들웨어 — X-Admin-Token 헤더가 .env 의 ADMIN_TOKEN 과 일치해야 통과.
  // ADMIN_TOKEN 미설정 시 잠금(503)으로 fail-closed(실수로 무방비 노출 방지).
  function requireAdmin(req, res, next) {
    if (!config.adminToken) {
      return res.status(503).json({ error: '서버에 ADMIN_TOKEN 미설정 — 관리자 엔드포인트 잠김.' });
    }
    const tok = req.get('X-Admin-Token') || '';
    if (tok !== config.adminToken) {
      return res.status(401).json({ error: '관리자 토큰 불일치.' });
    }
    next();
  }

  // ---- 헬스체크 ----
  r.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'blog-company-backend',
      version: require('../package.json').version,
      time: new Date().toISOString(),
      mode: 'queue', // 2b Option 2: VM은 큐(접수)만, 작성·발행은 외부 러너
      push: push.isEnabled(),
      adminConfigured: !!config.adminToken,
      counts: {
        requests: store.requests.all().length,
        subscriptions: store.subscriptions.all().length,
      },
    });
  });

  // ---- 발행 요청 목록 (?status= 로 필터: 예 ?status=received) ----
  r.get('/requests', (req, res) => {
    let list = store.requests.all().sort((a, b) => b.createdAt - a.createdAt);
    const status = (req.query.status || '').toString().trim();
    if (status) list = list.filter((x) => x.status === status);
    res.json(list);
  });

  // ---- 발행 요청 수신 ----
  r.post('/requests', async (req, res) => {
    const body = req.body || {};
    const topic = (body.topic || '').toString().trim();
    const material = (body.material || '').toString().trim();
    let writer = (body.writer || '').toString().trim();
    if (!topic) {
      return res.status(400).json({ error: 'topic(주제)은 필수입니다.' });
    }
    if (writer && !runner.WRITERS.includes(writer)) {
      writer = ''; // 알 수 없는 작성자는 미지정 처리(거부하지 않음)
    }
    const rec = {
      id: genId('req'),
      topic,
      material,
      writer: writer || null,
      status: 'received',
      createdAt: Date.now(),
      source: (body.source || 'pwa').toString().slice(0, 32),
    };
    await store.requests.insert(rec);

    // 2b 설계(Option 2): VM 은 접수만 한다('received'로 큐잉).
    // 실제 작성·발행은 PC의 Claude Code 예약 러너가 GET /requests?status=received 로
    // 가져가 game-blog-publish 파이프라인으로 처리한 뒤, POST /requests/:id/status 로 상태를 갱신한다.
    res.status(201).json({ id: rec.id, status: rec.status });
  });

  // ---- 요청 상태 갱신 (관리자: 작성 러너가 호출) ----
  // body: { status, title?, publishUrl?, postRel?, error? }
  // status 가 'published' 가 되면 구독자에게 발행 완료 푸시를 보낸다.
  const VALID_STATUS = ['received', 'processing', 'published', 'failed', 'skipped'];
  r.post('/requests/:id/status', requireAdmin, async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const status = (body.status || '').toString().trim();
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: 'status 는 ' + VALID_STATUS.join('|') + ' 중 하나' });
    }
    const patch = { status, statusAt: Date.now() };
    if (body.title != null) patch.title = String(body.title).slice(0, 300);
    if (body.publishUrl != null) patch.publishUrl = String(body.publishUrl).slice(0, 500);
    if (body.postRel != null) patch.postRel = String(body.postRel).slice(0, 500);
    if (body.error != null) patch.error = String(body.error).slice(0, 1000);

    const updated = await store.requests.update(id, patch);
    if (!updated) return res.status(404).json({ error: '해당 id 요청 없음' });

    let pushResult = null;
    if (status === 'published') {
      pushResult = await push.broadcast(store, {
        title: '요청하신 글이 발행됐어요',
        body: updated.title || updated.topic || '블로그 컴퍼니에 새 글이 올라왔어요.',
        url: updated.publishUrl || './',
        tag: 'bc-published',
      });
    }
    res.json({ ok: true, request: updated, push: pushResult });
  });

  // ---- 푸시 구독 저장 ----
  r.post('/push/subscribe', async (req, res) => {
    const sub = req.body || {};
    if (!sub || !sub.endpoint) {
      return res.status(400).json({ error: 'endpoint 가 없는 구독 객체입니다.' });
    }
    const rec = {
      id: genId('sub'),
      endpoint: sub.endpoint,
      subscription: sub,            // 원본 PushSubscription(JSON) 전체 보관
      createdAt: Date.now(),
      ua: (req.headers['user-agent'] || '').slice(0, 200),
    };
    // endpoint 기준 upsert(중복 구독 방지)
    await store.subscriptions.upsertBy((x) => x.endpoint, rec);
    res.status(201).json({ ok: true });
  });

  // ---- (선택) 구독 해지 ----
  r.post('/push/unsubscribe', async (req, res) => {
    const endpoint = (req.body && req.body.endpoint) || '';
    if (!endpoint) return res.status(400).json({ error: 'endpoint 필요' });
    const removed = await store.subscriptions.removeBy((x) => x.endpoint === endpoint);
    res.json({ ok: true, removed });
  });

  // ---- (운영 확인용) 테스트 푸시 — 관리자 전용(전체 구독자에게 발송되므로) ----
  r.post('/push/test', requireAdmin, async (req, res) => {
    if (!push.isEnabled()) {
      return res.status(503).json({ error: '푸시 비활성화(VAPID 키 미설정).' });
    }
    const result = await push.broadcast(store, {
      title: '테스트 알림',
      body: (req.body && req.body.body) || '블로그 컴퍼니 백엔드 푸시 테스트입니다.',
      url: './',
      tag: 'bc-test',
    });
    res.json({ ok: true, result });
  });

  return r;
}

module.exports = { buildRouter };
