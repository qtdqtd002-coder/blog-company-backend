'use strict';
/* 외주 일감 캘린더(cal) — 봄딩·영도 각자의 외주 일감(게임·외주업체·단가·완료)을 날짜별로 담는다. 2026-09-28 신설.
   사이트(BlogPreview) 「캘린더」 탭이 쓰고, 월·연 수입(3.3% 원천징수 제외) 계산은 사이트가 한다(서버는 원장만).

   왜 서버인가: 사이트는 PC·폰(PWA) 두 곳에서 쓰는데 브라우저 저장은 기기마다 따로다(연봄하우스가 같은 이유로 서버로 옮겼다).
   왜 이 경로만 암호인가: 단가·수입은 금액 정보다. 이 서버 주소는 ① 공개 사이트 코드(index.html CFG.API_BASE)
     ② 공개 깃허브 저장소 둘(사이트·이 백엔드) ③ 공개 인증서 로그(crt.sh)에 이미 실려 있어 «주소를 숨기는» 방식으로는
     못 막는다(2026-09-28 실측). 그래서 토큰 없는 다른 공유 상태(hidden·mpub·pins·why·topic)와 달리 여기만 잠근다.
     암호는 하나(봄딩·영도 달력 공용 — 사용자 결정 2026-09-28). 서버엔 scrypt 해시만, 기기에는 암호가 아니라 토큰만 남는다.

   계약 (인증 = 헤더 X-Cal-Token: <토큰> 또는 X-Admin-Token: <관리자 토큰>):
     GET    {base}/cal/auth                        → {set}                   암호가 정해졌는가(토큰 불필요)
     POST   {base}/cal/auth/setup   {pass}         → 201 {token}             처음 한 번만. 이미 있으면 409
     POST   {base}/cal/auth/login   {pass}         → 200 {token} | 401 | 429 틀리면 IP당 15분에 8회까지
     POST   {base}/cal/auth/logout                 → 200                     이 기기 토큰 폐기
     POST   {base}/cal/auth/reset   (관리자)        → 200                     암호·토큰 전부 지움(암호를 잊었을 때)
     GET    {base}/cal/export       (관리자)        → {at, entries}           전체 원장(백업용)
     GET    {base}/cal/:writer                      → {writer, name, entries} writer = bomding | yeongdo
     PUT    {base}/cal/:writer/:id  {date, game, agency, price, done, memo, base?}
                                                   → 201(새로)·200(고침) {ok, entry} | 409 {error, entry}
     DELETE {base}/cal/:writer/:id?base=<updatedAt> → 200 {ok} | 404 | 409

   동시성: 기기 두 대가 같은 일감을 고치면 «나중에 도착한 쪽»이 조용히 덮는 게 가장 나쁜 실패다
     (연봄하우스 2026-08-16 기록 유실과 같은 종류 — 오류 0, 그냥 사라진다). 그래서 고칠 때는 클라이언트가
     자기가 본 판(base = updatedAt)을 같이 보내고, 서버의 판이 그새 바뀌었으면 409 + 최신 판을 돌려준다.
     새로 만드는 일감은 id 를 클라이언트가 만들어 오므로(재시도 멱등) base 없이 온다.
   안전망: 그날 첫 쓰기 직전에 원장 전체를 data/cal-history/cal-YYYY-MM-DD.json(KST)으로 떠 둔다(90일 보관). */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const WRITERS = { bomding: '봄딩', yeongdo: '영도' };   // URL 은 영문 키(한글 경로 인코딩 함정 회피), 화면 이름은 값
