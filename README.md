# 쓰담 백엔드 (2단계 · 2a)

GCP **e2-micro** 우분투 VM(1GB RAM)에 배포하는 가벼운 백엔드.
쓰담 **PWA**(`BlogPreview/app/api.js` 의 `BC_CONFIG` 계약)와 연동되고,
글 발행 완료 시 **웹 푸시(VAPID)** 를 보낸다.

> 헤드리스 브라우저 의존성 없음. 의존성 5개(express, cors, dotenv, web-push, node-cron) — 모두 순수 JS(네이티브 빌드 불필요).
> 저장소는 **JSON 파일 스토어**(SQLite 네이티브 빌드 회피). 요청/구독 수백~수천 건 규모에 적합.

---

## 1. 무엇이 들어있나 (2a 범위)

| 기능 | 상태 |
|---|---|
| `POST {base}/requests` 새 글 요청 수신 → 저장 → `{id}` 반환 (JSON 또는 multipart+첨부) | ✅ 동작 |
| `GET {base}/requests` 요청 목록/상태 | ✅ 동작 |
| `GET {base}/requests/:id/attachment` 첨부 다운로드(관리자, 작성 러너용·1회용) | ✅ 동작(ADMIN_TOKEN 필요) |
| `GET {base}/health` 헬스체크 | ✅ 동작 |
| `POST {base}/push/subscribe` 구독 저장 + 발행완료 푸시 발송 함수 | ✅ 동작(VAPID 키 설정 시) |
| `GET {base}/requests?status=received` 큐 조회(러너용) | ✅ 동작 |
| `POST {base}/requests/:id/status` 상태 갱신(관리자) → published 시 푸시 | ✅ 동작(ADMIN_TOKEN 필요) |
| `POST {base}/requests/reclaim` stale `processing` 즉시 회수(관리자) | ✅ 동작(ADMIN_TOKEN 필요) |
| `POST {base}/push/test` 테스트 푸시(관리자) | ✅ 동작(ADMIN_TOKEN 필요) |

`{base}` = `PUBLISH_API_BASE_URL` (= 서버주소 + `BASE_PATH`). PWA `api.js` 와 동일 계약.

### 2b 아키텍처(Option 2) — VM은 "큐", 작성·발행은 외부 러너
VM 백엔드는 **요청을 받아 큐에 저장(`received`)** 하고 24시간 떠 있는다.
실제 **글 작성·QA·깃 발행**은 PC의 Claude Code 예약 러너(`blog-request-runner` 스킬)가:
1. `GET {base}/requests?status=received` 로 대기 요청을 가져오고,
2. 기존 `game-blog-publish` 파이프라인(작성→QA→깃 push)으로 처리한 뒤,
3. `POST {base}/requests/:id/status` (헤더 `X-Admin-Token: <ADMIN_TOKEN>`)로 상태를 갱신한다.
   `status:"published"` 로 갱신되면 VM이 구독자에게 **발행 완료 웹푸시**를 보낸다.

상태 흐름: `received` → (러너가) `processing` → `published` | `failed` | `skipped`.

**고아(stale `processing`) 자동 회수**: 작성 러너(PC)가 처리 도중 중단(앱 종료·토큰 소진·세션 끊김·크래시)되면 요청이 `processing` 에 영구히 박혀 다시 안 잡히는 문제가 있었다. 이를 막기 위해 VM이 `RECLAIM_AFTER_MS`(기본 60분)보다 오래 `processing` 인 요청을 자동 복구한다 — 시도 `RECLAIM_MAX_ATTEMPTS`(기본 3) 미만이면 `received`(재시도), 이상이면 `failed`(종결+첨부 정리). node-cron 스윕(`RECLAIM_SWEEP_CRON`, 기본 10분)이 상시 수행하고, 러너도 회차 시작 때 `POST {base}/requests/reclaim` 로 즉시 트리거한다. `processing` 전환마다 `attempts` 가 +1 된다. `GET /health` 의 `counts.stuckProcessing` 으로 현재 고아 후보 수를 확인할 수 있다.

