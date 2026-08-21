# GRASP 프로필 Discord 봇

이 서비스는 GRASP 구성원이 자신의 공개 웹사이트 프로필만 수정할 수 있게 해 주는 제한된 Discord 인터페이스다. 저장소 경로, 임의 JSON, 임의 커밋, 범용 GitHub 작업은 입력받지 않는다.

## 구현 범위와 안전 경계

- `/register`는 관리자 승인 없이 명령을 실행한 Discord 계정에 프로필 하나를 연결한다. 새 프로필은 `listed: false`로 시작한다.
- `/profile`에서 정해진 프로필 필드, 구성원 분류, 사진, Members 페이지 표기 여부를 수정한다.
- 사진은 JPEG, PNG, WebP만 받는다. EXIF 방향을 적용하고 중앙을 기준으로 정확한 4:5 비율로 자른 뒤, 확대하지 않고 최대 800×1000으로 축소한다. 메타데이터를 제거해 WebP로 변환하며, Discord 미리보기에서 사용자가 확인해야 게시한다.
- `DISCORD_OWNER_USER_ID`로 지정된 관리자만 다른 계정의 프로필을 강제 숨김, 연결 정지·복구·이전하거나 구성원 분류를 교정할 수 있다. 관리자 여부는 Discord 상호작용 계층과 서비스 계층에서 각각 다시 검사한다.
- 프로필 작업은 `src/data/members/<slug>.json`과 필요한 경우 `src/data/members/<slug>.webp`만 수정할 수 있다.
- GitHub 반영은 기존 blob SHA 확인, 격리된 `bot/profile/...` 브랜치, 저장소 검증 workflow, `main` 비강제 fast-forward 순서로 진행한다. 성공 응답은 단순히 커밋이 만들어졌다는 뜻이 아니라 해당 Pages 배포 성공까지 확인했다는 뜻이다.
- 검증 및 배포 확인에는 Discord interaction token 유효시간 안에 결과를 전달하기 위한 제한 시간이 있다. 시간 초과 시 안전하게 중단하거나 `published_deploy_failed`로 표시하며, `main`을 force-push하거나 자동 rollback하지 않는다.

`listed`는 Members 페이지 표시 설정일 뿐 개인정보 보호 기능이 아니다. 프로필 JSON, 사진, 커밋과 Git 기록은 계속 공개 저장소에 남는다.

## 로컬 검증

Node.js 24 이상이 필요하다.

```bash
cd bot
npm ci
npm run check
npm run build
```

테스트는 메모리 SQLite, 생성된 이미지 fixture, 가짜 Discord webhook/CDN, 모의 GitHub 응답을 사용한다. Discord, GitHub, Railway 자격증명은 필요하지 않다.

따라서 개발과 자동 테스트를 끝내는 데는 Discord 서버 설치 권한이 필요하지 않다. 실제 서버 설치와 명령 등록은 배포 직전에 서버 관리 권한이 있는 사람이 진행하면 된다.

로컬에서 서비스를 실행하려면 `.env.example`을 `.env`로 복사해 값을 채우고 셸 환경변수로 불러온 다음 `npm run dev`를 실행한다. `.env`, GitHub App PEM 파일, 토큰은 절대 커밋하지 않는다.

## 실제 배포 순서

1. 이 봇 관련 커밋을 GitHub `main`에 먼저 올린다. 특히 `.github/workflows/validate-profile-bot.yml`이 첫 프로필 게시 전에 `main`에 있어야 한다.
2. Discord Application과 GitHub App을 만들고 아래 값을 준비한다.
3. Railway에 저장소를 연결하고 `/data` volume과 환경변수를 설정해 배포한다.
4. Railway의 공개 HTTPS 도메인이 생기면 Discord Interactions Endpoint URL을 `https://<domain>/interactions`로 설정한다.
5. 로컬 `bot/` checkout에서 `npm run register:commands`를 한 번 실행해 guild 명령을 등록한다.
6. 실제 첫 등록 직전에 기존 수동 프로필 `taein-oh.json`과 `taein-oh.png`를 일반 커밋으로 제거하고 Pages 배포 완료를 기다린다.
7. Discord에서 관리자가 `/register`를 실행한 뒤 `/profile`로 정보와 사진을 채우고 마지막에 사이트 표기를 켠다.

