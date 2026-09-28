'use strict';
/* cal.js 통합 검증 — 임시 데이터 디렉터리에 앱을 띄우고 실제 HTTP 로 캘린더 계약 전부를 두드린다(2026-09-28).
   실행: node scripts/test-cal.js   (성공 exit 0 · 실패 exit 1)
   ★운영 데이터는 건드리지 않는다(data 디렉터리를 임시 폴더로 바꾼 뒤 require). */
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bccal-'));
const config = require('../src/config');
config.dataDir = tmp;
config.uploadDir = path.join(tmp, 'uploads');
config.adminToken = 'test-admin-token-0123456789';
config.corsOrigins = [];

const { initStore } = require('../src/store');
const { createApp } = require('../src/server');

let pass = 0, fail = 0;
function chk(name, ok, got) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  → ' + JSON.stringify(got)); }
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
    return { s: res.status, j };
  };
  const T = (t) => ({ 'X-Cal-Token': t });
  const ADM = { 'X-Admin-Token': config.adminToken };

  try {
    /* ── 암호 없음 ── */
    let r = await call('GET', '/cal/auth');
    chk('처음엔 암호가 없다', r.s === 200 && r.j.set === false, r);
    r = await call('GET', '/cal/bomding');
    chk('암호 전 원장 읽기 = 401 unset', r.s === 401 && r.j.code === 'unset', r);
    r = await call('POST', '/cal/auth/login', { pass: 'whatever1' });
    chk('암호 전 로그인 = 409 unset', r.s === 409 && r.j.code === 'unset', r);
    r = await call('POST', '/cal/auth/setup', { pass: 'abc12' });
    chk('5자 암호는 거절(400)', r.s === 400, r);

    /* ── 암호 정하기 ── */
    r = await call('POST', '/cal/auth/setup', { pass: 'sseudam-2026' });
    chk('암호 정하기 = 201 + 토큰', r.s === 201 && typeof r.j.token === 'string' && r.j.token.length === 64, r);
    const T1 = r.j.token;
    r = await call('POST', '/cal/auth/setup', { pass: 'another-pass' });
    chk('두 번째 정하기 = 409 already', r.s === 409 && r.j.code === 'already', r);
    r = await call('GET', '/cal/auth');
    chk('이제 set=true', r.j.set === true, r);
    const authFile = JSON.parse(fs.readFileSync(path.join(tmp, 'cal-auth.json'), 'utf8'));
    chk('★평문 암호·토큰이 파일에 없다', !JSON.stringify(authFile).includes('sseudam-2026') && !JSON.stringify(authFile).includes(T1), authFile);

    r = await call('GET', '/cal/bomding', undefined, T('nope'));
    chk('틀린 토큰 = 401 locked', r.s === 401 && r.j.code === 'locked', r);
    r = await call('GET', '/cal/bomding', undefined, T(T1));
    chk('토큰으로 원장 읽기 = 빈 목록', r.s === 200 && Array.isArray(r.j.entries) && r.j.entries.length === 0 && r.j.name === '봄딩', r);
    r = await call('GET', '/cal/nope', undefined, T(T1));
    chk('없는 달력 = 404', r.s === 404, r);

    /* ── 일감 쓰기 ── */
    r = await call('PUT', '/cal/bomding/e_000000001', { date: '2026-09-28', game: '리니지M', agency: '플랜비', price: '50,000' }, T(T1));
    chk('새 일감 = 201 · 단가 쉼표 정규화', r.s === 201 && r.j.entry.price === 50000 && r.j.entry.done === false && r.j.entry.game === '리니지M', r);
    const e1 = r.j.entry;
    r = await call('PUT', '/cal/bomding/e_000000002', { date: '2026-02-30', game: 'x' }, T(T1));
    chk('없는 날짜 거절', r.s === 400, r);
    r = await call('PUT', '/cal/bomding/e_000000002', { date: '2026-09-01', game: 'x', price: -1 }, T(T1));
    chk('음수 단가 거절', r.s === 400, r);
    r = await call('PUT', '/cal/bomding/e_000000002', { date: '2026-09-01', game: 'x', price: 1.5 }, T(T1));
    chk('소수 단가 거절', r.s === 400, r);
    r = await call('PUT', '/cal/bomding/e_000000002', { date: '2026-09-01', game: '  ', agency: '' }, T(T1));
    chk('게임·업체 둘 다 비면 거절', r.s === 400, r);
    r = await call('PUT', '/cal/bomding/x', { date: '2026-09-01', game: 'a' }, T(T1));
    chk('짧은 id 거절', r.s === 400, r);
    r = await call('PUT', '/cal/bomding/e_000000002', { date: '2026-09-01', agency: '애드너트', price: '' }, T(T1));
    chk('업체만 + 단가 빈칸 = null 로 저장', r.s === 201 && r.j.entry.price === null && r.j.entry.game === '', r);
    r = await call('PUT', '/cal/bomding/e_000000003', { date: '2026-09-02', game: 'g'.repeat(200), memo: 'm'.repeat(500), price: 0 }, T(T1));
    chk('긴 글은 상한으로 자름 · 단가 0 허용', r.s === 201 && r.j.entry.game.length === 60 && r.j.entry.memo.length === 200 && r.j.entry.price === 0, r);

    /* ── 판(base) 충돌 ── */
    r = await call('PUT', '/cal/bomding/e_000000001', Object.assign({}, e1, { done: true, base: e1.updatedAt }), T(T1));
    chk('맞는 판으로 고치기 = 200 · 판이 오른다', r.s === 200 && r.j.entry.done === true && r.j.entry.updatedAt > e1.updatedAt && r.j.entry.createdAt === e1.createdAt, r);
    const e1b = r.j.entry;
    r = await call('PUT', '/cal/bomding/e_000000001', Object.assign({}, e1, { price: 1, base: e1.updatedAt }), T(T1));
    chk('★낡은 판으로 고치기 = 409 + 최신 판', r.s === 409 && r.j.code === 'stale' && r.j.entry && r.j.entry.updatedAt === e1b.updatedAt, r);
    r = await call('PUT', '/cal/yeongdo/e_000000001', { date: '2026-09-28', game: 'x' }, T(T1));
    chk('다른 달력의 같은 id = 409', r.s === 409, r);
    r = await call('GET', '/cal/yeongdo', undefined, T(T1));
    chk('영도 달력은 비어 있다(격리)', r.s === 200 && r.j.entries.length === 0 && r.j.name === '영도', r);

    /* ── 동시 쓰기(유실 없음) ── */
    const many = [];
    for (let i = 0; i < 25; i++) {
      many.push(call('PUT', '/cal/yeongdo/c_' + String(i).padStart(9, '0'), { date: '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), game: '동시' + i, agency: '업체', price: 10000 + i }, T(T1)));
    }
    const rs = await Promise.all(many);
    chk('동시 25건 전부 201', rs.every((x) => x.s === 201), rs.map((x) => x.s));
    r = await call('GET', '/cal/yeongdo', undefined, T(T1));
    chk('★동시 25건이 하나도 안 사라졌다', r.j.entries.length === 25, r.j.entries.length);
    chk('날짜순 정렬', r.j.entries.every((x, i, a) => i === 0 || a[i - 1].date <= x.date), r.j.entries.map((x) => x.date));

    /* ── 지우기 ── */
    r = await call('DELETE', '/cal/bomding/e_000000002?base=1', undefined, T(T1));
    chk('낡은 판으로 지우기 = 409', r.s === 409, r);
    r = await call('DELETE', '/cal/bomding/e_000000002', undefined, T(T1));
    chk('지우기 = 200', r.s === 200, r);
    r = await call('DELETE', '/cal/bomding/e_000000002', undefined, T(T1));
    chk('두 번 지우기 = 404', r.s === 404, r);
    r = await call('DELETE', '/cal/yeongdo/e_000000001', undefined, T(T1));
    chk('남의 달력 id 로 지우기 = 404', r.s === 404, r);

    /* ── 스냅샷 ── */
    const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const snap = path.join(tmp, 'cal-history', 'cal-' + day + '.json');
    chk('오늘 첫 쓰기 전 스냅샷이 있다(KST)', fs.existsSync(snap) && Array.isArray(JSON.parse(fs.readFileSync(snap, 'utf8'))), snap);
    chk('스냅샷은 첫 쓰기 «전» 상태(빈 원장)', JSON.parse(fs.readFileSync(snap, 'utf8')).length === 0);

    /* ── 로그인·기기 기억 ── */
    r = await call('POST', '/cal/auth/login', { pass: 'sseudam-2026' });
    chk('맞는 암호 로그인 = 새 토큰', r.s === 200 && r.j.token && r.j.token !== T1, r);
    const T2 = r.j.token;
    const logins = [];
    for (let i = 0; i < 22; i++) logins.push(call('POST', '/cal/auth/login', { pass: 'sseudam-2026' }));
    await Promise.all(logins);
    const af = JSON.parse(fs.readFileSync(path.join(tmp, 'cal-auth.json'), 'utf8'))[0];
    chk('기억하는 기기는 최대 20', af.tokens.length === 20, af.tokens.length);
    r = await call('GET', '/cal/bomding', undefined, T(T1));
    chk('★오래된 기기(T1)는 밀려나 잠긴다', r.s === 401, r);
    r = await call('POST', '/cal/auth/login', { pass: 'sseudam-2026' });
    const T3 = r.j.token;
    r = await call('POST', '/cal/auth/logout', undefined, T(T3));
    chk('로그아웃 = 200', r.s === 200, r);
    r = await call('GET', '/cal/bomding', undefined, T(T3));
    chk('로그아웃한 토큰은 잠긴다', r.s === 401, r);
    r = await call('POST', '/cal/auth/login', { pass: 'sseudam-2026' });
    const T4 = r.j.token;
    r = await call('GET', '/cal/bomding', undefined, T(T4));
    chk('새로 받은 토큰(T4)은 열린다', r.s === 200, r);

    /* ── 무차별 대입 ── */
    let last = null;
    for (let i = 0; i < 8; i++) last = await call('POST', '/cal/auth/login', { pass: 'wrong-pass-' + i });
    chk('틀린 암호 = 401 wrong (8번째 left=0)', last.s === 401 && last.j.code === 'wrong' && last.j.left === 0, last);
    r = await call('POST', '/cal/auth/login', { pass: 'sseudam-2026' });
    chk('★8번 틀리면 맞는 암호도 429', r.s === 429 && r.j.code === 'slow', r);

    /* ── 관리자 ── */
    r = await call('GET', '/cal/bomding', undefined, ADM);
    chk('관리자 토큰으로 읽기', r.s === 200 && r.j.entries.length === 2, r);
    r = await call('GET', '/cal/bomding', undefined, T(T4));
    chk('잠금(429) 중에도 이미 받은 토큰은 열린다', r.s === 200, r);
    r = await call('GET', '/cal/export', undefined, T(T4));
    chk('내보내기는 관리자만(유효한 캘린더 토큰도 401)', r.s === 401, r);
    r = await call('GET', '/cal/export', undefined, ADM);
    chk('관리자 내보내기 = 전체 원장', r.s === 200 && r.j.entries.length === 27, r.j && r.j.entries && r.j.entries.length);
    r = await call('POST', '/cal/auth/reset', undefined, T(T4));
    chk('초기화는 관리자만(유효한 캘린더 토큰도 401)', r.s === 401, r);
    r = await call('POST', '/cal/auth/reset', undefined, ADM);
    chk('관리자 초기화 = 200', r.s === 200 && r.j.removed === 1, r);
    r = await call('GET', '/cal/bomding', undefined, T(T4));
    chk('초기화 뒤 옛 토큰 = 401 unset', r.s === 401 && r.j.code === 'unset', r);
    chk('(T2 는 21번째 기기에 밀려 이미 잠겼다)', (await call('GET', '/cal/auth')).j.set === false && !!T2);
    r = await call('GET', '/cal/export', undefined, ADM);
    chk('★초기화해도 원장은 그대로', r.j.entries.length === 27, r.j.entries.length);
  } catch (err) {
    fail++;
    console.log('  FAIL (예외) ' + (err && err.stack || err));
  }

  console.log('\n' + pass + '/' + (pass + fail) + ' PASS' + (fail ? ' · FAIL ' + fail : ''));
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