### 요청 본문 계약 (사이트 index.html / PWA `api.js` / 안드로이드와 일치)
```json
POST {base}/requests        (Content-Type: application/json)
{ "topic": "주제(필수)", "material": "소재(선택)", "writer": "봄딩|영도|겜더쿠|null",
  "purpose": "사전예약|출시·첫인상|업데이트·패치|게임 정보|게임 공략|쿠폰·이벤트|티어·추천|제품 비교·추천|사용 후기·리뷰|기타",
  "source": "site|pwa|android" }
→ 201 { "id": "req_...", "status": "received", "purpose": "게임 정보", "attachment": null }
```
> `purpose`(글의 목적)는 PWA/사이트가 **필수 선택**해 보낸다. 정본 라벨(위 10종, `shared/blog-writing/post-purpose-guide.md`)이 아니면 서버가 `기타`로 정규화하고, 빈 값(옛 클라이언트)은 `null`로 저장한다. 작성 러너가 이 값으로 **목적별 최소 정보 가이드**를 적용한다.
첨부(외주 1회용 참고문서)가 있으면 **multipart/form-data** 로 전송: 같은 텍스트 필드 + `attachment`(파일 1개).
- 허용: `docx, xlsx, pdf, txt, hwpx` · 최대 10MB(`ATTACH_MAX_BYTES`). 파일은 `data/uploads/` 에 저장.
- 작성 러너가 `GET {base}/requests/:id/attachment`(관리자)로 받아 **그 글에만** 반영하고, 발행/실패 처리 시 서버가 원본을 자동 삭제(1회용).

> ⚠ **재배포 주의**: 첨부 기능은 `multer` 의존성을 추가했다. VM에서 `deploy.sh` 재실행(= `git pull` + `npm install --omit=dev`)으로 설치된 뒤 pm2 reload 되어야 동작한다.

---

## 2. 폴더 구조
```
blog-company-backend/
├─ src/
│  ├─ server.js        Express 앱 + 부팅
│  ├─ config.js        .env → config
│  ├─ store.js         JSON 파일 스토어(원자적 쓰기)
│  ├─ routes.js        API 라우트(계약 1:1)
│  ├─ push.js          웹푸시(VAPID) 발송/구독정리
│  ├─ pipeline.js      러너+푸시+store 오케스트레이션
│  ├─ scheduler.js     node-cron 2시간 골격
│  └─ agent/runner.js  ★2b 자리표시(생성·발행 stub)
├─ scripts/
│  ├─ generate-vapid.js   VAPID 키페어 생성
│  └─ smoke-test.js       모듈 단위 스모크
├─ deploy/blog-company-backend.service   systemd 유닛
├─ ecosystem.config.js    PM2 설정
├─ data/                  런타임 저장(gitignore)
├─ .env.example           → .env 로 복사해 키 채움
└─ package.json
```

---

## 3. 로컬에서 빠르게 확인 (선택)
```bash
npm install
cp .env.example .env          # 키는 아직 비워도 health/requests 는 동작
npm run gen:vapid             # VAPID 키 생성 → 출력값을 .env 와 PWA api.js 에 반영
npm run smoke                 # 모듈 스모크 테스트
npm start                     # http://localhost:8080
# 다른 터미널에서:
curl localhost:8080/health
curl -X POST localhost:8080/requests -H "Content-Type: application/json" \
     -d '{"topic":"테스트","material":"소재","writer":"봄딩"}'
curl localhost:8080/requests
```

---

## 4. GCP e2-micro 우분투 VM 배포

### ① 우분투 기본 세팅 (Node 설치)
```bash
# SSH 접속 후
sudo apt update && sudo apt -y upgrade
# Node 20 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
node -v && npm -v
```
> e2-micro(1GB)에서 `npm install` 중 메모리 부족이 나면 스왑 1~2GB 추가:
> ```bash
> sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
> sudo mkswap /swapfile && sudo swapon /swapfile
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
> ```

### ② 클론 / 설치 / 키설정
```bash
cd ~
git clone <이 저장소 URL> blog-company-backend   # 또는 scp 로 폴더 업로드
cd blog-company-backend
npm install --omit=dev

cp .env.example .env
npm run gen:vapid            # 출력된 PUBLIC/PRIVATE 를 .env 에 입력
nano .env                    # VAPID_*, CORS_ORIGINS, (2b용)ANTHROPIC_API_KEY/GITHUB_TOKEN 등
```
`.env` 핵심:
- `CORS_ORIGINS=https://qtdqtd002-coder.github.io` (PWA 출처)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (gen:vapid 결과)
- `BASE_PATH=` (리버스프록시에서 `/api` 등으로 묶을 거면 그 값)

### ③ 상시 구동 — PM2 **또는** systemd 택1

**PM2 (간편)**
```bash
sudo npm i -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup            # 출력되는 sudo 명령 1줄 실행 → 부팅 시 자동기동
pm2 logs blog-company-backend
```

**systemd (의존성 적음)**
```bash
sudo cp deploy/blog-company-backend.service /etc/systemd/system/
sudo nano /etc/systemd/system/blog-company-backend.service   # User/경로/ExecStart(node 경로) 확인
sudo systemctl daemon-reload
sudo systemctl enable --now blog-company-backend
sudo systemctl status blog-company-backend
journalctl -u blog-company-backend -f
```

