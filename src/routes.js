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
const pipeline = require('./pipeline');
const runner = require('./agent/runner');

function genId(prefix) {
  // 시간순 정렬 가능한 짧은 ID (crypto 난수 6바이트)
  const rnd = require('crypto').randomBytes(6).toString('hex');
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

function buildRouter(store) {
  const r = express.Router();

  // ---- 헬스체크 ----
  r.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'blog-company-backend',
      version: require('../package.json').version,
      time: new Date().toISOString(),
      push: push.isEnabled(),
      agentLive: config.agent.live,
      autoGen: config.scheduler.autoGenEnabled,
      counts: {
        requests: store.requests.all().length,
        subscriptions: store.subscriptions.all().length,
      },
    });
  });

  // ---- 발행 요청 목록 ----
  r.get('/requests', (req, res) => {
    const list = store.requests.all().sort((a, b) => b.createdAt - a.createdAt);
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

    // 응답은 즉시(계약: {id}). 처리는 백그라운드(2a 는 stub 파이프라인).
    pipeline.handleRequest(store, rec).catch((err) => {
      console.error('[routes] 백그라운드 처리 오류:', rec.id, err);
    });

    res.status(201).json({ id: rec.id, status: rec.status });
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

  // ---- (운영 확인용) 테스트 푸시 ----
  r.post('/push/test', async (req, res) => {
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
