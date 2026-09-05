'use strict';
/* 환경설정 로딩 — .env 를 읽어 하나의 config 객체로 정규화한다. */
require('dotenv').config();

const path = require('path');

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function csv(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// BASE_PATH 정규화: 앞에 '/' 보장, 끝의 '/' 제거. 빈 값이면 '' (루트).
function normBase(p) {
  if (!p) return '';
  let s = String(p).trim();
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '');
}

const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  basePath: normBase(process.env.BASE_PATH),
  corsOrigins: csv(process.env.CORS_ORIGINS),

  // 관리자 토큰 — 상태 갱신/푸시 트리거 등 쓰기 권한 엔드포인트 보호용.
  // 비어 있으면 해당 엔드포인트는 503(잠김). deploy.sh가 자동 발급.
  adminToken: process.env.ADMIN_TOKEN || '',

  dataDir: path.join(__dirname, '..', 'data'),
  uploadDir: path.join(__dirname, '..', 'data', 'uploads'),

  // 새 글 요청 첨부(외주 1회용 참고문서) 제한
  attachment: {
    maxBytes: parseInt(process.env.ATTACH_MAX_BYTES || String(20 * 1024 * 1024), 10), // 기본 20MB(파일당) — 2026-09-05 10→20MB
    maxFiles: parseInt(process.env.ATTACH_MAX_FILES || '5', 10),                        // 요청당 최대 5개 — 2026-09-05 1→5
    // 허용 확장자(소문자, 점 없이). hwp(구포맷)는 서버 추출이 까다로워 1차 제외 — hwpx는 허용.
    allowedExt: ['docx', 'xlsx', 'pdf', 'txt', 'hwpx'],
  },

  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },

  agent: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    githubToken: process.env.GITHUB_TOKEN || '',
    gitRepo: process.env.GIT_PUBLISH_REPO || '',
    gitBranch: process.env.GIT_PUBLISH_BRANCH || 'main',
    gitAuthorName: process.env.GIT_AUTHOR_NAME || 'blog-company-bot',
    gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'bot@example.com',
  },

  scheduler: {
    autoGenCron: process.env.AUTO_GEN_CRON || '0 */2 * * *',
    autoGenEnabled: bool(process.env.AUTO_GEN_ENABLED, false),
  },

  // stale 'processing' 회수 — 작성 러너(PC)가 처리 중 중단되면 요청이 'processing'에
  // 영구히 박혀 다시 안 잡히는 문제를 막는다. 임계시간 지난 processing 을 received(재시도)
  // 또는 failed(반복 실패)로 자동 복구한다. 상시 동작(autoGen 과 무관).
  reclaim: {
    // 이 시간(ms) 넘게 'processing' 이면 회수 대상. 정상 파이프라인 최대 소요보다 넉넉히.
    afterMs: parseInt(process.env.RECLAIM_AFTER_MS || String(60 * 60 * 1000), 10), // 기본 60분
    // 이 횟수 이상 processing 시도(=회수) 되면 더 안 돌리고 failed 로 종결.
    maxAttempts: parseInt(process.env.RECLAIM_MAX_ATTEMPTS || '3', 10),
    // 회수 스윕 주기(cron). 기본 10분.
    sweepCron: process.env.RECLAIM_SWEEP_CRON || '*/10 * * * *',
  },
};

// 푸시 사용 가능 여부(키 둘 다 있어야 함)
config.vapid.configured = !!(config.vapid.publicKey && config.vapid.privateKey);

// 에이전트 실제 동작 가능 여부(키 있을 때만; 없으면 stub)
config.agent.live = !!config.agent.anthropicApiKey;

module.exports = config;
