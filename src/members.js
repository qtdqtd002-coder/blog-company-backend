'use strict';
/* 회원·역할(members) — 2026-11-23 신설. 쓰담 사이트를 외부에 공유하면서 «누가 접속했는가»를 가르고 역할별로 기능을 연다.

   왜: 이 서버의 쓰기 경로 대부분이 토큰 없이 열려 있었다(새 글 요청 = 글당 약 $5~6 의 작성 파이프라인 가동 ·
       숨김·발행완료·꼭 다룰 게임 같은 팀 상태 변경). 주소는 공개 사이트 코드·공개 저장소·인증서 로그에 이미 실려 있어
       «숨기기»로는 못 막는다(cal.js 머리 주석과 같은 실측). 그래서 «가입 → 관리자 승인 → 로그인» 계정을 두고,
       모든 경로를 역할 표(POLICY)로 지킨다.

   역할(role) — 사용자 결정 2026-11-23:
     admin   운영자. 전부 보고 전부 바꾼다. 회원 승인·역할 지정.  (PC 스크립트의 X-Admin-Token 도 admin 으로 본다)
     writer  블로거(봄딩·영도처럼 작성 파이프라인에 문체가 있는 사람). 계정에 writer(작성자 이름)가 붙는다.
             «자기 작성자»의 요청·글 상태만 보고 바꾼다. 발주 가능(작성자는 자기 이름으로 고정).
     member  승인된 일반 회원. 트렌드·도구함·자기 캘린더. ★발주 불가 — 그 사람 문체로 쓸 작성자 등록 전이라서(사용자 결정).
   꼭 다룰 게임·업데이트 챙길 게임은 admin 이 아니면 «자기가 넣은 것» 최대 3개씩(사용자 결정) — routes.js pins/watch.

   가입 정보(이름·연락처·가입 사유)는 «PC 에 저장»이 사용자 결정이다. 서버는 PC 가 가져갈 때까지만 들고 있다:
     가입 → users.pii 에 잠시 보관 → PC 동기화(GET /auth/admin/pii · 관리자 토큰)가 PC 원장에 적고
     → POST /auth/admin/pii/ack 로 서버 사본을 지운다(piiPulledAt). 서버에 영구히 남는 것 = 아이디·닉네임·역할·
     작성자·비밀번호 scrypt 해시·기기 토큰 sha256 뿐. 평문 비밀번호·토큰은 어디에도 저장하지 않는다.

   관찰 모드(enforce=false · 기본): 역할이 모자란 호출도 막지 않고 «누가 어느 경로를 토큰 없이 불렀는가»만 센다
     (GET /auth/admin/audit). PC 스크립트·사이트가 전부 토큰을 보내게 된 걸 감사 기록으로 확인한 뒤에 켠다.
     켜는 법 = POST /auth/admin/enforce {on:true}(관리자 토큰) 또는 .env AUTH_ENFORCE=true. 끄면 즉시 되돌아간다.

   계약:
     POST {base}/auth/signup  {username, password, nick, name, contact, reason?} → 201 {ok, status:'pending'}
                              username = 영소문자·숫자·_ 4~20 · password 8~72 · nick 2~20 · name ≤30 · contact 3~80
                              409 아이디 중복 · 429 같은 IP 1시간 5회 초과 · 503 대기열 가득(200)
     POST {base}/auth/login   {username, password} → 200 {token, user} | 401 wrong | 403 pending·rejected·disabled | 429
                              ★비밀번호가 맞을 때만 «승인 대기» 여부를 알려 준다(아이디 존재 여부를 흘리지 않게).
                              응답에 Set-Cookie sd_auth(HttpOnly·Secure·SameSite=Lax) — 같은 출처에서 정적 파일을 지킬 때 쓴다.
     POST {base}/auth/logout  → 200   이 기기 토큰 폐기
     GET  {base}/auth/me      → {user|null, enforce}
     POST {base}/auth/password {old, password} → 200 (로그인 필요 · 다른 기기 토큰은 전부 폐기)
     ── 관리자(admin 계정 또는 X-Admin-Token) ──
     GET  {base}/auth/admin/users                       → {users:[공개 필드 + pii(서버에 남아 있을 때만)]}
     POST {base}/auth/admin/users/:id/decide {action, role?, writer?}
                              action = approve | reject | disable | enable · approve 때 role(기본 member)·writer 지정
     POST {base}/auth/admin/users/:id/role   {role, writer?}
     POST {base}/auth/admin/users/:id/delete            (rejected·disabled 만)
     GET  {base}/auth/admin/audit                       관찰 모드 기록(경로·필요 역할·횟수·마지막 UA)
     ── 관리자 토큰 전용(PC) ──
     POST {base}/auth/admin/users   {username, password, nick, role, writer?}  처음 운영자 계정 만들기 등(즉시 active)
     GET  {base}/auth/admin/pii                         PC 동기화 — 서버에 남은 가입 정보
     POST {base}/auth/admin/pii/ack {ids:[...]}         PC 가 받아 적은 것 → 서버 사본 삭제
     POST {base}/auth/admin/enforce {on}                강제 모드 켜기/끄기(저장 — 재시작해도 유지)
*/
const crypto = require('crypto');
const config = require('./config');

