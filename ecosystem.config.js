/* PM2 설정 — `pm2 start ecosystem.config.js`
   e2-micro(1GB) 고려: 단일 인스턴스(fork), 메모리 한계 시 재시작. */
module.exports = {
  apps: [
    {
      name: 'blog-company-backend',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
      // .env 는 dotenv 가 로드(코드에서). PM2 env 에 비밀키를 넣지 않는다.
      out_file: 'logs/out.log',
      error_file: 'logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
