'use strict';
/* ============================================================================
   site.js — 쓰담 사이트(정적 파일)를 로그인 뒤로 옮기는 문지기 (2026-11-24 · 3단계)

   왜: 2026-11-23 회원·역할 도입 뒤에도 사이트 파일(글 본문·posts.json·트렌드)은 GitHub Pages 공개 주소라
       주소만 알면 누구나 받을 수 있었다. 3단계 = VM 이 사이트를 직접 내주고(Caddy) 저장소는 비공개.

   구조(Caddy 드롭인 /etc/caddy/conf.d/sseudam.caddy — deploy/sseudam.caddy 가 정본):
     /api/*          → 이 백엔드(접두사 떼고) — 사이트가 같은 출처로 부른다 → 로그인 쿠키(sd_auth) 하나로 끝
     SCOPED 데이터    → /site-data/<경로> 로 바꿔 이 백엔드 — 계정 범위로 거른 JSON(아래 FILTERS)
     그 밖의 파일     → forward_auth(GET /auth/gate) 통과 시 file_server(SITE_ROOT)

   /auth/gate 판정(X-Forwarded-Uri 기준 · 위에서부터 처음 맞는 줄):
     · . 로 시작하는 조각(.git 등)·.. → 404
     · 열림  : 첫 화면(index.html 등 로그인 화면을 그리는 파일)·라이브러리(_vendor·_design·pwa-assets)
               ·★사진(png·jpg·webp·gif·svg·avif) — 네이버 편집기가 붙여넣은 사진을 «네이버 서버가» 이 주소에서 받아 간다.
                 쿠키를 못 싣는 요청이라 잠그면 봄딩·영도 붙여넣기 사진이 전부 빠진다(naver-npaste.js 가 text/html + 절대 주소 img 로 복사).
                 주소를 모르면 못 찾는다 — 목록(posts.json)과 글 본문은 잠겨 있다.
     · 회원  : 도구함·달력 코드(_toolbox·_cal·app)·트렌드(_trend/trend*.json — 로그인한 모두에게 공유, 11-23 결정)
     · 작성자 폴더(봄딩/·영도/·하루살이/) : 관리자 또는 그 작성자 계정만. _qa 조각은 관리자만.
     · 그 밖 : 관리자만(회원·작성자는 404 — 있는지도 알리지 않는다)
     비로그인 → 401(화면 이동 요청이면 302 → / 로그인 화면)
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const express = require('express');

const AUTHORS = ['봄딩', '영도', '하루살이'];
const IMG = /\.(png|jpe?g|webp|gif|svg|avif|ico)$/i;
const OPEN_FILES = new Set(['/', '/index.html', '/404.html', '/robots.txt', '/site.webmanifest', '/sw.js', '/favicon.ico']);
const OPEN_PREFIX = ['/_vendor/', '/_design/', '/pwa-assets/'];
const MEMBER_PREFIX = ['/_toolbox/', '/_cal/', '/app/'];
const MEMBER_FILES = new Set(['/_trend/trend.json', '/_trend/trend-lite.json']);
const IMG_OK_PREFIX = ['/_toolbox/', '/_design/', '/_vendor/', '/pwa-assets/', '/app/'].concat(AUTHORS.map((a) => '/' + a + '/'));

/* 계정 범위로 거르는 데이터 — 사이트 index.html scopeData()와 같은 규칙(화면 범위 → 파일 범위로 끌어내림).
   반환 null = 이 계정엔 없음(403 → 사이트 jget 이 «없음»으로 받는다 · 0 위장 금지 규칙과 같은 뜻) */
const ownRel = (w) => (rel) => typeof rel === 'string' && !!w && rel.split('/')[0] === w;
const FILTERS = {
  '/posts.json': (j, w) => (Array.isArray(j) ? j.filter((p) => p && ownRel(w)(p.rel)) : []),
  '/manifest.json': (j, w) => {
    const o = {};
    if (j && typeof j === 'object') for (const k of Object.keys(j)) if (ownRel(w)(k)) o[k] = j[k];
    return o;
  },
  '/published.json': (j, w) => Object.assign({}, j, { publishedRels: ((j && j.publishedRels) || []).filter(ownRel(w)) }),
  '/reopen.json': (j, w) => Object.assign({}, j, {
    rels: ((j && j.rels) || []).filter((x) => ownRel(w)(x && typeof x === 'object' ? x.rel : x)),
  }),
  '/_trend/_usage.json': (j, w) => {
    if (!w || !j || !Array.isArray(j.days)) return null;
    return Object.assign({}, j, {
      days: j.days.map((d) => {
        const t = (d.by && d.by[w]) || 0, c = (d.costBy && d.costBy[w]) || 0;
        return Object.assign({}, d, { tok: t, cost: c, by: { [w]: t }, costBy: { [w]: c } });
      }),
    });
  },
  '/_trend/_quota.json': () => null,        // 운영자 Claude 계정 한도 — 관리자만
  '/_trend/_desk-mix.json': () => null,     // 전체 집계 — 관리자만
  '/_trend/_citations.json': (j, w) => {
    const cw = ((j && j.writers) || []).filter((x) => x && x.name === w);
    return cw.length ? Object.assign({}, j, { writers: cw }) : null;
  },
  '/_trend/_refresh.json': (j, w) => (j && Array.isArray(j.items) ? Object.assign({}, j, { items: j.items.filter((x) => x && x.writer === w) }) : null),
  '/_trend/_kpi.json': (j, w) => (j && j.writers && w && j.writers[w] ? Object.assign({}, j, { writers: { [w]: j.writers[w] } }) : null),
  '/_trend/_hero.json': (j, w) => (w === '봄딩' ? j : null),       // 셋 다 봄딩 블로그 데이터
  '/_trend/_game-cats.json': (j, w) => (w === '봄딩' ? j : null),
  '/_trend/_pin-suggest.json': (j, w) => (w === '봄딩' ? j : null),
};
const SCOPED = Object.keys(FILTERS);

