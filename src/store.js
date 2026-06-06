'use strict';
/* 초경량 JSON 파일 스토어.
   - SQLite(네이티브 빌드 필요) 대신 파일 기반 → e2-micro(1GB) 의존성 최소화.
   - 저장량이 작고(요청/구독 수백~수천 건) 동시성이 낮은 워크로드라 충분.
   - 쓰기는 임시파일 + rename 으로 원자적 처리(중간 크래시에도 파일 손상 방지).
   - 프로세스 내 직렬화 큐로 동시 쓰기 레이스를 방지(단일 프로세스 가정). */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function createCollection(dataDir, name) {
  const file = path.join(dataDir, `${name}.json`);
  let writeChain = Promise.resolve();

  function readSync() {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      const arr = JSON.parse(txt);
      return Array.isArray(arr) ? arr : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      // 손상 파일: 백업 후 빈 컬렉션으로 시작(데이터 유실보다 가용성 우선, 백업 남김)
      try { fs.renameSync(file, file + '.corrupt.' + Date.now()); } catch (_) {}
      return [];
    }
  }

  async function writeAll(arr) {
    // 직렬화: 이전 쓰기가 끝난 뒤 실행
    writeChain = writeChain.then(async () => {
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(arr, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    });
    return writeChain;
  }

  return {
    file,
    all() { return readSync(); },
    find(pred) { return readSync().find(pred); },
    async insert(rec) {
      const arr = readSync();
      arr.push(rec);
      await writeAll(arr);
      return rec;
    },
    async update(id, patch) {
      const arr = readSync();
      const i = arr.findIndex((r) => r.id === id);
      if (i === -1) return null;
      arr[i] = Object.assign({}, arr[i], patch);
      await writeAll(arr);
      return arr[i];
    },
    async upsertBy(keyFn, rec) {
      const arr = readSync();
      const key = keyFn(rec);
      const i = arr.findIndex((r) => keyFn(r) === key);
      if (i === -1) arr.push(rec);
      else arr[i] = Object.assign({}, arr[i], rec);
      await writeAll(arr);
      return rec;
    },
    async removeBy(pred) {
      const arr = readSync();
      const kept = arr.filter((r) => !pred(r));
      const removed = arr.length - kept.length;
      if (removed) await writeAll(kept);
      return removed;
    },
  };
}

function initStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    requests: createCollection(dataDir, 'requests'),
    subscriptions: createCollection(dataDir, 'subscriptions'),
    // 숨김(hide) — 글 rel 단위 소프트 숨김 목록. admin 토큰 없이 누구나 추가/해제(즉시 반영, 가역).
    // 실제 글 파일은 그대로 두고 사이트·PWA 목록에서만 가린다(깃 커밋·삭제 아님).
    hidden: createCollection(dataDir, 'hidden'),
  };
}

module.exports = { initStore };
