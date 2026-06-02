'use strict';
/* VAPID 키페어 생성기.
   사용:  npm run gen:vapid
   - 공개키(PUBLIC): PWA app/api.js 의 VAPID_PUBLIC_KEY 와 서버 .env 양쪽에 동일 입력(공개 안전).
   - 비밀키(PRIVATE): 서버 .env 에만. 절대 외부 노출/커밋 금지.
   이 스크립트는 키를 콘솔에만 출력하고 파일에 쓰지 않는다(실수 커밋 방지). */
const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();

console.log('\n=== VAPID 키페어 생성됨 ===\n');
console.log('서버 .env 에 붙여넣기 ↓');
console.log('-----------------------------------------');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('-----------------------------------------\n');
console.log('PWA app/api.js 의 BC_CONFIG 에 공개키만 ↓');
console.log('-----------------------------------------');
console.log(`VAPID_PUBLIC_KEY: '${keys.publicKey}',`);
console.log('-----------------------------------------\n');
console.log('⚠ PRIVATE 키는 서버에만 보관하세요. 깃/채팅/로그에 남기지 마세요.\n');
