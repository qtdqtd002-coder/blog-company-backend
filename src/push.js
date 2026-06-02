'use strict';
/* 웹 푸시(VAPID) 래퍼.
   - VAPID 키가 설정되어 있을 때만 활성화.
   - 구독 저장은 store(subscriptions)에 위임, 여기선 발송 로직만.
   - 만료/무효 구독(404/410)은 자동 정리. */
const webpush = require('web-push');
const config = require('./config');

let enabled = false;

function init() {
  if (!config.vapid.configured) {
    console.warn('[push] VAPID 키 미설정 → 푸시 비활성화 (구독 수신은 받되 발송은 skip). `npm run gen:vapid` 후 .env 설정 필요.');
    enabled = false;
    return false;
  }
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  enabled = true;
  console.log('[push] VAPID 설정 완료 → 웹 푸시 활성화.');
  return true;
}

function isEnabled() { return enabled; }

/* 단일 구독에 발송. 실패 시 {ok, gone} 반환(gone=구독 만료/무효). */
async function sendOne(subscription, payloadObj) {
  if (!enabled) return { ok: false, skipped: true };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payloadObj));
    return { ok: true };
  } catch (err) {
    const code = err && err.statusCode;
    const gone = code === 404 || code === 410;
    return { ok: false, gone, statusCode: code, error: String((err && err.message) || err) };
  }
}

/* 전체 구독자에게 브로드캐스트. store 를 받아 만료 구독은 정리한다.
   payloadObj 예: { title, body, url, tag } — sw.js push 핸들러가 그대로 사용. */
async function broadcast(store, payloadObj) {
  if (!enabled) {
    console.warn('[push] broadcast skip: 푸시 비활성화 상태.');
    return { sent: 0, failed: 0, removed: 0, skipped: true };
  }
  const subs = store.subscriptions.all();
  let sent = 0, failed = 0, removed = 0;
  for (const s of subs) {
    const r = await sendOne(s.subscription, payloadObj);
    if (r.ok) { sent++; continue; }
    failed++;
    if (r.gone) {
      await store.subscriptions.removeBy((x) => x.endpoint === s.endpoint);
      removed++;
    }
  }
  console.log(`[push] broadcast 완료: 발송 ${sent}, 실패 ${failed}, 만료정리 ${removed} (총구독 ${subs.length})`);
  return { sent, failed, removed, total: subs.length };
}

module.exports = { init, isEnabled, sendOne, broadcast };