const ENTRY_MAX = 5000;             // 작성자당 일감 상한(디스크 보호)
const TOKENS_MAX = 20;              // 기억하는 기기 수 — 넘으면 가장 오래된 기기부터 잠긴다
const PASS_MIN = 6;
const PASS_MAX = 64;
const FAIL_MAX = 8;                 // 로그인 실패 허용(창 안)
const FAIL_WINDOW = 15 * 60 * 1000;
const HISTORY_KEEP = 90;            // 일일 스냅샷 보관 개수(=일)
const PRICE_MAX = 100000000;        // 1억 — 형식 상한
const LEN = { game: 60, agency: 40, memo: 200 };

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function scrypt(pass, salt) {
  return new Promise((res, rej) => {
    crypto.scrypt(String(pass), salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? rej(err) : res(key.toString('hex'))));
  });
}
const newToken = () => crypto.randomBytes(32).toString('hex');
const kstDay = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

/* ── 입력 정규화 ── */
function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanDate(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) ? s : '';
}
/* null = 단가 미정(빈 칸) · undefined = 잘못된 값(400). 0 은 «무상»이라 유효하다. */
function cleanPrice(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s원]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > PRICE_MAX || Math.floor(n) !== n) return undefined;
  return n;
}
const ID_RE = /^[A-Za-z0-9_-]{8,48}$/;

