'use strict';
/* API 라우트 — PWA app/api.js 의 BC_CONFIG 계약과 1:1 일치.
   계약:
     POST {base}/requests        body={topic, material, writer, purpose}  → 201 {id, status, purpose}
                                 (또는 multipart/form-data: 동일 필드 + attachment=파일 1개)
                                 purpose=글의 목적(post-purpose-guide.md 라벨). 알 수 없으면 '기타'로 정규화.
     GET  {base}/requests        → 200 [{id, topic, material, writer, purpose, status, createdAt, attachment?, ...}]
     GET  {base}/requests/:id/attachment  (관리자) → 첨부 파일 다운로드(작성 러너용, 1회용)
     GET  {base}/health          → 200 {ok, ...}
     POST {base}/push/subscribe  body=PushSubscription(JSON)      → 201 {ok}
   (추가) POST {base}/push/test  → 구독자에게 테스트 푸시(운영 확인용)              */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('./config');
const push = require('./push');
const runner = require('./agent/runner');

function genId(prefix) {
  // 시간순 정렬 가능한 짧은 ID (crypto 난수 6바이트)
  const rnd = require('crypto').randomBytes(6).toString('hex');
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

// 확장자만 소문자로 추출(점 제외).
function extOf(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}
// multer 의 originalname 은 latin1 로 디코드되어 한글이 깨진다 → utf8 로 복원.
function fixName(name) {
  try { return Buffer.from(String(name || ''), 'latin1').toString('utf8'); } catch (_) { return String(name || ''); }
}

// ---- 첨부(외주 1회용 참고문서) 업로드 설정 ----
fs.mkdirSync(config.uploadDir, { recursive: true });
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  // 저장명은 우리가 생성(사용자 입력 미사용 → 경로조작 불가). 확장자만 유지.
  filename: (req, file, cb) => { const e = extOf(file.originalname); cb(null, genId('att') + (e ? '.' + e : '')); },
});
function attachFilter(req, file, cb) {
  const e = extOf(file.originalname);
  if (!config.attachment.allowedExt.includes(e)) {
    const err = new Error('허용되지 않은 첨부 형식: .' + (e || '?') + ' (허용: ' + config.attachment.allowedExt.join(', ') + ')');
    err.code = 'ATTACH_TYPE';
    return cb(err);
  }
  cb(null, true);
}
const uploader = multer({ storage: uploadStorage, fileFilter: attachFilter, limits: { fileSize: config.attachment.maxBytes, files: 1 } });
// multipart 가 아니면 통과, multipart 면 'attachment' 1개 파싱. 에러는 400 으로 정규화.
function attachmentUpload(req, res, next) {
  uploader.single('attachment')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? '첨부가 너무 큽니다(최대 ' + Math.round(config.attachment.maxBytes / 1024 / 1024) + 'MB).'
        : err.code === 'ATTACH_TYPE' ? err.message
        : '첨부 처리 오류: ' + err.message;
      return res.status(400).json({ error: msg });
    }
    next();
  });
}
// 저장 파일 삭제(1회용 문서 정리). storedAs 는 basename 으로 한정.
function deleteAttachmentFile(storedAs) {
  if (!storedAs) return;
  try { fs.unlinkSync(path.join(config.uploadDir, path.basename(String(storedAs)))); } catch (_) {}
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

  // ---- 발행 요청 수신 (JSON 또는 multipart[+첨부]) ----
  r.post('/requests', attachmentUpload, async (req, res) => {
    const body = req.body || {};
    const topic = (body.topic || '').toString().trim();
    const material = (body.material || '').toString().trim();
    let writer = (body.writer || '').toString().trim();
    let purpose = (body.purpose || '').toString().trim();
    if (!topic) {
      if (req.file) deleteAttachmentFile(req.file.filename); // 검증 실패 시 업로드 파일 정리
      return res.status(400).json({ error: 'topic(주제)은 필수입니다.' });
    }
    if (writer && !runner.WRITERS.includes(writer)) {
      writer = ''; // 알 수 없는 작성자는 미지정 처리(거부하지 않음)
    }
    // 글의 목적: 정본 라벨이 아니면 '기타'로 정규화(거부하지 않음). 빈 값(옛 클라이언트)은 null.
    if (purpose && !runner.PURPOSES.includes(purpose)) {
      purpose = runner.DEFAULT_PURPOSE;
    }
    const rec = {
      id: genId('req'),
      topic,
      material,
      writer: writer || null,
      purpose: purpose || null,
      status: 'received',
      createdAt: Date.now(),
      source: (body.source || 'pwa').toString().slice(0, 32),
    };
    // 첨부(외주 1회용 참고문서) — 메타만 기록, 파일은 uploads/ 에. 작성 러너가 받아 '이 글에만' 반영.
    if (req.file) {
      const name = fixName(req.file.originalname).slice(0, 200);
      rec.attachment = { name, storedAs: req.file.filename, type: extOf(name), size: req.file.size };
    }
    await store.requests.insert(rec);

    // 2b 설계(Option 2): VM 은 접수만 한다('received'로 큐잉).
    // 실제 작성·발행은 PC의 Claude Code 예약 러너가 GET /requests?status=received 로
    // 가져가 game-blog-publish 파이프라인으로 처리한 뒤, POST /requests/:id/status 로 상태를 갱신한다.
    res.status(201).json({ id: rec.id, status: rec.status, purpose: rec.purpose, attachment: rec.attachment ? rec.attachment.name : null });
  });

  // ---- 첨부 다운로드 (관리자: 작성 러너가 1회용 문서를 받아간다) ----
  r.get('/requests/:id/attachment', requireAdmin, (req, res) => {
    const rec = store.requests.find((x) => x.id === req.params.id);
    if (!rec || !rec.attachment) return res.status(404).json({ error: '해당 요청에 첨부 없음' });
    const fp = path.join(config.uploadDir, path.basename(rec.attachment.storedAs));
    if (!fs.existsSync(fp)) return res.status(410).json({ error: '첨부가 이미 삭제됨(1회용 — 발행/실패 처리 후 정리됨).' });
    res.download(fp, rec.attachment.name);
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

    // 1회용 첨부 정리: 종료 상태가 되면 업로드 파일을 삭제(문서는 해당 글에만 쓰이고 폐기).
    if (['published', 'failed', 'skipped'].includes(status)) {
      const cur = store.requests.find((x) => x.id === id);
      if (cur && cur.attachment && cur.attachment.storedAs && !cur.attachmentDeletedAt) {
        deleteAttachmentFile(cur.attachment.storedAs);
        patch.attachmentDeletedAt = Date.now();
      }
    }

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