기존 수동 프로필은 개발 중 Members 페이지가 미리 사라지지 않도록 현재 저장소에 그대로 두었다.

## 외부 서비스별 설정

### 1. Discord Application

Discord Developer Portal에서 Application을 만들고 `applications.commands` scope만 사용해 GRASP 서버에 설치한다. HTTP interaction 방식이므로 Gateway intent와 Discord 채널 권한은 필요하지 않다.

다음 값을 Railway 환경변수로 준비한다.

- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_GUILD_ID`
- `DISCORD_OWNER_USER_ID`

`DISCORD_BOT_TOKEN`은 로컬에서 `npm run register:commands`를 실행할 때만 사용한다. 배포된 HTTP 서비스는 이 토큰을 읽지 않는다. 이 명령은 `src/discord/commands.ts`에 정의된 세 가지 guild 명령으로 해당 Application의 guild 명령 목록을 교체한다. 개발 의존성을 제거한 production image에서는 이 일회성 명령을 실행할 수 없으므로 반드시 로컬 `bot/` checkout에서 실행한다.

관리자 명령의 실제 보안 경계는 `DISCORD_OWNER_USER_ID` 검사다. Discord integration 설정에서 명령 노출을 추가로 제한할 수 있지만, 그 UI 설정에 보안을 의존하지 않는다.

### 2. GitHub App

비공개 GitHub App을 만들고 `grasp-kaist/grasp-kaist.github.io` 저장소 하나에만 설치한다. Repository permissions는 다음과 같이 설정한다.

- Contents: Read and write
- Actions: Read-only
- Pages: Read-only
- Metadata: 자동 포함

Workflows, Pull requests, Administration, Checks, Pages write 권한은 사용하지 않는다. 다음 값을 서비스 환경변수로만 저장한다.

- `GITHUB_APP_ID`
- `GITHUB_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`: Railway 권장 방식
- 또는 로컬 전용 `GITHUB_APP_PRIVATE_KEY_PATH`

나중에 repository rule 때문에 직접 fast-forward가 막히면 publisher를 약화하거나 force-push를 허용하지 말고, 이 App에만 필요한 최소 bypass를 부여한다.

### 3. Railway 서비스

이 저장소를 항상 실행되는 서비스 하나에 연결한다. 커밋된 `railway.json`은 `bot/Dockerfile`, bot/schema 변경에 한정된 재빌드, `/healthz` 검사를 설정한다. Replica는 하나만 사용하고 `/data`에 persistent volume을 연결한다. SQLite는 단일 writer 구성이므로 수평 복제하지 않는다.

컨테이너는 시작할 때만 root로 `/data` 소유권을 비권한 `node` 사용자에게 넘기고, 서비스 로드 전에 UID/GID를 낮춘다. `RAILWAY_RUN_UID`는 설정하지 않는다. 저장소의 entrypoint가 volume 권한을 처리하면서 봇 자체는 root로 실행하지 않는다.

`.env.example`의 값 중 `DISCORD_BOT_TOKEN`을 제외한 항목을 Railway Variables에 넣고 공개 HTTPS 도메인을 생성한다. Discord의 초기 응답 제한을 안정적으로 지키기 위해 app sleeping/serverless mode는 끈다. 웹사이트는 계속 GitHub Pages에 두고 Railway에는 Discord interaction 서비스만 실행한다.

권장 운영 설정은 다음과 같다.

- `DATABASE_PATH=/data/grasp-profile-bot.sqlite`
- 서비스 replica 1개
- volume 일일 backup
- MVP에서는 custom domain과 외부 database 사용 안 함

## 런타임 endpoint

- `POST /interactions`: 서명 검증을 거치는 Discord interaction endpoint
- `GET /healthz`: Railway 상태 검사 endpoint

프로필 REST API, 로그인 페이지, 범용 webhook, 파일 브라우저, 임의 저장소 수정 endpoint는 제공하지 않는다.
