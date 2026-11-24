'use strict';
/* site.js 통합 검증(2026-11-24 · 3단계) — 임시 사이트 폴더 + 임시 데이터로 앱을 띄우고
   /auth/gate(Caddy forward_auth 흉내)와 /site-data(계정 범위 JSON)를 실제 HTTP 로 두드린다.
   실행: node scripts/test-site.js   (성공 exit 0 · 실패 exit 1) — 운영 데이터는 건드리지 않는다. */
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bcsite-'));
const siteDir = path.join(tmp, 'site');
const config = require('../src/config');
config.dataDir = tmp;
config.uploadDir = path.join(tmp, 'uploads');
config.adminToken = 'test-admin-token-0123456789';
config.corsOrigins = [];
config.authEnforce = true;
config.cookieSecure = false;
config.siteRoot = siteDir;

/* 가짜 사이트 */
const W = (rel, body) => { const f = path.join(siteDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); };
W('index.html', '<h1>sseudam</h1>');
W('posts.json', [
  { rel: '봄딩/애니모/주제/봄딩_미리보기_a.html', author: '봄딩', title: 'A' },
  { rel: '영도/림버스/주제/영도_미리보기_b.html', author: '영도', title: 'B' },
  { rel: '봄딩/옛글/주제/x.html', author: '봄딩', title: 'old', archived: true },
]);
W('manifest.json', { '봄딩/애니모/주제/봄딩_미리보기_a.html': { title: 'A' }, '영도/림버스/주제/영도_미리보기_b.html': { title: 'B' } });
W('published.json', { publishedRels: ['봄딩/애니모/주제/봄딩_미리보기_a.html', '영도/림버스/주제/영도_미리보기_b.html'] });
W('reopen.json', { rels: [{ rel: '영도/림버스/주제/영도_미리보기_b.html', at: '2026-11-20' }] });
W('_trend/_usage.json', { days: [{ day: '2026-11-24', tok: 30, cost: 3, by: { 봄딩: 10, 영도: 20 }, costBy: { 봄딩: 1, 영도: 2 } }] });
W('_trend/_quota.json', { five_hour: 1 });
W('_trend/_kpi.json', { writers: { 봄딩: { k: 1 }, 영도: { k: 2 } } });
W('_trend/_hero.json', { top: [1] });
W('_trend/_refresh.json', { items: [{ writer: '봄딩', rel: 'a' }, { writer: '영도', rel: 'b' }] });
W('_trend/_citations.json', { writers: [{ name: '봄딩' }, { name: '영도' }] });

const { initStore } = require('../src/store');
const { createApp } = require('../src/server');

let pass = 0, fail = 0;
function chk(name, ok, got) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  → ' + JSON.stringify(got).slice(0, 300)); }
}