function attach(r, store, deps) {
  const requireAdmin = deps.requireAdmin;

  /* ★쓰기는 한 줄로 세운다. store 의 update/insert 는 «디스크에서 읽고 → 고치고 → 비동기로 쓴다»라서,
     앞 요청의 파일 쓰기가 끝나기 전에 뒤 요청이 읽으면 뒤 요청이 앞 요청의 변경이 빠진 배열을 써서 앞 변경이 사라진다
     (오류 0 · 조용한 유실). 완료 체크를 연달아 두 번 누르는 정도로도 날 수 있는 틈이라, 상태를 읽는 판단부터 쓰기 완료까지를
     이 체인 안에서 끝낸다. 무거운 scrypt 계산은 체인 밖에서 한다. */
  let chain = Promise.resolve();
  function serial(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  /* ── 암호·토큰 ── */
  const authRec = () => store.calAuth.find((x) => x.id === 'auth') || null;
  async function saveAuth(rec) { await store.calAuth.upsertBy((x) => x.id, rec); }

  // 로그인 실패 카운터(메모리) — 재시작하면 풀리지만 암호 6자 이상 + 창당 8회면 무차별 대입은 현실적으로 막힌다.
  const fails = new Map();
  function failState(ip) {
    const now = Date.now();
    let f = fails.get(ip);
    if (!f || now - f.t0 > FAIL_WINDOW) { f = { n: 0, t0: now }; fails.set(ip, f); }
    if (fails.size > 5000) fails.clear();                   // 메모리 보호(1GB VM)
    return f;
  }

  function isAdmin(req) {
    const adm = req.get('X-Admin-Token') || '';
    return !!(adm && config.adminToken && safeEq(adm, config.adminToken));
  }
  function calAuth(req, res, next) {
    if (isAdmin(req)) return next();
    const rec = authRec();
    if (!rec || !rec.hash) return res.status(401).json({ error: '캘린더 암호가 아직 없습니다.', code: 'unset' });
    const tok = req.get('X-Cal-Token') || '';
    const h = tok ? sha256(tok) : '';
    if (h && (rec.tokens || []).some((t) => t && t.h && safeEq(t.h, h))) return next();
    return res.status(401).json({ error: '캘린더가 잠겨 있습니다 — 암호를 입력하세요.', code: 'locked' });
  }
  function writerOf(req, res) {
    const w = String(req.params.writer || '');
    if (!Object.prototype.hasOwnProperty.call(WRITERS, w)) {
      res.status(404).json({ error: '없는 달력: ' + w + ' (bomding | yeongdo)' });
      return null;
    }
    return w;
  }
  function passOf(body) {
    const p = String((body || {}).pass == null ? '' : body.pass);
    if (p.length < PASS_MIN || p.length > PASS_MAX) return null;
    return p;
  }
  /* 토큰 발급 — 반드시 serial() 안에서 부른다(그 순간의 최신 기록에 덧붙여야 동시 로그인 두 건이 서로의 토큰을 안 지운다) */
  async function issueToken(ua) {
    const rec = authRec();
    if (!rec || !rec.hash) return null;
    const tok = newToken();
    rec.tokens = (rec.tokens || []).concat([{ h: sha256(tok), at: Date.now(), ua: String(ua || '').slice(0, 80) }]).slice(-TOKENS_MAX);
    await saveAuth(rec);
    return tok;
  }

  r.get('/cal/auth', (req, res) => {
    const rec = authRec();
    res.json({ set: !!(rec && rec.hash), min: PASS_MIN });
  });

  r.post('/cal/auth/setup', async (req, res) => {
    const pass = passOf(req.body);
    if (!pass) return res.status(400).json({ error: '암호는 ' + PASS_MIN + '~' + PASS_MAX + '자로 정하세요.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(pass, salt);
    const out = await serial(async () => {
      const cur = authRec();
      if (cur && cur.hash) return null;                       // 그새 다른 기기가 먼저 정했다
      await saveAuth({ id: 'auth', salt, hash, setAt: Date.now(), tokens: [] });
      return issueToken(req.get('User-Agent'));
    });
    if (!out) return res.status(409).json({ error: '암호가 이미 정해져 있습니다.', code: 'already' });
    res.status(201).json({ ok: true, token: out });
  });

  r.post('/cal/auth/login', async (req, res) => {
    const rec = authRec();
    if (!rec || !rec.hash) return res.status(409).json({ error: '캘린더 암호가 아직 없습니다.', code: 'unset' });
    const ip = req.ip || 'unknown';
    const f = failState(ip);
    if (f.n >= FAIL_MAX) {
      const wait = Math.max(1, Math.ceil((FAIL_WINDOW - (Date.now() - f.t0)) / 60000));
      return res.status(429).json({ error: '암호를 너무 여러 번 틀렸어요. ' + wait + '분 뒤에 다시 해 주세요.', code: 'slow', retryMin: wait });
    }
    const pass = String((req.body || {}).pass == null ? '' : req.body.pass).slice(0, PASS_MAX);
    const ok = pass.length >= 1 && safeEq(await scrypt(pass, rec.salt), rec.hash);
    if (!ok) {
      f.n += 1;
      return res.status(401).json({ error: '암호가 맞지 않아요.', code: 'wrong', left: Math.max(0, FAIL_MAX - f.n) });
    }
    fails.delete(ip);
    const token = await serial(() => issueToken(req.get('User-Agent')));
    if (!token) return res.status(409).json({ error: '캘린더 암호가 아직 없습니다.', code: 'unset' });
    res.json({ ok: true, token });
  });

  r.post('/cal/auth/logout', async (req, res) => {
    const tok = req.get('X-Cal-Token') || '';
    if (tok) {
      const h = sha256(tok);
      await serial(async () => {
        const rec = authRec();
        if (!rec) return;
        const kept = (rec.tokens || []).filter((t) => !(t && t.h && safeEq(t.h, h)));
        if (kept.length !== (rec.tokens || []).length) { rec.tokens = kept; await saveAuth(rec); }
      });
    }
    res.json({ ok: true });
  });

  r.post('/cal/auth/reset', requireAdmin, async (req, res) => {
    const removed = await serial(() => store.calAuth.removeBy((x) => x.id === 'auth'));
    res.json({ ok: true, removed });
  });

  r.get('/cal/export', requireAdmin, (req, res) => {
    res.json({ at: Date.now(), entries: store.cal.all() });
  });

  /* ── 원장 ── */
  function snapshotIfNeeded() {
    try {
      const dir = path.join(path.dirname(store.cal.file), 'cal-history');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'cal-' + kstDay() + '.json');
      if (fs.existsSync(f)) return;
      if (fs.existsSync(store.cal.file)) fs.copyFileSync(store.cal.file, f);
      else fs.writeFileSync(f, '[]', 'utf8');
      const olds = fs.readdirSync(dir).filter((n) => /^cal-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
      olds.slice(0, Math.max(0, olds.length - HISTORY_KEEP)).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (_) {} });
    } catch (err) {
      console.error('[cal] 스냅샷 실패(쓰기는 계속):', err && err.message);
    }
  }
  const pub = (x) => ({
    id: x.id, date: x.date, game: x.game || '', agency: x.agency || '',
    price: (x.price === null || x.price === undefined) ? null : x.price,
    done: !!x.done, memo: x.memo || '', createdAt: x.createdAt || null, updatedAt: x.updatedAt || null,
  });

  r.get('/cal/:writer', calAuth, (req, res) => {
    const w = writerOf(req, res); if (!w) return;
    const entries = store.cal.all().filter((x) => x.writer === w).map(pub)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
    res.json({ writer: w, name: WRITERS[w], entries });
  });

  r.put('/cal/:writer/:id', calAuth, async (req, res) => {
    const w = writerOf(req, res); if (!w) return;
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'id 형식이 잘못됐습니다.' });
    const b = req.body || {};
    const date = cleanDate(b.date);
    if (!date) return res.status(400).json({ error: '날짜(YYYY-MM-DD)가 잘못됐습니다.' });
    const game = cleanStr(b.game, LEN.game);
    const agency = cleanStr(b.agency, LEN.agency);
    if (!game && !agency) return res.status(400).json({ error: '게임 이름이나 외주업체 중 하나는 적어야 합니다.' });
    const price = cleanPrice(b.price);
    if (price === undefined) return res.status(400).json({ error: '단가는 0 이상 ' + PRICE_MAX.toLocaleString('ko-KR') + '원 이하의 정수로 적으세요.' });
    const memo = cleanStr(b.memo, LEN.memo);
    const hasBase = b.base !== undefined && b.base !== null && b.base !== '';

    const out = await serial(async () => {
      const cur = store.cal.find((x) => x.id === id);
      if (cur && cur.writer !== w) return { code: 409, body: { error: '같은 id 가 다른 달력에 있습니다.' } };
      if (cur && hasBase && Number(b.base) !== cur.updatedAt) {
        return { code: 409, body: { error: '다른 기기에서 먼저 고친 일감입니다.', code: 'stale', entry: pub(cur) } };
      }
      if (!cur && store.cal.all().filter((x) => x.writer === w).length >= ENTRY_MAX) {
        return { code: 429, body: { error: '일감이 한도(' + ENTRY_MAX + ')에 도달했습니다.' } };
      }
      const now = Date.now();
      const rec = {
        id, writer: w, date, game, agency, price, done: !!b.done, memo,
        createdAt: cur ? cur.createdAt : now,
        updatedAt: cur ? Math.max(now, (cur.updatedAt || 0) + 1) : now,   // 같은 ms 에 두 번 고쳐도 판이 갈리게
      };
      snapshotIfNeeded();
      if (cur) await store.cal.update(id, rec);
      else await store.cal.insert(rec);
      return { code: cur ? 200 : 201, body: { ok: true, entry: pub(rec) } };
    });
    res.status(out.code).json(out.body);
  });

  r.delete('/cal/:writer/:id', calAuth, async (req, res) => {
    const w = writerOf(req, res); if (!w) return;
    const id = String(req.params.id || '');
    const base = req.query.base;
    const out = await serial(async () => {
      const cur = store.cal.find((x) => x.id === id && x.writer === w);
      if (!cur) return { code: 404, body: { error: '없는 일감입니다.' } };
      if (base !== undefined && base !== '' && Number(base) !== cur.updatedAt) {
        return { code: 409, body: { error: '다른 기기에서 먼저 고친 일감입니다.', code: 'stale', entry: pub(cur) } };
      }
      snapshotIfNeeded();
      await store.cal.removeBy((x) => x.id === id && x.writer === w);
      return { code: 200, body: { ok: true, id } };
    });
    res.status(out.code).json(out.body);
  });
}

module.exports = { attach, WRITERS, cleanDate, cleanPrice };