const ROLES = ['admin', 'writer', 'member'];
const RANK = { member: 1, writer: 2, admin: 3 };
const USER_RE = /^[a-z0-9_]{4,20}$/;
const PASS_MIN = 8;
const PASS_MAX = 72;
const TOKENS_MAX = 10;                       // 계정당 기억하는 기기 수
const TOKEN_IDLE_MS = 180 * 24 * 3600 * 1000; // 180일 안 쓰면 만료
const LAST_TOUCH_MS = 3600 * 1000;           // «마지막 사용» 갱신은 1시간에 한 번만(매 요청 디스크 쓰기 방지)
const FAIL_MAX = 10;
const FAIL_WINDOW = 15 * 60 * 1000;
const SIGNUP_PER_IP = 5;
const SIGNUP_WINDOW = 3600 * 1000;
const PENDING_MAX = 200;
const AUDIT_MAX = 300;
const COOKIE = 'sd_auth';

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
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/* 역할 표 — 위에서부터 처음 맞는 줄. 표에 없는 경로는 admin(닫힌 쪽이 기본).
   level: open(누구나) · member(로그인) · writer · admin.
   4번째 칸 true = «항상 강제» — 2026-11-23 새로 만든 경로라 옛 호출처가 없다. 관찰 모드에서도 막는다.
     ★왜: 첫 배포 직후 실측에서 관찰 모드가 새 관리자 경로까지 열어 /cal/c/bomding(단가)이 비로그인 200 이었다.
       관찰 모드는 «옛 호출처를 끊지 않으려는» 장치라, 옛 호출처가 없는 경로에는 쓸 이유가 없다.
   ★writer 경로라도 «자기 작성자 범위»는 라우트가 따로 본다(routes.js relAllowed·요청 필터). 이 표는 문 앞 검사다. */
const POLICY = [
  ['GET', /^\/health$/, 'open'],
  ['GET', /^\/maintenance$/, 'open'],
  ['*', /^\/auth\/(signup|login|logout|me)$/, 'open'],
  ['POST', /^\/auth\/password$/, 'member', true],
  ['*', /^\/auth\/admin(\/|$)/, 'admin', true],
  ['GET', /^\/cal\/auth$/, 'open'],
  ['*', /^\/cal\/me(\/|$)/, 'member', true],
  ['GET', /^\/cal\/(list|c\/[^/]+)$/, 'admin', true],
  ['*', /^\/cal\/c\/[^/]+\/[^/]+$/, 'admin', true],
  ['*', /^\/cal(\/|$)/, 'admin'],                       // 옛 공용 달력(/cal/bomding …)·관리자 열람
  ['GET', /^\/requests$/, 'member'],                    // member 는 빈 목록(발주 없음) — 라우트가 거른다
  ['POST', /^\/requests$/, 'writer'],
  ['POST', /^\/requests\/[^/]+\/cancel$/, 'writer'],
  ['GET', /^\/(pins|watch)$/, 'member'],
  ['POST', /^\/(pins|watch)$/, 'member'],               // 자기 것 3개 상한은 라우트
  ['GET', /^\/(hidden|mpub|why|topic)$/, 'writer'],
  ['POST', /^\/(hidden|mpub|why|topic)(\/[a-z]+)?$/, 'writer'],
  ['POST', /^\/push\/(subscribe|unsubscribe)$/, 'member'],
];
function ruleOf(method, p) {
  const m = method === 'HEAD' ? 'GET' : method;
  for (const [pm, re, lv, strict] of POLICY) {
    if ((pm === '*' || pm === m) && re.test(p)) return { level: lv, strict: !!strict };
  }
  return { level: 'admin', strict: false };
}
const levelOf = (method, p) => ruleOf(method, p).level;

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return ''; }
    }
  }
  return '';
}

