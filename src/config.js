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
    maxBytes: parseInt(process.env.ATTACH_MAX_BYTES || String(10 * 1024 * 1024), 10), // 기본 10MB
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
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
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
};

// 푸시 사용 가능 여부(키 둘 다 있어야 함)
config.vapid.configured = !!(config.vapid.publicKey && config.vapid.privateKey);

// 에이전트 실제 동작 가능 여부(키 있을 때만; 없으면 stub)
config.agent.live = !!config.agent.anthropicApiKey;

module.exports = config;
