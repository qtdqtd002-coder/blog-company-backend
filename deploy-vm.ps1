# 쓰담 백엔드 — VM 원격 배포 헬퍼 (PC에서 실행)
# gcloud SDK + 인증(qtdqtd9516@gmail.com)이 된 상태에서, GitHub main 의 최신 코드를
# GCP VM(blog-backend / us-east1-c)에 배포하고 health 를 확인한다.
#
# 사용: powershell -File deploy-vm.ps1
# 사전: 1) blog-company-backend 변경을 git push origin main 으로 먼저 올릴 것.
#       2) gcloud 인증이 만료됐으면: gcloud auth login
#
# ★중요: 실제 앱은 VM 사용자 'qtdqtd9516' 홈에서 pm2 로 돈다(다른 사용자로 배포하면 중복 인스턴스).
#         반드시 qtdqtd9516@ 로 SSH 한다.
# ★Windows 따옴표 함정: gcloud 원격 --command 에 단일+이중 따옴표가 섞이면 인자 파싱이 깨진다.
#         복잡한 원격 스크립트는 base64 로 인코딩해 'echo <b64> | base64 -d | bash|python3' 로 보낼 것.

$ErrorActionPreference = 'Stop'
$gc = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.ps1"
$INSTANCE = 'blog-backend'
$ZONE = 'us-east1-c'
$SSH_USER = 'qtdqtd9516'
$DEPLOY_URL = 'https://qtdqtd002-coder.github.io/bomding-blog-preview/deploy.sh'

Write-Host "▶ VM 배포 시작: $SSH_USER@$INSTANCE ($ZONE)" -ForegroundColor Cyan
& $gc compute ssh "$SSH_USER@$INSTANCE" --zone $ZONE --quiet --command "curl -fsSL $DEPLOY_URL | bash"

Write-Host "`n▶ 회수 크론 등록 확인" -ForegroundColor Cyan
& $gc compute ssh "$SSH_USER@$INSTANCE" --zone $ZONE --quiet --command "pm2 logs blog-company-backend --lines 40 --nostream | grep -i reclaim | tail -2"

Write-Host "`n▶ 배포 완료. health: https://34.139.184.70.sslip.io/health" -ForegroundColor Green