function decodePath(raw) {
  let p = String(raw || '/').split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch (e) { return null; }
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');
  if (p.includes('\0') || p.includes('\\')) return null;
  return p;
}

/* 판정 — { ok:true } 또는 { status, why } */
function decide(p, who) {
  if (p === null) return { status: 400, why: 'bad-path' };
  const segs = p.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s.startsWith('.'))) return { status: 404, why: 'hidden' };
  if (OPEN_FILES.has(p) || OPEN_PREFIX.some((x) => p.startsWith(x))) return { ok: true, why: 'open' };
  if (IMG.test(p) && IMG_OK_PREFIX.some((x) => p.startsWith(x)) && !segs.includes('_qa')) return { ok: true, why: 'image' };
  if (!who) return { status: 401, why: 'login' };
  const admin = who.role === 'admin';
  if (admin) return { ok: true, why: 'admin' };
  if (SCOPED.includes(p)) return { status: 404, why: 'scoped-via-site-data' };   // Caddy 가 /site-data 로 돌린다 — 여기 오면 설정 사고
  if (MEMBER_FILES.has(p) || MEMBER_PREFIX.some((x) => p.startsWith(x))) return { ok: true, why: 'member' };
  if (AUTHORS.includes(segs[0])) {
    if (segs.includes('_qa')) return { status: 404, why: 'qa-admin' };
    if (who.role === 'writer' && who.writer === segs[0]) return { ok: true, why: 'own-writer' };
    return { status: 404, why: 'other-writer' };
  }
  return { status: 404, why: 'admin-only' };
}

function create({ whoOf, root }) {
  const r = express.Router();
  const ROOT = path.resolve(root);
  const cache = new Map();   // 경로 → { mtimeMs, json }
  function readJson(rel) {
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT + path.sep)) return undefined;
    let st;
    try { st = fs.statSync(f); } catch (e) { return undefined; }
    const c = cache.get(rel);
    if (c && c.mtimeMs === st.mtimeMs) return c.json;
    let json;
    try { json = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { return undefined; }
    cache.set(rel, { mtimeMs: st.mtimeMs, json });
    return json;
  }

  /* Caddy forward_auth — 원래 요청의 머리(쿠키 포함)가 그대로 온다 */
  r.get('/auth/gate', (req, res) => {
    const p = decodePath(req.get('X-Forwarded-Uri'));
    const d = decide(p, whoOf(req));
    res.set('Cache-Control', 'no-store');
    if (d.ok) return res.status(204).end();
    if (d.status === 401) {
      const nav = /text\/html/.test(req.get('Accept') || '') && (req.get('X-Forwarded-Method') || 'GET') === 'GET';
      if (nav) { res.set('Location', '/'); return res.status(302).end(); }
    }
    return res.status(d.status).type('text/plain').send(d.status === 401 ? 'login required' : 'not found');
  });

  /* 계정 범위 데이터 — 관리자는 원본 그대로 */
  r.get(/^\/site-data(\/.*)$/, (req, res) => {
    const p = decodePath(req.params[0]);
    res.set('Cache-Control', 'no-store');
    if (!p || !FILTERS[p]) return res.status(404).type('text/plain').send('not found');
    const who = whoOf(req);
    if (!who) return res.status(401).type('text/plain').send('login required');
    const j = readJson(p.slice(1));
    if (j === undefined) return res.status(404).type('text/plain').send('not found');
    if (who.role === 'admin') return res.json(j);
    const w = who.role === 'writer' ? who.writer : null;
    const out = FILTERS[p](j, w);
    if (out === null || out === undefined) return res.status(403).type('text/plain').send('not in scope');
    return res.json(out);
  });
  return r;
}

module.exports = { create, decide, decodePath, FILTERS, SCOPED };
