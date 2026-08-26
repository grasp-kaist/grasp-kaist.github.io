# GRASP 프로필 Discord 봇

GRASP 구성원이 Discord의 `/register`와 `/profile`만으로 자신의 웹사이트 프로필을 만들고 수정하는 봇이다. 봇은 일반적인 Discord Gateway 방식으로 항상 접속해 있으며, 서버에 초대하면 슬래시 명령을 바로 사용할 수 있다.

## 사용자가 할 수 있는 일

- `/register`: Discord 계정에 새 프로필 하나를 연결한다. 관리자 승인은 없고, 처음에는 `listed: false`라 Members 페이지에 표시되지 않는다.
- `/profile`: 이름, 소속/직위, 설명, 연구 관심사, 연락처, 웹사이트, 구성원 분류, 사진, 공개 여부를 수정한다.
- 사진: JPEG, PNG, WebP를 받아 EXIF 방향을 적용한 뒤 중앙 기준 4:5로 자른다. 확대하지 않고 최대 800×1000으로 줄여 WebP로 변환하며, 사용자는 미리보기를 확인한 다음 게시한다.
- `/profile-admin`: `DISCORD_OWNER_USER_ID`로 지정된 사람만 프로필 숨김, 연결 정지·복구·이전, 구성원 분류 교정을 할 수 있다.

저장소 경로, 임의 JSON, 임의 커밋, 범용 GitHub 작업은 Discord 입력으로 받지 않는다.

## 현재 배포 모드

`PROFILE_PUBLISH_MODE=sandbox`가 기본값이다. 이 모드에서는 개인 테스트 서버에서 만든 프로필과 사진을 Railway의 `/data/sandbox/` 아래에만 저장한다. GRASP GitHub 저장소와 실제 웹사이트는 전혀 수정하지 않으며, SQLite도 운영용 경로와 분리한다.

실제 GRASP 서버로 전환할 때만 다음 안전장치를 모두 명시해야 한다.

```dotenv
PROFILE_PUBLISH_MODE=production
DATABASE_PATH=/data/grasp-profile-bot.sqlite
PROFILE_PRODUCTION_GUILD_ID=<GRASP 서버 ID>
DISCORD_GUILD_ID=<같은 GRASP 서버 ID>
```

production 모드는 기존 blob SHA 확인, 격리된 `bot/profile/...` 브랜치, 저장소 검증 workflow, `main` 비강제 fast-forward, GitHub Pages 배포 확인 순서로 제한된 프로필 파일만 반영한다. `PROFILE_PRODUCTION_GUILD_ID`와 현재 서버 ID가 다르면 봇이 시작되지 않는다.

`listed`는 Members 페이지 표시 설정이지 비공개 저장 기능은 아니다. production에서 게시한 JSON, 사진, 커밋 기록은 공개 저장소에 남는다.

## Discord 동작 방식

- `discord.js` Gateway 연결을 사용한다.
- 필요한 Gateway intent는 `Guilds` 하나뿐이다. 메시지 내용, 서버 구성원 목록, Presence를 읽지 않는다.
- 전역 슬래시 명령 `/register`, `/profile`, `/profile-admin`은 봇 시작 시 코드와 Discord의 현재 상태가 다를 때만 자동 동기화한다.
- 별도의 `npm run register:commands`, Discord Public Key, Railway 공개 도메인이 필요 없다.
- Discord Developer Portal의 **General Information → Interactions Endpoint URL은 비워 둔다.** 기존 HTTP interaction 방식에서 전환했다면 URL을 지우고 Save Changes를 눌러야 한다. URL이 남아 있으면 Discord가 interaction을 Gateway로 보내지 않으므로, 봇은 시작할 때 `application.fetch()`로 이를 확인하고 명확한 오류와 함께 중단한다.
- 설치 scope는 `bot`과 `applications.commands`이며 권한은 View Channels, Send Messages, Attach Files만 사용한다.
- 명령이 다른 서버에도 보일 수는 있지만 `DISCORD_GUILD_ID`가 아닌 서버에서 실행하면 거부한다.

## 로컬 검증

Node.js 24.17 이상이 필요하다.

```bash
cd bot
npm ci
npm run check
npm run build
```

테스트는 임시 SQLite와 파일 디렉터리, 생성 이미지, 가짜 Discord REST/CDN, 모의 GitHub 응답을 사용한다. 실제 Discord, GitHub, Railway 자격증명은 필요하지 않다.

로컬 실행은 `.env.example`을 `.env`로 복사해 채운 뒤 다음처럼 한다.

```bash
npm run dev
```

`.env`, Bot Token, GitHub App private key는 커밋하지 않는다.

## Railway 설정

서비스 하나, replica 하나, `/data` persistent volume을 사용한다. SQLite가 단일 writer라 수평 복제하지 않는다. Serverless/sleeping은 끈다. 커밋된 `railway.json`이 `bot/Dockerfile`로 빌드하고 `/healthz`로 Gateway 준비 상태를 확인한다.

개인 서버 테스트에 필요한 변수는 다음뿐이다.

```dotenv
PROFILE_PUBLISH_MODE=sandbox
DATABASE_PATH=/data/sandbox/grasp-profile-bot.sqlite
SANDBOX_PROFILE_DIRECTORY=/data/sandbox/profiles
DISCORD_APPLICATION_ID=<Application ID>
DISCORD_BOT_TOKEN=<Bot Token>
DISCORD_GUILD_ID=<개인 테스트 서버 ID>
DISCORD_OWNER_USER_ID=<관리자 Discord 사용자 ID>
```

production으로 바꿀 때에만 GitHub App 변수와 `MEMBERS_PAGE_URL`을 사용한다. GitHub App 권한은 대상 저장소 하나에 대한 Contents read/write, Actions read-only, Pages read-only, Metadata만 필요하다.

## HTTP endpoint

- `GET /healthz`: Railway 내부 health check 전용. Gateway 접속 전에는 503, 접속 후에는 200을 반환한다. 기존 프로필 복구 중에는 응답의 `profileRecovery`가 `running`이며 Discord 명령은 잠시 후 다시 시도하라는 안전한 안내만 보낸다.

프로필 REST API, 로그인 페이지, 공개 interaction webhook, 파일 브라우저는 제공하지 않는다.