(async () => {
  const store = initStore(tmp);
  const app = createApp(store);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const B = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, url, body, headers) => {
    const res = await fetch(B + url, {
      method, redirect: 'manual', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null; const t = await res.text(); try { j = JSON.parse(t); } catch (_) { j = t; }
    return { s: res.status, j, h: res.headers };
  };
  const ADM = { 'X-Admin-Token': config.adminToken };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const gate = (p, h) => call('GET', '/auth/gate', undefined, Object.assign({ 'X-Forwarded-Uri': enc(p), 'X-Forwarded-Method': 'GET' }, h || {}));

  try {
    /* 계정 3종: 봄딩 작성자 · 영도 작성자 · 일반 회원 (+ 관리자 토큰) */
    let r = await call('POST', '/auth/admin/users', { username: 'bd_user', password: 'bd-pass-1234', nick: '봄딩님', role: 'writer', writer: '봄딩' }, ADM);
    chk('봄딩 작성자 계정 생성', r.s === 201 || r.s === 200, r);
    await call('POST', '/auth/admin/users', { username: 'yd_user', password: 'yd-pass-1234', nick: '영도님', role: 'writer', writer: '영도' }, ADM);
    await call('POST', '/auth/admin/users', { username: 'mem_user', password: 'mem-pass-1234', nick: '손님', role: 'member' }, ADM);
    const tok = async (u, p) => (await call('POST', '/auth/login', { username: u, password: p })).j.token;
    const BD = { 'X-Auth-Token': await tok('bd_user', 'bd-pass-1234') };
    const YD = { 'X-Auth-Token': await tok('yd_user', 'yd-pass-1234') };
    const MB = { 'X-Auth-Token': await tok('mem_user', 'mem-pass-1234') };
    chk('로그인 토큰 3개', BD['X-Auth-Token'] && YD['X-Auth-Token'] && MB['X-Auth-Token'], null);

    /* ── /auth/gate ── */
    r = await gate('/index.html'); chk('첫 화면 = 비로그인 열림(204)', r.s === 204, r.s);
    r = await gate('/'); chk('/ = 열림', r.s === 204, r.s);
    r = await gate('/_vendor/gsap/gsap.min.js'); chk('라이브러리 = 열림', r.s === 204, r.s);
    r = await gate('/_design/naver-npaste.js'); chk('붙여넣기 위젯 = 열림', r.s === 204, r.s);
    r = await gate('/봄딩/애니모/주제/img/a.png'); chk('★글 사진 = 비로그인 열림(네이버가 받아 간다)', r.s === 204, r.s);
    r = await gate('/봄딩/애니모/주제/_qa/shot.png'); chk('_qa 사진 = 비로그인 401', r.s === 401, r.s);
    r = await gate('/_tools/secret.png'); chk('_tools 사진 = 열림 아님(401)', r.s === 401, r.s);
    r = await gate('/봄딩/애니모/주제/봄딩_미리보기_a.html'); chk('글 본문 비로그인 = 401', r.s === 401, r.s);
    r = await gate('/봄딩/애니모/주제/봄딩_미리보기_a.html', { Accept: 'text/html' }); chk('글 본문 비로그인 화면 이동 = 302 → /', r.s === 302 && r.h.get('location') === '/', [r.s, r.h.get('location')]);
    r = await gate('/.git/config', ADM); chk('.git = 관리자도 404', r.s === 404, r.s);
    r = await gate('/봄딩/../.git/config', ADM); chk('.. 섞인 경로 = 404', r.s === 404, r.s);
    r = await gate('/봄딩/애니모/주제/봄딩_미리보기_a.html', BD); chk('봄딩 계정 → 봄딩 글 = 204', r.s === 204, r.s);
    r = await gate('/영도/림버스/주제/영도_미리보기_b.html', BD); chk('봄딩 계정 → 영도 글 = 404', r.s === 404, r.s);
    r = await gate('/영도/림버스/주제/영도_미리보기_b.html', YD); chk('영도 계정 → 영도 글 = 204', r.s === 204, r.s);
    r = await gate('/봄딩/애니모/주제/봄딩_미리보기_a.html', MB); chk('회원 → 작성자 글 = 404', r.s === 404, r.s);
    r = await gate('/봄딩/애니모/주제/_qa/report.md', BD); chk('_qa = 작성자도 404', r.s === 404, r.s);
    r = await gate('/봄딩/애니모/주제/_qa/report.md', ADM); chk('_qa = 관리자 204', r.s === 204, r.s);
    r = await gate('/_trend/trend-lite.json', MB); chk('트렌드 = 회원 204(공유)', r.s === 204, r.s);
    r = await gate('/_trend/trend-lite.json'); chk('트렌드 비로그인 = 401', r.s === 401, r.s);
    r = await gate('/_trend/_live-posts.json', BD); chk('다른 _trend 파일 = 작성자 404', r.s === 404, r.s);
    r = await gate('/_toolbox/tier.js', MB); chk('도구함 코드 = 회원 204', r.s === 204, r.s);
    r = await gate('/_cal/cal.js', MB); chk('달력 코드 = 회원 204', r.s === 204, r.s);
    r = await gate('/DESIGN.md', BD); chk('루트 문서 = 작성자 404', r.s === 404, r.s);
    r = await gate('/_tools/build-manifest.ps1', ADM); chk('_tools = 관리자 204(관리자만)', r.s === 204, r.s);
    r = await gate('/posts.json', BD); chk('범위 데이터가 정적으로 오면 404(설정 사고 표시)', r.s === 404, r.s);

    /* 쿠키 경로(사이트가 실제로 쓰는 쪽) */
    const lg = await call('POST', '/auth/login', { username: 'bd_user', password: 'bd-pass-1234' });
    const ck = (lg.h.get('set-cookie') || '').split(';')[0];
    r = await gate('/봄딩/애니모/주제/봄딩_미리보기_a.html', { Cookie: ck }); chk('★쿠키만으로 통과(forward_auth 가 원 요청 쿠키를 싣는다)', ck.startsWith('sd_auth=') && r.s === 204, [ck.slice(0, 12), r.s]);

    /* ── /site-data ── */
    r = await call('GET', '/site-data/posts.json'); chk('범위 데이터 비로그인 = 401', r.s === 401, r.s);
    r = await call('GET', '/site-data/posts.json', undefined, ADM); chk('관리자 posts = 원본 3행', r.s === 200 && r.j.length === 3, r.j);
    r = await call('GET', '/site-data/posts.json', undefined, BD); chk('봄딩 posts = 봄딩 2행(보관 포함 · 영도 없음)', r.s === 200 && r.j.length === 2 && r.j.every((p) => p.author === '봄딩'), r.j);
    r = await call('GET', '/site-data/posts.json', undefined, MB); chk('회원 posts = 빈 배열', r.s === 200 && Array.isArray(r.j) && r.j.length === 0, r.j);
    r = await call('GET', '/site-data/manifest.json', undefined, YD); chk('영도 manifest = 영도 키만', r.s === 200 && Object.keys(r.j).length === 1 && Object.keys(r.j)[0].startsWith('영도/'), r.j);
    r = await call('GET', '/site-data/published.json', undefined, BD); chk('봄딩 published = 봄딩 rel 만', r.s === 200 && r.j.publishedRels.length === 1 && r.j.publishedRels[0].startsWith('봄딩/'), r.j);
    r = await call('GET', '/site-data/reopen.json', undefined, BD); chk('봄딩 reopen = 0행', r.s === 200 && r.j.rels.length === 0, r.j);
    r = await call('GET', '/site-data/_trend/_usage.json', undefined, BD); chk('봄딩 사용량 = 봄딩 몫만(tok 10)', r.s === 200 && r.j.days[0].tok === 10 && !('영도' in r.j.days[0].by), r.j);
    r = await call('GET', '/site-data/_trend/_usage.json', undefined, MB); chk('회원 사용량 = 403', r.s === 403, r.s);
    r = await call('GET', '/site-data/_trend/_quota.json', undefined, BD); chk('잔여 사용량 = 작성자 403', r.s === 403, r.s);
    r = await call('GET', '/site-data/_trend/_quota.json', undefined, ADM); chk('잔여 사용량 = 관리자 200', r.s === 200, r.s);
    r = await call('GET', '/site-data/_trend/_kpi.json', undefined, YD); chk('영도 지표 = 영도만', r.s === 200 && Object.keys(r.j.writers).join() === '영도', r.j);
    r = await call('GET', '/site-data/_trend/_hero.json', undefined, YD); chk('효자 글(봄딩 전용) = 영도 403', r.s === 403, r.s);
    r = await call('GET', '/site-data/_trend/_hero.json', undefined, BD); chk('효자 글 = 봄딩 200', r.s === 200, r.s);
    r = await call('GET', '/site-data/_trend/_refresh.json', undefined, BD); chk('갱신할 글 = 봄딩 것만', r.s === 200 && r.j.items.length === 1 && r.j.items[0].writer === '봄딩', r.j);
    r = await call('GET', '/site-data/_trend/_citations.json', undefined, MB); chk('블로그 활동 = 회원 403', r.s === 403, r.s);
    r = await call('GET', '/site-data/_trend/_game-cats.json', undefined, ADM); chk('없는 파일 = 404', r.s === 404, r.s);
    r = await call('GET', '/site-data/../users.json', undefined, ADM); chk('목록 밖 경로 = 404', r.s === 404, r.s);
    r = await call('GET', '/site-data/posts.json', undefined, BD); chk('Cache-Control no-store', /no-store/.test(r.h.get('cache-control') || ''), r.h.get('cache-control'));

    /* 기존 API 가 그대로인지 한 줄 */
    r = await call('GET', '/health'); chk('health 그대로', r.s === 200, r.s);
    r = await call('GET', '/requests'); chk('강제 모드 /requests 비로그인 401 그대로', r.s === 401, r.s);
  } catch (e) {
    fail++; console.log('  FAIL 예외 ' + (e && e.stack));
  } finally {
    srv.close();
    console.log('\n' + pass + '/' + (pass + fail) + ' PASS' + (fail ? ' · FAIL ' + fail : ''));
    process.exit(fail ? 1 : 0);
  }
})();
