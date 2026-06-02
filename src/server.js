'use strict';
/* 서버 엔트리 — Express 앱 구성 + 부팅. */
const express = require('express');
const cors = require('cors');

const config = require('./config');
const { initStore } = require('./store');
const push = require('./push');
const scheduler = require('./scheduler');
const { buildRouter } = require('./routes');

function createApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // 리버스 프록시(nginx 등) 뒤에 둘 때 대비

  // CORS: 설정된 출처만 허용. 비어있으면 전체 허용(개발용).
  const corsOpts = config.corsOrigins.length
    ? { origin: config.corsOrigins }
    : { origin: true };
  app.use(cors(corsOpts));

  app.use(express.json({ limit: '256kb' })); // 푸시 구독 객체 여유 한도

  // 루트 안내(헬스 위치 등)
  app.get('/', (req, res) => {
    res.json({
      service: 'blog-company-backend',
      basePath: config.basePath || '/',
      health: (config.basePath || '') + '/health',
    });
  });

  // BASE_PATH 하위에 모든 API 마운트(계약의 {base})
  app.use(config.basePath || '/', buildRouter(store));

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

  // 에러 핸들러(잘못된 JSON 등)
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '잘못된 JSON 본문' });
    }
    console.error('[server] 처리되지 않은 오류:', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

function main() {
  const store = initStore(config.dataDir);
  push.init();
  const app = createApp(store);

  const server = app.listen(config.port, () => {
    const b = config.basePath || '';
    console.log('============================================');
    console.log(`[server] blog-company-backend 기동`);
    console.log(`[server] http://0.0.0.0:${config.port}${b || '/'}`);
    console.log(`[server] health:  http://0.0.0.0:${config.port}${b}/health`);
    console.log(`[server] CORS:    ${config.corsOrigins.length ? config.corsOrigins.join(', ') : '(all)'}`);
    console.log(`[server] push:    ${push.isEnabled() ? 'enabled' : 'disabled(VAPID 미설정)'}`);
    console.log(`[server] admin:   ${config.adminToken ? 'token 설정됨' : 'MISSING(상태/푸시 엔드포인트 잠김 — ADMIN_TOKEN 설정 필요)'}`);
    console.log(`[server] mode:    queue (작성·발행은 외부 러너가 처리)`);
    console.log('============================================');
  });

  scheduler.start(store);

  // 우아한 종료
  const shutdown = (sig) => {
    console.log(`\n[server] ${sig} 수신 → 종료`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) main();

module.exports = { createApp, main };