### ③-1 재배포 (코드 갱신 시 — 한 줄)
최초 구동(③)을 한 번 해 둔 뒤로는, 코드가 바뀔 때마다 VM에서 **한 줄**이면 된다:
```bash
cd ~/blog-company-backend && ./deploy.sh
```
`deploy.sh` 가 자동으로: **git pull → `npm install --omit=dev`(신규 의존성 설치) → `.env` 없으면 생성 → `ADMIN_TOKEN` 비어 있으면 발급(있으면 보존) → pm2/systemd 중 구동 중인 쪽으로 재시작 → 헬스체크 → ADMIN_TOKEN 출력**(PC 러너 `.runner.config.json` 에 넣을 값).
- 최초 1회만 실행 권한: `chmod +x deploy.sh`.
- `purpose`(글의 목적) 필드 추가분도 이 한 줄로 반영된다(코드 변경이라 의존성 추가는 없음).
- ⚠ VAPID 키는 PWA 공개키와 짝이라 자동 생성하지 않는다 — 없으면 경고만 출력하고, 필요 시 `npm run gen:vapid` 후 `.env` + PWA `api.js` 를 함께 갱신한다.

### ④ 방화벽 / 포트
- 기본 포트 **8080**. GCP **VPC 방화벽 규칙**에서 해당 포트(tcp:8080) 인그레스 허용 + VM 에 네트워크 태그 매칭.
- 우분투 ufw 사용 시: `sudo ufw allow 8080/tcp`.
- 동작 확인: 외부에서 `curl http://<VM_EXTERNAL_IP>:8080/health`

### ⑤ HTTPS — 차후(리버스 프록시) 메모
> **웹 푸시는 HTTPS 가 필수**(PWA 가 secure context 에서만 구독 가능). 따라서 운영 단계에서는 아래 중 하나 필요:
> - **Nginx + Let's Encrypt(certbot)**: 도메인 연결 후 `https://api.도메인` → `proxy_pass http://127.0.0.1:8080;`. 이때 8080 은 외부에 닫고 443 만 개방, `BASE_PATH=/api` 등으로 경로 통일 가능.
> - **Caddy**: 자동 HTTPS(가장 간단). `api.도메인 { reverse_proxy 127.0.0.1:8080 }`.
>
> 도메인이 준비되면 PWA `api.js` 의 `PUBLISH_API_BASE_URL` 을 `https://...` 주소로 설정한다. (현재 2a 검증은 `http://IP:8080` 로 가능하나, 푸시 구독 실연동은 HTTPS 필요)

---

## 5. PWA 연동(2단계 전환) — 본 백엔드는 PWA 파일을 건드리지 않음

배포 후, **PWA `BlogPreview/app/api.js` 의 `BC_CONFIG` 두 값만** 채우면 UI 수정 없이 자동 전환된다(별도 작업, 사용자가 진행):
```js
window.BC_CONFIG = {
  PUBLISH_API_BASE_URL: 'https://api.도메인',   // 또는 http://<VM_IP>:8080 (+ BASE_PATH)
  VAPID_PUBLIC_KEY: '<gen:vapid 의 PUBLIC>',
  // DATA_URLS, SITE_BASE 는 그대로
};
```
> 참고: 현재 `api.js` 의 `PushService.subscribe()` 는 구독 객체를 만들기만 하고 서버로 POST 하지 않는 자리(주석 표시)다. 푸시를 실제 연동하려면 그 지점에서 `POST {base}/push/subscribe` 로 `sub` 를 전송하도록 한 줄 추가가 필요하다(이 역시 PWA 쪽 작업이라 본 백엔드에서는 변경하지 않음).

---

## 6. 2b 에서 채울 자리 (자리표시 위치)
- `src/agent/runner.js`
  - `generatePost()` — `TODO(2b)`: game-blog-publish 파이프라인(작성→QA→수정) 호출. `ANTHROPIC_API_KEY` 있을 때 활성화.
  - `publishPost()` — `TODO(2b)`: `GITHUB_TOKEN`/`GIT_PUBLISH_REPO` 로 GitHub Pages 발행(브라우저 불필요, Contents API/git CLI).
  - `autoGenerate()` — `TODO(2b)`: 스케줄러가 부를 신작 주제 선정+생성.
- 발행이 실제 성공(`publish.published=true`)하면 `pipeline.js` 가 자동으로 구독자에게 푸시를 보낸다(이미 구현).

---

## 7. 보안
- 실제 키는 **`.env` 에만**. `.gitignore` 로 `.env`, `data/*.json` 제외됨.
- VAPID **PRIVATE** 키와 `ANTHROPIC_API_KEY`/`GITHUB_TOKEN` 은 깃/채팅/로그 어디에도 남기지 말 것.
- VAPID **PUBLIC** 키는 공개되어도 안전(브라우저에 노출되는 값).