function create(store) {
  /* 쓰기는 한 줄로(cal.js 와 같은 이유 — store 는 읽기→쓰기 사이 틈이 있어 동시 쓰기가 조용히 유실된다). */
  let chain = Promise.resolve();
  function serial(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  const users = () => store.users.all();
  const userById = (id) => store.users.find((u) => u.id === id) || null;

  function enforceOn() {
    if (config.authEnforce) return true;
    const rec = store.authCfg.find((x) => x.id === 'cfg');
    return !!(rec && rec.enforce);
  }

  function pub(u) {
    if (!u) return null;
    return { id: u.id, nick: u.nick, role: u.role, writer: u.writer || null, status: u.status };
  }

  /* 요청자 판정 — 관리자 토큰 → admin · 기기 토큰(헤더 X-Auth-Token 또는 쿠키 sd_auth) → 그 계정(active 만) · 없음 → null */
  function whoOf(req) {
    const adm = req.get('X-Admin-Token') || '';
    if (adm && config.adminToken && safeEq(adm, config.adminToken)) {
      return { id: '@admin', nick: '관리자(토큰)', role: 'admin', writer: null, via: 'token' };
    }
    const tok = req.get('X-Auth-Token') || readCookie(req, COOKIE);
    if (!tok || tok.length > 128) return null;
    const h = sha256(tok);
    const now = Date.now();
    for (const u of users()) {
      if (u.status !== 'active' || !Array.isArray(u.tokens)) continue;
      const t = u.tokens.find((x) => x && x.h && safeEq(x.h, h));
      if (!t) continue;
      if (now - (t.last || t.at || 0) > TOKEN_IDLE_MS) return null;
      if (now - (t.last || 0) > LAST_TOUCH_MS) touch(u.id, h);
      return { id: u.id, nick: u.nick, role: u.role, writer: u.writer || null, via: 'user', tokenHash: h };
    }
    return null;
  }
  function touch(uid, h) {
    serial(async () => {
      const u = userById(uid); if (!u) return;
      const t = (u.tokens || []).find((x) => x && x.h === h); if (!t) return;
      t.last = Date.now();
      await store.users.update(uid, { tokens: u.tokens });
    }).catch(() => {});
  }

  /* 관찰 기록 — 메모리(재시작하면 비워진다). 켜기 전 «아직 토큰 없이 부르는 곳»을 찾는 용도라 영속할 필요가 없다. */
  const audit = new Map();
  /* ★실제 API 경로만 센다(2026-11-24) — 인터넷 스캐너가 찔러 본 없는 경로(/.env·/wp-login…)가 300칸을 채워
     진짜 호출처가 기록되지 못했다(첫 관찰 17시간 실측: 300칸 중 실제 경로 4줄). */
  const API_PATH = /^\/(requests|pins|watch|hidden|mpub|why|topic|push|cal|maintenance)(\/|$)/;
  function note(req, need, who) {
    if (!API_PATH.test(req.path)) return;
    const pat = req.path.replace(/\/req_[a-z0-9_]+/g, '/:id').replace(/\/(attachments)\/\d+/, '/$1/:n').slice(0, 80);
    const key = need + '|' + req.method + ' ' + pat + '|' + (who ? who.role : '-');
    let a = audit.get(key);
    if (!a) {
      if (audit.size >= AUDIT_MAX) return;
      a = { need, method: req.method, path: pat, as: who ? who.role : null, n: 0, first: Date.now() };
      audit.set(key, a);
    }
    a.n += 1; a.last = Date.now();
    a.ua = String(req.get('User-Agent') || '').slice(0, 80);
    a.ip = req.ip || null;
  }

  /* 문 앞 검사 — 라우터 맨 앞에 건다. req.who 를 모든 요청에 붙인다(open 경로 포함 · 라우트가 범위 판단에 쓴다). */
  function gate(req, res, next) {
    const who = whoOf(req);
    req.who = who;
    const rule = ruleOf(req.method, req.path);
    const need = rule.level;
    if (need === 'open') return next();
    const ok = !!(who && RANK[who.role] >= RANK[need]);
    if (ok) return next();
    if (!rule.strict && !enforceOn()) { note(req, need, who); req.observed = true; return next(); }
    if (!who) return res.status(401).json({ error: '로그인이 필요합니다.', code: 'login' });
    return res.status(403).json({ error: '이 기능을 쓸 권한이 없습니다.', code: 'role', need });
  }

  /* ── 실패 카운터(IP·아이디 각각) ── */
  const fails = new Map();
  function failOf(key) {
    const now = Date.now();
    let f = fails.get(key);
    if (!f || now - f.t0 > FAIL_WINDOW) { f = { n: 0, t0: now }; fails.set(key, f); }
    if (fails.size > 5000) fails.clear();
    return f;
  }
  const signups = new Map();

  async function issueToken(uid, ua) {
    const tok = newToken();
    const u = userById(uid);
    if (!u) return null;
    const now = Date.now();
    const kept = (u.tokens || []).filter((t) => t && now - (t.last || t.at || 0) <= TOKEN_IDLE_MS);
    const tokens = kept.concat([{ h: sha256(tok), at: now, last: now, ua: String(ua || '').slice(0, 80) }]).slice(-TOKENS_MAX);
    await store.users.update(uid, { tokens });
    return tok;
  }
  function setCookie(res, tok) {
    const secure = config.cookieSecure ? '; Secure' : '';
    res.append('Set-Cookie', COOKIE + '=' + (tok ? encodeURIComponent(tok) : '') + '; Path=/; HttpOnly; SameSite=Lax' + secure +
      (tok ? '; Max-Age=' + Math.floor(TOKEN_IDLE_MS / 1000) : '; Max-Age=0'));
  }

  function cleanRoleWriter(role, writer, writers) {
    const r = String(role || '').trim();
    if (!ROLES.includes(r)) return { error: 'role 은 ' + ROLES.join('|') + ' 중 하나' };
    let w = writer == null ? '' : String(writer).trim();
    if (r === 'writer') {
      if (!writers.includes(w)) return { error: 'writer 역할은 작성자 이름이 필요합니다(' + writers.join('·') + ').' };
    } else if (w && !writers.includes(w)) {
      return { error: '없는 작성자: ' + w };
    }
    return { role: r, writer: w || null };
  }

  function attach(r, deps) {
    const requireAdmin = deps.requireAdmin;          // 관리자 «토큰» 전용(PC 동기화·첫 계정 만들기)
    const writers = deps.writers || [];

    r.post('/auth/signup', async (req, res) => {
      const b = req.body || {};
      const ip = req.ip || 'unknown';
      const now = Date.now();
      let s = signups.get(ip);
      if (!s || now - s.t0 > SIGNUP_WINDOW) { s = { n: 0, t0: now }; signups.set(ip, s); }
      if (signups.size > 5000) signups.clear();
      if (s.n >= SIGNUP_PER_IP) return res.status(429).json({ error: '가입 신청이 너무 많아요. 한 시간 뒤에 다시 해 주세요.', code: 'slow' });

      const username = String(b.username == null ? '' : b.username).trim().toLowerCase();
      const password = String(b.password == null ? '' : b.password);
      const nick = clean(b.nick, 20);
      const name = clean(b.name, 30);
      const contact = clean(b.contact, 80);
      const reason = clean(b.reason, 300);
      if (!USER_RE.test(username)) return res.status(400).json({ error: '아이디는 영문 소문자·숫자·_ 4~20자로 정하세요.', field: 'username' });
      if (password.length < PASS_MIN || password.length > PASS_MAX) return res.status(400).json({ error: '비밀번호는 ' + PASS_MIN + '~' + PASS_MAX + '자로 정하세요.', field: 'password' });
      if (nick.length < 2) return res.status(400).json({ error: '닉네임은 2~20자로 적어 주세요.', field: 'nick' });
      if (!name) return res.status(400).json({ error: '이름을 적어 주세요.', field: 'name' });
      if (contact.length < 3) return res.status(400).json({ error: '연락처(이메일이나 전화번호)를 적어 주세요.', field: 'contact' });
      s.n += 1;

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await scrypt(password, salt);
      const out = await serial(async () => {
        if (userById(username)) return { code: 409, body: { error: '이미 쓰는 아이디예요.', code: 'taken', field: 'username' } };
        if (users().filter((u) => u.status === 'pending').length >= PENDING_MAX) {
          return { code: 503, body: { error: '가입 신청이 밀려 있어요. 나중에 다시 해 주세요.', code: 'full' } };
        }
        await store.users.insert({
          id: username, nick, role: 'member', writer: null, status: 'pending', salt, hash,
          createdAt: Date.now(), tokens: [], pii: { name, contact, reason }, piiAt: Date.now(), piiPulledAt: null,
        });
        return { code: 201, body: { ok: true, status: 'pending' } };
      });
      res.status(out.code).json(out.body);
    });

    r.post('/auth/login', async (req, res) => {
      const b = req.body || {};
      const username = String(b.username == null ? '' : b.username).trim().toLowerCase().slice(0, 40);
      const password = String(b.password == null ? '' : b.password).slice(0, PASS_MAX);
      const fIp = failOf('ip:' + (req.ip || 'unknown'));
      const fUser = failOf('u:' + username);
      if (fIp.n >= FAIL_MAX || fUser.n >= FAIL_MAX) {
        const f = fIp.n >= FAIL_MAX ? fIp : fUser;
        const wait = Math.max(1, Math.ceil((FAIL_WINDOW - (Date.now() - f.t0)) / 60000));
        return res.status(429).json({ error: '너무 여러 번 틀렸어요. ' + wait + '분 뒤에 다시 해 주세요.', code: 'slow', retryMin: wait });
      }
      const u = userById(username);
      // 없는 아이디도 같은 시간을 쓰게 한 번 계산한다(응답 시간으로 아이디 존재를 알아내지 못하게).
      const hash = await scrypt(password, u ? u.salt : 'no-such-user-salt');
      const ok = !!(u && password.length >= 1 && safeEq(hash, u.hash));
      if (!ok) {
        fIp.n += 1; fUser.n += 1;
        return res.status(401).json({ error: '아이디나 비밀번호가 맞지 않아요.', code: 'wrong' });
      }
      fails.delete('ip:' + (req.ip || 'unknown')); fails.delete('u:' + username);
      if (u.status !== 'active') {
        const msg = { pending: '가입 승인을 기다리는 중이에요. 승인되면 들어올 수 있어요.',
          rejected: '가입이 승인되지 않았어요.', disabled: '사용이 중지된 계정이에요. 관리자에게 문의해 주세요.' }[u.status] || '쓸 수 없는 계정이에요.';
        return res.status(403).json({ error: msg, code: u.status });
      }
      const tok = await serial(() => issueToken(u.id, req.get('User-Agent')));
      setCookie(res, tok);
      res.json({ ok: true, token: tok, user: pub(userById(u.id)) });
    });

    r.post('/auth/logout', async (req, res) => {
      const tok = req.get('X-Auth-Token') || readCookie(req, COOKIE);
      if (tok) {
        const h = sha256(tok);
        await serial(async () => {
          for (const u of users()) {
            const kept = (u.tokens || []).filter((t) => !(t && t.h && safeEq(t.h, h)));
            if (kept.length !== (u.tokens || []).length) { await store.users.update(u.id, { tokens: kept }); break; }
          }
        });
      }
      setCookie(res, '');
      res.json({ ok: true });
    });

    r.get('/auth/me', (req, res) => {
      const w = req.who;
      const user = !w ? null : (w.via === 'token' ? { id: w.id, nick: w.nick, role: 'admin', writer: null, status: 'active' } : pub(userById(w.id)));
      res.json({ user, enforce: enforceOn(), writers });
    });

    r.post('/auth/password', async (req, res) => {
      const w = req.who;
      if (!w || w.via !== 'user') return res.status(401).json({ error: '로그인이 필요합니다.', code: 'login' });
      const b = req.body || {};
      const oldP = String(b.old == null ? '' : b.old).slice(0, PASS_MAX);
      const newP = String(b.password == null ? '' : b.password);
      if (newP.length < PASS_MIN || newP.length > PASS_MAX) return res.status(400).json({ error: '새 비밀번호는 ' + PASS_MIN + '~' + PASS_MAX + '자로 정하세요.' });
      const u = userById(w.id);
      if (!u || !safeEq(await scrypt(oldP, u.salt), u.hash)) return res.status(401).json({ error: '지금 비밀번호가 맞지 않아요.', code: 'wrong' });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await scrypt(newP, salt);
      await serial(async () => {
        const cur = userById(w.id); if (!cur) return;
        const keep = (cur.tokens || []).filter((t) => t && t.h === w.tokenHash);   // 지금 기기만 남긴다
        await store.users.update(w.id, { salt, hash, tokens: keep, passAt: Date.now() });
      });
      res.json({ ok: true });
    });

    /* ── 관리자 ── */
    const adminView = (u) => Object.assign(pub(u), {
      createdAt: u.createdAt || null, decidedAt: u.decidedAt || null, decidedBy: u.decidedBy || null,
      devices: (u.tokens || []).length, lastSeen: (u.tokens || []).reduce((m, t) => Math.max(m, (t && t.last) || 0), 0) || null,
      pii: u.pii || null, piiPulledAt: u.piiPulledAt || null,
    });

    r.get('/auth/admin/users', (req, res) => {
      const list = users().map(adminView).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      res.json({ users: list, writers, enforce: enforceOn() });
    });

    r.post('/auth/admin/users', requireAdmin, async (req, res) => {
      const b = req.body || {};
      const username = String(b.username == null ? '' : b.username).trim().toLowerCase();
      const password = String(b.password == null ? '' : b.password);
      const nick = clean(b.nick, 20) || username;
      if (!USER_RE.test(username)) return res.status(400).json({ error: '아이디 형식(영소문자·숫자·_ 4~20)' });
      if (password.length < PASS_MIN || password.length > PASS_MAX) return res.status(400).json({ error: '비밀번호 ' + PASS_MIN + '~' + PASS_MAX + '자' });
      const rw = cleanRoleWriter(b.role || 'member', b.writer, writers);
      if (rw.error) return res.status(400).json({ error: rw.error });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await scrypt(password, salt);
      const out = await serial(async () => {
        if (userById(username)) return { code: 409, body: { error: '이미 있는 아이디' } };
        const rec = { id: username, nick, role: rw.role, writer: rw.writer, status: 'active', salt, hash, createdAt: Date.now(),
          decidedAt: Date.now(), decidedBy: '@admin', tokens: [], pii: null, piiPulledAt: null };
        await store.users.insert(rec);
        return { code: 201, body: { ok: true, user: adminView(rec) } };
      });
      res.status(out.code).json(out.body);
    });

    r.post('/auth/admin/users/:id/decide', async (req, res) => {
      const id = String(req.params.id || '');
      const b = req.body || {};
      const action = String(b.action || '');
      if (!['approve', 'reject', 'disable', 'enable'].includes(action)) return res.status(400).json({ error: 'action = approve|reject|disable|enable' });
      let rw = null;
      if (action === 'approve') { rw = cleanRoleWriter(b.role || 'member', b.writer, writers); if (rw.error) return res.status(400).json({ error: rw.error }); }
      const by = req.who ? req.who.id : null;
      const out = await serial(async () => {
        const u = userById(id);
        if (!u) return { code: 404, body: { error: '없는 계정' } };
        if (action === 'approve' && u.status !== 'pending') return { code: 409, body: { error: '승인 대기 중인 계정만 승인합니다(지금 ' + u.status + ').' } };
        if (action === 'reject' && u.status !== 'pending') return { code: 409, body: { error: '승인 대기 중인 계정만 거절합니다.' } };
        if (action === 'enable' && u.status !== 'disabled') return { code: 409, body: { error: '중지된 계정만 다시 켭니다.' } };
        if (action === 'disable' && by === id) return { code: 409, body: { error: '자기 계정은 중지할 수 없습니다.' } };
        const patch = { decidedAt: Date.now(), decidedBy: by };
        if (action === 'approve') Object.assign(patch, { status: 'active', role: rw.role, writer: rw.writer });
        if (action === 'reject') Object.assign(patch, { status: 'rejected', tokens: [] });
        if (action === 'disable') Object.assign(patch, { status: 'disabled', tokens: [] });
        if (action === 'enable') Object.assign(patch, { status: 'active' });
        const nu = await store.users.update(id, patch);
        return { code: 200, body: { ok: true, user: adminView(nu) } };
      });
      res.status(out.code).json(out.body);
    });

    r.post('/auth/admin/users/:id/role', async (req, res) => {
      const id = String(req.params.id || '');
      const b = req.body || {};
      const rw = cleanRoleWriter(b.role, b.writer, writers);
      if (rw.error) return res.status(400).json({ error: rw.error });
      const out = await serial(async () => {
        const u = userById(id);
        if (!u) return { code: 404, body: { error: '없는 계정' } };
        if (req.who && req.who.id === id && rw.role !== 'admin') return { code: 409, body: { error: '자기 관리자 역할은 내릴 수 없습니다.' } };
        const nu = await store.users.update(id, { role: rw.role, writer: rw.writer, roleAt: Date.now() });
        return { code: 200, body: { ok: true, user: adminView(nu) } };
      });
      res.status(out.code).json(out.body);
    });

    r.post('/auth/admin/users/:id/delete', async (req, res) => {
      const id = String(req.params.id || '');
      const out = await serial(async () => {
        const u = userById(id);
        if (!u) return { code: 404, body: { error: '없는 계정' } };
        if (!['rejected', 'disabled'].includes(u.status)) return { code: 409, body: { error: '거절·중지된 계정만 지웁니다(먼저 중지).' } };
        if (u.pii) return { code: 409, body: { error: '가입 정보가 아직 PC 로 안 넘어갔습니다 — PC 동기화 뒤에 지우세요.', code: 'pii' } };
        await store.users.removeBy((x) => x.id === id);
        return { code: 200, body: { ok: true, id } };
      });
      res.status(out.code).json(out.body);
    });

    r.get('/auth/admin/audit', (req, res) => {
      const rows = Array.from(audit.values()).sort((a, b) => b.n - a.n);
      res.json({ enforce: enforceOn(), rows });
    });

    r.get('/auth/admin/pii', requireAdmin, (req, res) => {
      const rows = users().filter((u) => u.pii).map((u) => ({
        id: u.id, nick: u.nick, status: u.status, role: u.role, writer: u.writer || null, createdAt: u.createdAt, pii: u.pii,
      }));
      res.json({ at: Date.now(), rows });
    });

    r.post('/auth/admin/pii/ack', requireAdmin, async (req, res) => {
      const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String).slice(0, 500) : [];
      const n = await serial(async () => {
        let k = 0;
        for (const id of ids) {
          const u = userById(id);
          if (u && u.pii) { await store.users.update(id, { pii: null, piiPulledAt: Date.now() }); k++; }
        }
        return k;
      });
      res.json({ ok: true, cleared: n });
    });

    r.post('/auth/admin/enforce', requireAdmin, async (req, res) => {
      const on = !!(req.body || {}).on;
      await serial(() => store.authCfg.upsertBy((x) => x.id, { id: 'cfg', enforce: on, at: Date.now() }));
      res.json({ ok: true, enforce: enforceOn(), envLocked: !!config.authEnforce });
    });
  }

  return { gate, attach, whoOf, enforceOn, userById, pub, RANK };
}

module.exports = { create, levelOf, ROLES, RANK };
