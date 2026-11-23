'use strict';
/* members.js 통합 검증(2026-11-23) — 임시 데이터 디렉터리에 앱을 띄우고 회원·역할·계정 범위 계약을 실제 HTTP 로 두드린다.
   실행: node scripts/test-auth.js   (성공 exit 0 · 실패 exit 1)
   ★운영 데이터는 건드리지 않는다(data 디렉터리를 임시 폴더로 바꾼 뒤 require). */
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcauth-'));
const config = require('../src/config');
config.dataDir = tmp;
config.uploadDir = path.join(tmp, 'uploads');
config.adminToken = 'test-admin-token-0123456789';
config.corsOrigins = [];
config.authEnforce = false;
config.cookieSecure = false;

const { initStore } = require('../src/store');
const { createApp } = require('../src/server');

let pass = 0, fail = 0;
function chk(name, ok, got) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  → ' + JSON.stringify(got).slice(0, 400)); }
}

(async () => {
  const store = initStore(tmp);
  const app = createApp(store);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const B = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, url, body, headers) => {
    const res = await fetch(B + url, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null; try { j = await res.json(); } catch (_) {}
    return { s: res.status, j, h: res.headers };
  };
  const ADM = { 'X-Admin-Token': config.adminToken };
  const T = (t) => ({ 'X-Auth-Token': t });
  const signup = (u, extra) => call('POST', '/auth/signup', Object.assign({ username: u, password: 'pass-' + u + '-1', nick: '닉' + u, name: '이름' + u, contact: u + '@ex.com', reason: '써 보고 싶어요' }, extra || {}));
  const login = (u, p) => call('POST', '/auth/login', { username: u, password: p || ('pass-' + u + '-1') });

  try {
    /* ── 가입 ── */
    let r = await signup('ab');
    chk('짧은 아이디 거절(400 username)', r.s === 400 && r.j.field === 'username', r);
    r = await signup('alice', { password: 'short' });
    chk('짧은 비밀번호 거절(400 password)', r.s === 400 && r.j.field === 'password', r);
    r = await signup('alice', { contact: '' });
    chk('연락처 없음 거절(400 contact)', r.s === 400 && r.j.field === 'contact', r);
    r = await signup('alice');
    chk('가입 신청 = 201 pending', r.s === 201 && r.j.status === 'pending', r);
    r = await signup('Alice');
    chk('대소문자만 다른 아이디 = 409 taken', r.s === 409 && r.j.code === 'taken', r);
    r = await signup('bobby');
    chk('두 번째 가입(5회 상한 안)', r.s === 201, r);
    const usersFile = fs.readFileSync(path.join(tmp, 'users.json'), 'utf8');
    chk('★평문 비밀번호가 파일에 없다', !usersFile.includes('pass-alice-1'), null);

    /* ── 승인 전 로그인 ── */
    r = await login('alice', 'wrong-password');
    chk('틀린 비밀번호 = 401 wrong(대기 여부를 흘리지 않음)', r.s === 401 && r.j.code === 'wrong', r);
    r = await login('nobody1');
    chk('없는 아이디 = 401 wrong', r.s === 401 && r.j.code === 'wrong', r);
    r = await login('alice');
    chk('맞는 비밀번호 + 승인 전 = 403 pending', r.s === 403 && r.j.code === 'pending', r);

    /* ── 관리자 ── */
    r = await call('POST', '/auth/admin/users', { username: 'boss', password: 'boss-pass-123', nick: '대표', role: 'admin' });
    chk('관리자 토큰 없이 계정 만들기 = 401', r.s === 401, r);
    r = await call('POST', '/auth/admin/users', { username: 'boss', password: 'boss-pass-123', nick: '대표', role: 'admin' }, ADM);
    chk('관리자 토큰으로 운영자 계정 = 201 active', r.s === 201 && r.j.user.status === 'active' && r.j.user.role === 'admin', r);
    r = await login('boss', 'boss-pass-123');
    chk('운영자 로그인 = 토큰 + 쿠키', r.s === 200 && r.j.token && /sd_auth=/.test(r.h.get('set-cookie') || ''), r);
    const BOSS = r.j.token;
    chk('★쿠키에 HttpOnly', /HttpOnly/i.test(r.h.get('set-cookie') || ''), r.h.get('set-cookie'));
    r = await call('GET', '/auth/me', undefined, T(BOSS));
    chk('me = 운영자', r.j.user && r.j.user.role === 'admin' && r.j.enforce === false, r);
    r = await call('GET', '/auth/me', undefined, { Cookie: 'sd_auth=' + BOSS });
    chk('쿠키만으로도 me 가 운영자', r.j.user && r.j.user.id === 'boss', r);

    r = await call('GET', '/auth/admin/users', undefined, T(BOSS));
    const al = r.j && r.j.users.find((u) => u.id === 'alice');
    chk('운영자 회원 목록에 가입 정보(pii) 보임', r.s === 200 && al && al.pii && al.pii.contact === 'alice@ex.com', r);
    chk('★목록에 해시·토큰이 안 나간다', !JSON.stringify(r.j).includes('"hash"') && !JSON.stringify(r.j).includes('"salt"'), null);
    r = await call('POST', '/auth/admin/users/alice/decide', { action: 'approve', role: 'writer' }, T(BOSS));
    chk('writer 역할인데 작성자 없음 = 400', r.s === 400, r);
    r = await call('POST', '/auth/admin/users/alice/decide', { action: 'approve', role: 'writer', writer: '봄딩' }, T(BOSS));
    chk('alice 승인(작성자 봄딩)', r.s === 200 && r.j.user.status === 'active' && r.j.user.writer === '봄딩', r);
    r = await call('POST', '/auth/admin/users/bobby/decide', { action: 'approve' }, T(BOSS));
    chk('bobby 승인(일반 회원 기본)', r.s === 200 && r.j.user.role === 'member', r);
    r = await call('POST', '/auth/admin/users', { username: 'yd_user', password: 'yd-pass-1234', nick: '영도님', role: 'writer', writer: '영도' }, ADM);
    chk('영도 작성자 계정', r.s === 201, r);

    let a = await login('alice'); const ALICE = a.j.token;
    let b = await login('bobby'); const BOBBY = b.j.token;
    let y = await login('yd_user', 'yd-pass-1234'); const YD = y.j.token;
    chk('승인 뒤 로그인 3건', !!(ALICE && BOBBY && YD), [a.s, b.s, y.s]);

    /* ── 가입 정보 PC 동기화 ── */
    r = await call('GET', '/auth/admin/pii', undefined, T(BOSS));
    chk('pii 내려받기는 관리자 «토큰» 전용(운영자 계정 = 401)', r.s === 401, r);
    r = await call('GET', '/auth/admin/pii', undefined, ADM);
    chk('pii 내려받기 = alice·bobby', r.s === 200 && r.j.rows.map((x) => x.id).sort().join() === 'alice,bobby', r);
    r = await call('POST', '/auth/admin/pii/ack', { ids: ['alice', 'bobby'] }, ADM);
    chk('ack = 2건 삭제', r.j.cleared === 2, r);
    const uf2 = fs.readFileSync(path.join(tmp, 'users.json'), 'utf8');
    chk('★ack 뒤 서버 파일에 연락처가 없다', !uf2.includes('alice@ex.com') && !uf2.includes('이름alice'), null);

    /* ── 데이터 준비(관리자 토큰 = PC) ── */
    await call('POST', '/requests', { topic: '봄딩 요청1', writer: '봄딩' }, ADM);
    await call('POST', '/requests', { topic: '영도 요청1', writer: '영도' }, ADM);
    await call('POST', '/hidden', { rel: '봄딩/게임/주제A/' }, ADM);
    await call('POST', '/hidden', { rel: '영도/게임/주제B/' }, ADM);

    /* ── 관찰 모드 ── */
    r = await call('GET', '/requests');
    chk('관찰 모드: 비로그인 GET /requests 는 지금처럼 전부', r.s === 200 && r.j.length === 2, r);
    r = await call('GET', '/auth/admin/audit', undefined, T(BOSS));
    chk('관찰 기록에 비로그인 /requests 가 남는다', r.j.rows.some((x) => x.path === '/requests' && x.as === null), r);

    r = await call('GET', '/auth/admin/users');
    chk('★관찰 모드에서도 관리자 회원 목록은 비로그인 401', r.s === 401, r);
    r = await call('GET', '/cal/c/bomding');
    chk('★관찰 모드에서도 달력 열람(단가)은 비로그인 401', r.s === 401, r);
    r = await call('GET', '/cal/list', undefined, T(BOBBY));
    chk('★관찰 모드에서도 회원은 달력 목록 403', r.s === 403, r);
    r = await call('GET', '/cal/me');
    chk('★관찰 모드에서도 /cal/me 비로그인 401', r.s === 401, r);

    /* ── 강제 모드 ── */
    r = await call('POST', '/auth/admin/enforce', { on: true }, T(BOSS));
    chk('강제 켜기는 관리자 «토큰» 전용', r.s === 401, r);
    r = await call('POST', '/auth/admin/enforce', { on: true }, ADM);
    chk('강제 모드 켬', r.j.enforce === true, r);
    r = await call('GET', '/health');
    chk('health 는 열려 있고 enforce 표시', r.s === 200 && r.j.auth.enforce === true, r);
    r = await call('GET', '/requests');
    chk('비로그인 GET /requests = 401 login', r.s === 401 && r.j.code === 'login', r);
    r = await call('POST', '/requests', { topic: '몰래', writer: '봄딩' });
    chk('비로그인 발주 = 401', r.s === 401, r);
    r = await call('POST', '/pins', { games: ['해킹'] });
    chk('비로그인 핀 = 401', r.s === 401, r);
    r = await call('GET', '/requests', undefined, ADM);
    chk('관리자 토큰(PC) = 전부', r.s === 200 && r.j.length === 2, r);
    r = await call('GET', '/requests', undefined, T(BOSS));
    chk('운영자 계정 = 전부', r.s === 200 && r.j.length === 2, r);
    r = await call('GET', '/requests', undefined, T(ALICE));
    chk('봄딩 계정 = 봄딩 요청만', r.s === 200 && r.j.length === 1 && r.j[0].writer === '봄딩', r);
    r = await call('GET', '/requests', undefined, T(BOBBY));
    chk('일반 회원 = 403(요청 목록 없음)', r.s === 200 ? r.j.length === 0 : r.s === 403, r);
    r = await call('POST', '/requests', { topic: '회원 발주' }, T(BOBBY));
    chk('일반 회원 발주 = 403', r.s === 403, r);
    r = await call('POST', '/requests', { topic: '남의 블로그로', writer: '영도' }, T(ALICE));
    chk('봄딩 계정이 영도로 발주해도 봄딩으로 고정', r.s === 201, r);
    const mine = store.requests.all().find((x) => x.topic === '남의 블로그로');
    chk('… 저장 writer=봄딩 · uid=alice', mine && mine.writer === '봄딩' && mine.uid === 'alice', mine);
    const ydReq = store.requests.all().find((x) => x.writer === '영도');
    r = await call('POST', '/requests/' + ydReq.id + '/cancel', {}, T(ALICE));
    chk('봄딩 계정이 영도 요청 취소 = 403 scope', r.s === 403 && r.j.code === 'scope', r);
    r = await call('POST', '/requests/' + ydReq.id + '/cancel', {}, T(YD));
    chk('영도 계정이 자기 요청 취소 = 200', r.s === 200, r);
    r = await call('POST', '/requests/' + mine.id + '/status', { status: 'processing' }, T(BOSS));
    chk('상태 갱신은 관리자 «토큰» 전용(운영자 계정도 401)', r.s === 401, r);

    /* ── 글 상태(rel) 범위 ── */
    r = await call('GET', '/hidden', undefined, T(ALICE));
    chk('봄딩 계정 숨김 목록 = 봄딩 것만', r.s === 200 && r.j.rels.length === 1 && r.j.rels[0].startsWith('봄딩/'), r);
    r = await call('GET', '/hidden', undefined, T(BOSS));
    chk('운영자 숨김 목록 = 전부', r.j.rels.length === 2, r);
    r = await call('POST', '/hidden', { rel: '영도/게임/주제C/' }, T(ALICE));
    chk('봄딩 계정이 영도 글 숨김 = 403 scope', r.s === 403, r);
    r = await call('POST', '/mpub', { rel: '봄딩/게임/주제D/' }, T(ALICE));
    chk('봄딩 계정이 자기 글 발행완료 = 201', r.s === 201 && r.j.rels.every((x) => x.startsWith('봄딩/')), r);
    r = await call('GET', '/hidden', undefined, T(BOBBY));
    chk('일반 회원 숨김 목록 = 403', r.s === 403, r);
    r = await call('POST', '/why', { rel: '영도/게임/주제B/', reason: 'long' }, T(YD));
    chk('영도 계정 사유 기록', r.s === 201 && r.j.items.every((x) => x.rel.startsWith('영도/')), r);
    r = await call('GET', '/why', undefined, T(ALICE));
    chk('봄딩 계정에 영도 사유가 안 보인다', r.j.items.length === 0, r);

    /* ── 꼭 다룰 게임(계정당 3) ── */
    await call('POST', '/pins', { games: ['옛게임'] }, ADM);
    r = await call('POST', '/pins', { games: ['옛게임', 'A1', 'A2', 'A3'] }, T(BOBBY));
    chk('회원이 3개 넣기 = 201', r.s === 201 && r.j.games.length === 4, r);
    r = await call('POST', '/pins', { games: ['옛게임', 'A1', 'A2', 'A3', 'A4'] }, T(BOBBY));
    chk('4번째 = 409 per-user', r.s === 409 && r.j.code === 'per-user', r);
    r = await call('POST', '/pins', { games: ['A1', 'A2', 'A3'] }, T(BOBBY));
    chk('남(관리자)이 넣은 게임 빼기 = 403 not-owner', r.s === 403 && r.j.code === 'not-owner', r);
    r = await call('POST', '/pins', { games: ['옛게임', 'A1', 'A2', 'A3', 'B1'] }, T(ALICE));
    chk('다른 회원은 자기 몫 3개가 따로 있다', r.s === 201 && r.j.games.length === 5, r);
    r = await call('POST', '/pins', { games: ['옛게임', 'A2', 'A3', 'B1'] }, T(ALICE));
    chk('봄딩 계정이 bobby 게임(A1) 빼기 = 403', r.s === 403, r);
    r = await call('POST', '/pins', { games: ['옛게임', 'A2', 'A3', 'B1'] }, T(BOBBY));
    chk('bobby 가 자기 게임(A1) 빼기 = 201', r.s === 201 && !r.j.games.includes('A1'), r);
    const own = r.j.owners.find((o) => o.game === 'B1');
    chk('owners 에 넣은 사람 닉네임', own && own.by === 'alice' && own.nick === '닉alice', r.j.owners);
    r = await call('POST', '/pins', { games: ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8'] }, T(BOSS));
    chk('운영자는 3개 넘게·남의 것도 바꾼다(전체 8)', r.s === 201 && r.j.games.length === 8, r);
    r = await call('GET', '/pins');
    chk('비로그인 GET /pins = 401(데스크는 관리자 토큰으로 읽어야)', r.s === 401, r);
    r = await call('GET', '/pins', undefined, ADM);
    chk('데스크 계약 games[] 그대로', Array.isArray(r.j.games) && r.j.games.length === 8, r);
    r = await call('POST', '/watch', { games: ['W1', 'W2', 'W3', 'W4'] }, T(BOBBY));
    chk('업데이트 챙길 게임도 3개 상한', r.s === 409 && r.j.code === 'per-user', r);

    /* ── 계정별 캘린더 ── */
    await store.cal.insert({ id: 'legacy-bomding-1', writer: 'bomding', date: '2026-11-01', game: '옛 일감', agency: 'X', price: 10000, done: false, memo: '', createdAt: 1, updatedAt: 1 });
    r = await call('GET', '/cal/me', undefined, T(ALICE));
    chk('봄딩 계정 달력 = 옛 봄딩 일감이 그대로', r.s === 200 && r.j.calId === 'bomding' && r.j.entries.length === 1, r);
    r = await call('PUT', '/cal/me/bobby-entry-01', { date: '2026-11-23', game: '회원 일감', agency: 'Y', price: 5000 }, T(BOBBY));
    chk('회원 달력에 쓰기 = 201', r.s === 201, r);
    r = await call('GET', '/cal/me', undefined, T(BOBBY));
    chk('회원 달력 = 자기 것만(calId u:bobby)', r.j.calId === 'u:bobby' && r.j.entries.length === 1 && r.j.entries[0].game === '회원 일감', r);
    r = await call('PUT', '/cal/me/legacy-bomding-1', { date: '2026-11-02', game: '가로채기', agency: 'Z' }, T(BOBBY));
    chk('남의 달력 일감 id 로 덮어쓰기 = 409', r.s === 409, r);
    r = await call('GET', '/cal/bomding', undefined, T(BOBBY));
    chk('회원이 옛 공용 경로 = 403', r.s === 403, r);
    r = await call('GET', '/cal/list', undefined, T(BOSS));
    chk('운영자 달력 목록 = 모든 계정', r.s === 200 && ['bomding', 'u:bobby'].every((c) => r.j.calendars.some((x) => x.calId === c)), r);
    r = await call('GET', '/cal/c/u:bobby', undefined, T(BOSS));
    chk('운영자가 회원 달력 열람', r.s === 200 && r.j.entries.length === 1, r);
    r = await call('GET', '/cal/c/u:bobby', undefined, T(ALICE));
    chk('작성자 계정이 남의 달력 열람 = 403', r.s === 403, r);
    r = await call('PUT', '/cal/c/u:bobby/admin-entry-01', { date: '2026-11-24', game: '관리자가 넣음', agency: 'Q' }, T(BOSS));
    chk('운영자가 회원 달력에 쓰기 = 201', r.s === 201, r);
    r = await call('PUT', '/cal/c/u:bobby/admin-entry-02', { date: '2026-11-24', game: 'x', agency: 'Q' }, T(ALICE));
    chk('작성자 계정이 남의 달력에 쓰기 = 403', r.s === 403, r);
    r = await call('DELETE', '/cal/c/u:bobby/admin-entry-01', undefined, T(BOSS));
    chk('운영자가 회원 달력 일감 지우기 = 200', r.s === 200, r);
    r = await call('PUT', '/cal/c/u:bobby/anon-entry-01', { date: '2026-11-24', game: 'x', agency: 'Q' });
    chk('★비로그인 남의 달력 쓰기 = 401(관찰 모드 무관)', r.s === 401, r);

    /* ── 푸시 범위 ── */
    r = await call('POST', '/push/subscribe', { endpoint: 'https://push.example/bobby', keys: {} }, T(BOBBY));
    chk('회원 구독 저장(uid)', r.s === 201 && store.subscriptions.all().some((s) => s.uid === 'bobby'), r);
    r = await call('POST', '/push/subscribe', { endpoint: 'https://push.example/x' });
    chk('비로그인 구독 = 401', r.s === 401, r);

    /* ── 비밀번호·중지 ── */
    const a2 = (await login('alice')).j.token;
    r = await call('POST', '/auth/password', { old: 'pass-alice-1', password: 'new-pass-alice-2' }, T(a2));
    chk('비밀번호 바꾸기 = 200', r.s === 200, r);
    r = await call('GET', '/auth/me', undefined, T(ALICE));
    chk('바꾼 뒤 다른 기기 토큰은 끊긴다', r.j.user === null, r);
    r = await call('GET', '/auth/me', undefined, T(a2));
    chk('바꾼 기기는 그대로', r.j.user && r.j.user.id === 'alice', r);
    r = await call('POST', '/auth/admin/users/bobby/decide', { action: 'disable' }, T(BOSS));
    chk('bobby 중지', r.s === 200 && r.j.user.status === 'disabled', r);
    r = await call('GET', '/cal/me', undefined, T(BOBBY));
    chk('중지된 계정 토큰 = 401', r.s === 401, r);
    r = await login('bobby');
    chk('중지된 계정 로그인 = 403 disabled', r.s === 403 && r.j.code === 'disabled', r);
    r = await call('POST', '/auth/admin/users/boss/decide', { action: 'disable' }, T(BOSS));
    chk('자기 계정 중지 = 409', r.s === 409, r);

    /* ── 실패 제한 ── */
    for (let i = 0; i < 10; i++) await login('yd_user', 'nope-nope-' + i);
    r = await login('yd_user', 'yd-pass-1234');
    chk('같은 아이디 10회 실패 뒤 맞아도 429', r.s === 429 && r.j.code === 'slow', r);

    /* ── 끄기 = 즉시 되돌림 ── */
    r = await call('POST', '/auth/admin/enforce', { on: false }, ADM);
    r = await call('GET', '/requests');
    chk('강제 끄면 비로그인 GET /requests 가 다시 된다(되돌림)', r.s === 200, r);
    const allTxt = fs.readdirSync(tmp).filter((n) => n.endsWith('.json')).map((n) => fs.readFileSync(path.join(tmp, n), 'utf8')).join('\n');
    chk('★어느 데이터 파일에도 평문 토큰이 없다', ![BOSS, ALICE, BOBBY, YD, a2].some((t) => allTxt.includes(t)), null);
  } catch (err) {
    fail++; console.log('  EXCEPTION', err && err.stack);
  } finally {
    srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    console.log('\n' + pass + '/' + (pass + fail) + (fail ? ' FAIL' : ' PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
