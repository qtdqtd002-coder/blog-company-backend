'use strict';
/* API 라우트 — PWA app/api.js 의 BC_CONFIG 계약과 1:1 일치.
   계약:
     POST {base}/requests        body={topic, material, writer, purpose}  → 201 {id, status, purpose}
                                 (또는 multipart/form-data: 동일 필드 + attachment=파일 1개)
                                 purpose=글의 목적(post-purpose-guide.md 라벨). 알 수 없으면 '기타'로 정규화.
     GET  {base}/requests        → 200 [{id, topic, material, writer, purpose, status, createdAt, attachment?, ...}]
     POST {base}/requests/:id/cancel  body={by?} → 200 {ok, request} (요청자 취소 — 'received'만, 토큰 불필요)
     GET  {base}/requests/:id/attachment  (관리자) → 첨부 파일 다운로드(작성 러너용, 1회용)
     GET  {base}/hidden          → 200 {rels:[...]}                (숨김된 글 rel 목록 — 토큰 불필요)
     POST {base}/hidden          body={rel, by?}   → 201 {ok, rels} (즉시 숨김 — 토큰 불필요)
     POST {base}/hidden/unhide   body={rel}        → 200 {ok, rels} (숨김 해제 — 토큰 불필요)
     GET  {base}/mpub            → 200 {rels:[...]}                (수동 발행완료 rel 목록 — 토큰 불필요)
     POST {base}/mpub            body={rel, by?}   → 201 {ok, rels} (발행완료 표시 — 토큰 불필요)
     POST {base}/mpub/unpub      body={rel}        → 200 {ok, rels} (발행완료 취소 — 토큰 불필요)
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
const reclaim = require('./reclaim');

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
    const reqs = store.requests.all();
    const now = Date.now();
    // 임계시간 넘게 'processing' 인 요청 수(고아 후보) — 모니터링용.
    const stuckProcessing = reqs.filter(
      (x) => x.status === 'processing' && now - (x.statusAt || x.createdAt || 0) >= config.reclaim.afterMs
    ).length;
    res.json({
      ok: true,
      service: 'blog-company-backend',
      version: require('../package.json').version,
      time: new Date().toISOString(),
      mode: 'queue', // 2b Option 2: VM은 큐(접수)만, 작성·발행은 외부 러너
      push: push.isEnabled(),
      adminConfigured: !!config.adminToken,
      counts: {
        requests: reqs.length,
        subscriptions: store.subscriptions.all().length,
        processing: reqs.filter((x) => x.status === 'processing').length,
        stuckProcessing,
      },
      reclaim: { afterMs: config.reclaim.afterMs, maxAttempts: config.reclaim.maxAttempts, sweepCron: config.reclaim.sweepCron },
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
    // ★휴면 작성자(2026-08-14): 겜더쿠·연봄은 발행을 중단했다. 조용히 다른 작성자로 바꾸지 않고 명시적으로 거절한다
    // (자동 배정으로 넘기면 요청자가 원하지 않은 블로그에 글이 올라간다).
    if (writer && runner.INACTIVE_WRITERS.includes(writer)) {
      if (req.file) deleteAttachmentFile(req.file.filename);
      return res.status(400).json({ error: `'${writer}' 작성자는 현재 휴면 상태라 새 글 요청을 받지 않습니다.` });
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

  // ====================================================================
  //  숨김(hide) — 글 rel 단위 소프트 숨김. admin 토큰 불필요(누구나 즉시 숨김/해제).
  //  설계: 실제 파일·발행은 건드리지 않고 목록에서만 가린다(가역). 사이트·PWA가
  //        GET /hidden 으로 목록을 받아 해당 rel 을 거른다. 깃 권한이 없는 사람도
  //        모두에게 숨길 수 있게 하기 위함(삭제는 여전히 GitHub 토큰=관리자 전용).
  //  안전: rel 은 문자열 키일 뿐(파일 경로로 사용 안 함) → 경로조작 위험 없음.
  //        디스크 보호용으로 총 숨김 수에 상한을 둔다.
  // ====================================================================
  const HIDDEN_MAX = 5000;       // 저장 상한(악의적 폭주 시 디스크 보호)
  function cleanRel(v) { return String(v == null ? '' : v).trim().slice(0, 500); }

  // 현재 숨김 rel 목록(문자열 배열) — 사이트·PWA 가 로드 시 호출.
  r.get('/hidden', (req, res) => {
    const rels = store.hidden.all().map((x) => x.rel).filter(Boolean);
    res.json({ rels });
  });

  // 숨김 추가(즉시) — body { rel, by? }. 이미 있으면 멱등(중복 추가 안 함).
  r.post('/hidden', async (req, res) => {
    const body = req.body || {};
    const rel = cleanRel(body.rel);
    if (!rel) return res.status(400).json({ error: 'rel(글 경로)은 필수입니다.' });
    const exists = store.hidden.find((x) => x.rel === rel);
    if (!exists) {
      if (store.hidden.all().length >= HIDDEN_MAX) {
        return res.status(429).json({ error: '숨김 목록이 한도에 도달했습니다.' });
      }
      await store.hidden.insert({
        id: genId('hid'),
        rel,
        by: (body.by ? String(body.by).slice(0, 64) : null),
        source: (body.source || 'web').toString().slice(0, 32),
        hiddenAt: Date.now(),
      });
    }
    const rels = store.hidden.all().map((x) => x.rel).filter(Boolean);
    res.status(201).json({ ok: true, rel, already: !!exists, rels });
  });

  // 숨김 해제(즉시) — body { rel }. admin 토큰 불필요(누구나 해제 — 사용자 결정).
  r.post('/hidden/unhide', async (req, res) => {
    const rel = cleanRel((req.body || {}).rel);
    if (!rel) return res.status(400).json({ error: 'rel(글 경로)은 필수입니다.' });
    const removed = await store.hidden.removeBy((x) => x.rel === rel);
    const rels = store.hidden.all().map((x) => x.rel).filter(Boolean);
    res.json({ ok: true, rel, removed, rels });
  });

  // ====================================================================
  //  수동 발행완료(manual published) — 숨김과 동일 구조. admin 토큰 불필요(누구나 표시/취소).
  //  자동검증 발행(깃 published.json)과 별개의 소프트 '발행됨' 플래그. 사이트·PWA가 union 한다.
  //  삭제만 여전히 GitHub 토큰=관리자 전용(사용자 결정).
  // ====================================================================
  const MPUB_MAX = 5000;

  // 현재 수동 발행완료 rel 목록 — 사이트·PWA 가 로드 시 호출.
  r.get('/mpub', (req, res) => {
    const rels = store.mpub.all().map((x) => x.rel).filter(Boolean);
    res.json({ rels });
  });

  // 발행완료 표시(즉시) — body { rel, by? }. 이미 있으면 멱등.
  r.post('/mpub', async (req, res) => {
    const body = req.body || {};
    const rel = cleanRel(body.rel);
    if (!rel) return res.status(400).json({ error: 'rel(글 경로)은 필수입니다.' });
    const exists = store.mpub.find((x) => x.rel === rel);
    if (!exists) {
      if (store.mpub.all().length >= MPUB_MAX) {
        return res.status(429).json({ error: '발행완료 목록이 한도에 도달했습니다.' });
      }
      await store.mpub.insert({
        id: genId('mpub'),
        rel,
        by: (body.by ? String(body.by).slice(0, 64) : null),
        source: (body.source || 'web').toString().slice(0, 32),
        markedAt: Date.now(),
      });
    }
    const rels = store.mpub.all().map((x) => x.rel).filter(Boolean);
    res.status(201).json({ ok: true, rel, already: !!exists, rels });
  });

  // 발행완료 취소(즉시) — body { rel }. admin 토큰 불필요(누구나 취소).
  r.post('/mpub/unpub', async (req, res) => {
    const rel = cleanRel((req.body || {}).rel);
    if (!rel) return res.status(400).json({ error: 'rel(글 경로)은 필수입니다.' });
    const removed = await store.mpub.removeBy((x) => x.rel === rel);
    const rels = store.mpub.all().map((x) => x.rel).filter(Boolean);
    res.json({ ok: true, rel, removed, rels });
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
    // 'processing' 전환마다 시도 횟수 +1 — 회수기(reclaim)가 무한 재시도를 막는 데 쓴다.
    if (status === 'processing') {
      const cur = store.requests.find((x) => x.id === id);
      patch.attempts = ((cur && cur.attempts) || 0) + 1;
    }
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
    } else if (status === 'failed' || status === 'skipped') {
      // 실패·스킵도 요청자에게 알린다 — 사유(error)가 유일한 피드백 채널이므로 본문에 싣는다.
      const reason = updated.error ? ` — ${updated.error}` : '';
      pushResult = await push.broadcast(store, {
        title: '요청하신 글을 발행하지 못했어요',
        body: `"${updated.topic || updated.title || '요청'}"${reason}`.slice(0, 500),
        url: './',
        tag: 'bc-failed',
      });
    }
    res.json({ ok: true, request: updated, push: pushResult });
  });

  // ---- 요청 취소(삭제) — 요청자가 큐에서 뺀다. 토큰 불필요(hidden/mpub 와 동일 정책). ----
  //  설계: 아직 시작 안 한('received') 요청만 취소 가능 → status='skipped', error='요청자 취소'.
  //        이미 'processing'(러너가 작성 중)/'published'/'failed'/'skipped' 는 취소 불가(409).
  //        러너가 ?status=received 만 가져가므로 skipped 는 자동으로 큐에서 빠진다.
  //        상태 갱신 엔드포인트와 달리 푸시를 보내지 않는다(요청자 본인의 취소이므로).
  r.post('/requests/:id/cancel', async (req, res) => {
    const id = req.params.id;
    const cur = store.requests.find((x) => x.id === id);
    if (!cur) return res.status(404).json({ error: '해당 id 요청 없음' });
    if (cur.status !== 'received') {
      return res.status(409).json({ error: '이미 ' + cur.status + ' 상태라 취소할 수 없습니다(접수 대기 중인 요청만 취소 가능).', status: cur.status });
    }
    const by = (req.body && req.body.by ? String(req.body.by).slice(0, 64) : null);
    const patch = { status: 'skipped', statusAt: Date.now(), error: '요청자 취소' + (by ? ' (' + by + ')' : '') };
    // 1회용 첨부 정리
    if (cur.attachment && cur.attachment.storedAs && !cur.attachmentDeletedAt) {
      deleteAttachmentFile(cur.attachment.storedAs);
      patch.attachmentDeletedAt = Date.now();
    }
    const updated = await store.requests.update(id, patch);
    res.json({ ok: true, request: updated });
  });

  // ---- stale 'processing' 즉시 회수 (관리자: 러너가 회차 시작 때 호출) ----
  // 백엔드 크론(기본 10분)과 동일한 로직을 수동으로 1회 트리거한다.
  // 작성 러너가 중단돼 'processing' 에 박힌 요청을 received(재시도)/failed(종결)로 복구.
  r.post('/requests/reclaim', requireAdmin, async (req, res) => {
    const result = await reclaim.reclaimStale(store);
    res.json({ ok: true, requeued: result.requeued, failed: result.failed, checked: result.checked });
  });

  // ====================================================================
  //  점검(maintenance) 상태 — 앱·사이트 '작업 큐' 배너용.
  //  설계: PC의 쓰담 스킬 수정 잠금(.bc-locks)이 활성이면 on-skill-edit 훅이 POST /maintenance 로
  //        active=true(+ttlMs)를 켠다. 스킬 편집이 멈추면 더 통지가 없고, since+ttlMs 가 지나면
  //        GET 에서 자동으로 active=false 로 계산된다(명시적 해제 불필요 — PC가 죽어도 안 박힘).
  //        동시발행 직렬화(mutex)는 '점검'이 아니므로 여기서 다루지 않는다(스킬 수정만 점검).
  //  GET 은 공개(누구나 큐 화면에서 읽음), POST 는 관리자(PC 훅).
  // ====================================================================
  function maintenanceState() {
    const rec = store.maintenance.find((x) => x.id === 'maint');
    const now = Date.now();
    let live = !!(rec && rec.active && rec.since && (now - rec.since) < (rec.ttlMs || 0));
    // ★발행중(processing)인 요청이 있으면 점검 배너를 띄우지 않는다 — 실제로 발행이 진행 중이므로
    //   '발행 일시 중단' 문구는 모순이 된다(사용자 지시 2026-06-15).
    if (live && store.requests.all().some((r) => r && r.status === 'processing')) live = false;
    return {
      active: live,
      reason: live ? (rec.reason || '점검 중') : null,
      since: live ? rec.since : null,
      until: live ? rec.since + rec.ttlMs : null,
    };
  }
  r.get('/maintenance', (req, res) => res.json(maintenanceState()));
  r.post('/maintenance', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const active = !!body.active;
    // ttl: 1분~6시간 사이로 강제(기본 10분 = 스킬락 TTL과 일치).
    const ttlMs = Math.min(Math.max(parseInt(body.ttlMs, 10) || 600000, 60000), 6 * 60 * 60 * 1000);
    const reason = (body.reason ? String(body.reason) : '점검 중').slice(0, 200);
    const rec = { id: 'maint', active, reason, ttlMs, since: active ? Date.now() : 0, updatedAt: Date.now() };
    await store.maintenance.upsertBy((x) => x.id, rec);
    res.json({ ok: true, state: maintenanceState() });
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
