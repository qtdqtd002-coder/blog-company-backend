'use strict';
/* ============================================================
   에이전트 러너 — 2b 자리표시(placeholder).
   ------------------------------------------------------------
   책임: "발행 요청 1건"을 받아 → 글 생성 → 깃 발행 → (호출자가) 푸시.
   2a(지금): 실제 Claude API 호출 / git 발행은 STUB.
            - config.agent.live === false(키 없음) → 항상 stub.
            - 키가 있어도 2b 구현 전까지는 stub 으로 동작하되,
              "여기에 실제 구현이 들어간다"는 지점을 명확히 표시(throw 아님 → 파이프라인 검증 가능).
   2b(다음): generatePost()/publishPost() 내부의 TODO 블록을 실제 구현으로 교체.
            인터페이스(입출력 모양)는 그대로 유지하면 server/스케줄러 수정 불필요.
   ============================================================ */
const config = require('../config');

const WRITERS = ['봄딩', '영도', '겜더쿠', '연봄'];  // ★김복리 제거(2026-08-04 작성자 폐지). 하루살이는 아직 미등재 — 필요해지면 여기에 추가한다(누락 시 routes.js:140이 writer를 null로 지운다).

// ★휴면(inactive) 작성자 — 2026-08-14 사용자 지시로 트렌드·발행 요청 배선을 끊었다(폐지 아님).
// WRITERS 에서 지우지 않고 별도로 둔 이유: 과거 요청 646건의 writer 값이 유효한 채로 남아야 목록·통계가 깨지지 않는다.
// 새 요청만 거부한다(routes.js POST /requests). 재개하려면 이 배열을 [] 로 되돌리고 재배포한다.
// 정본 = 쓰담v2/canon/config.json → writers.inactive.
const INACTIVE_WRITERS = ['겜더쿠', '연봄', '하루살이'];  // 하루살이 추가 2026-09-02

// ★글의 목적(purpose) — 정본 shared/blog-writing/post-purpose-guide.md 의 라벨과 1:1.
// PWA/사이트 요청이 필수로 보내는 값. 알 수 없는 값은 '기타'로 정규화한다(거부하지 않음).
const PURPOSES = [
  '사전예약', '출시·첫인상', '업데이트·패치', '게임 정보', '게임 공략',
  '쿠폰·이벤트', '티어·추천', '제품 비교·추천', '사용 후기·리뷰', '기타',
];
const DEFAULT_PURPOSE = '기타';

/* ---- 1) 글 생성 ----------------------------------------------------------
   입력:  request = { id, topic, material, writer, ... }
   출력:  post    = { title, html, writer, category, slug, meta:{...} }       */
async function generatePost(request) {
  const writer = WRITERS.includes(request.writer) ? request.writer : '봄딩';

  // ===== TODO(2b): 실제 글 생성 =====================================
  // 이 자리에서 game-blog-publish 파이프라인(작성→QA→수정)을 호출한다.
  // 예시(2b 구현 시 활성화):
  //   if (config.agent.live) {
  //     return await callBlogCompanyPipeline({
  //       apiKey: config.agent.anthropicApiKey,
  //       model: config.agent.anthropicModel,
  //       writer, topic: request.topic, material: request.material,
  //     });
  //   }
  // ==================================================================

  // 2a STUB: 실제 생성 없이 형태만 갖춘 가짜 글을 만든다(파이프라인 검증용).
  const mode = config.agent.live ? 'live-key-present(2b-미구현→stub)' : 'stub(키없음)';
  const slug = 'draft-' + request.id;
  return {
    title: `[초안] ${request.topic || '제목 미정'}`,
    html: `<!-- STUB 초안 (${mode}) -->\n<article><h1>${escapeHtml(request.topic || '')}</h1>` +
          `<p>소재: ${escapeHtml(request.material || '(없음)')}</p>` +
          `<p>작성자: ${escapeHtml(writer)}</p></article>`,
    writer,
    category: '게임',
    slug,
    meta: { stub: true, mode, requestId: request.id },
  };
}

/* ---- 2) 깃 발행 ----------------------------------------------------------
   입력:  post
   출력:  { published:boolean, url|null, stub:boolean, mode }                */
async function publishPost(post) {
  // ===== TODO(2b): 실제 GitHub Pages 발행 ===========================
  // config.agent.githubToken / gitRepo / gitBranch 로 커밋·푸시.
  // (헤드리스 브라우저 불필요 — GitHub Contents API 또는 git CLI 사용 권장)
  // 발행 후 공개 URL 을 계산해 반환한다.
  // ==================================================================

  const canPublish = !!(config.agent.githubToken && config.agent.gitRepo);
  const mode = canPublish ? 'token-present(2b-미구현→stub)' : 'stub(토큰없음)';
  return {
    published: false,
    stub: true,
    mode,
    url: null,
    note: '2a 자리표시 — 실제 발행은 2b에서 구현.',
  };
}

/* ---- 3) 요청 1건 처리(생성→발행) ----------------------------------------
   호출자(server/스케줄러)가 결과를 받아 store 갱신 + 푸시를 담당한다.
   여기서는 부수효과(저장/푸시) 없이 순수 처리 결과만 반환한다.              */
async function processRequest(request) {
  const startedAt = Date.now();
  const post = await generatePost(request);
  const publish = await publishPost(post);
  return {
    requestId: request.id,
    post,
    publish,
    live: config.agent.live,
    durationMs: Date.now() - startedAt,
  };
}

/* ---- 4) 자동 신작 생성(스케줄러가 주기적으로 호출) ----------------------
   2b: 트렌드/주제 선정 → processRequest 흐름. 지금은 stub 트리거만.        */
async function autoGenerate() {
  console.log('[agent] autoGenerate 트리거(stub) — 2b에서 신작 주제 선정+생성 구현 예정.');
  return { triggered: true, stub: true, at: new Date().toISOString() };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

module.exports = { processRequest, generatePost, publishPost, autoGenerate, WRITERS, INACTIVE_WRITERS, PURPOSES, DEFAULT_PURPOSE };
