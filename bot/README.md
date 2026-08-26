# GRASP 프로필 Discord 봇

GRASP 구성원이 Discord의 `/register`와 `/profile`만으로 자신의 웹사이트 프로필을 만들고 수정하는 봇이다. 봇은 일반적인 Discord Gateway 방식으로 항상 접속해 있으며, 서버에 초대하면 슬래시 명령을 바로 사용할 수 있다.

## 사용자가 할 수 있는 일

- `/register`: Discord 계정에 새 프로필 하나를 연결한다. 관리자 승인은 없고, 처음에는 `listed: false`라 Members 페이지에 표시되지 않는다.
- `/profile`: 이름, 소속/직위, 설명, 연구 관심사, 연락처, 웹사이트, 구성원 분류, 사진, 공개 여부를 수정한다.
- `/profile`에서 `Edit profile`을 누르면 텍스트·분류·공개 여부·사진 변경이 하나의 편집본에 모인다. 각 화면에서는 실제 사이트를 건드리지 않으며, 마지막 `Save changes`가 전체 변경을 한 번에 반영한다. `Discard changes`로 게시 전 변경을 함께 버릴 수 있다.
- 사진: JPEG, PNG, WebP를 받아 EXIF 방향을 적용한 뒤 중앙 기준 4:5로 자른다. 확대하지 않고 최대 800×1000으로 줄여 WebP로 변환하며, 사용자는 미리보기를 확인해 편집본에 넣은 뒤 다른 변경과 함께 게시한다.

저장소 경로, 임의 JSON, 임의 커밋, 범용 GitHub 작업은 Discord 입력으로 받지 않는다.

## 현재 배포 모드

`PROFILE_PUBLISH_MODE=sandbox`가 기본값이다. 이 모드에서는 개인 테스트 서버에서 만든 프로필과 사진을 Railway의 `/data/sandbox/` 아래에만 저장한다. GRASP GitHub 저장소와 실제 웹사이트는 전혀 수정하지 않으며, SQLite도 운영용 경로와 분리한다.

실제 사이트에 게시할 때는 다음처럼 production 모드로 전환한다. 이미 초기화한 Railway volume을 계속 쓴다면 `DATABASE_PATH`를 비롯한 저장 경로는 readiness marker에 기록된 값을 그대로 유지한다.

```dotenv
PROFILE_PUBLISH_MODE=production
```

production 모드는 Discord에서 요청한 프로필 변경을 실제 GitHub 저장소에 반영한다. 요청을 먼저 SQLite 영구 큐에 저장한 뒤 기존 blob SHA 확인, 격리된 `bot/profile-batch/...` 브랜치, `workflow_dispatch`로 시작한 저장소 검증, `main` 비강제 fast-forward, GitHub Pages 배포 확인 순서로 제한된 프로필 파일만 반영한다. 봇은 dispatch 응답의 정확한 workflow run ID만 추적한다. 2초 안에 모인 서로 다른 프로필 최대 20개(파일 최대 40개)는 한 번의 검증·커밋·Pages 배포로 합친다. 서버 ID를 코드나 환경변수에 고정하지 않는다.

요청은 최대 6초 동안 완료를 기다린다. 그 안에 끝나지 않으면 대기열에 들어갔다고 안내한다. GitHub 검증을 시작하지 못하거나 제한 시간 안에 끝내지 못하면 사이트는 변경하지 않고, 사용자에게 GitHub 일시 장애 가능성과 재시도를 안내한다. 검증이 완료된 뒤 `main` 반영 결과가 불명확하게 끊긴 경우에는 로컬 상태를 되돌리지 않고 같은 operation ID로 복구·재시도한다.

`listed`는 Members 페이지 표시 설정이지 비공개 저장 기능은 아니다. production에서 게시한 JSON, 사진, 커밋 기록은 공개 저장소에 남는다.

## Discord 동작 방식

- `discord.js` Gateway 연결을 사용한다.
- 필요한 Gateway intent는 `Guilds` 하나뿐이다. 메시지 내용, 서버 구성원 목록, Presence를 읽지 않는다.
- 전역 슬래시 명령 `/register`, `/profile`은 봇 시작 시 코드와 Discord의 현재 상태가 다를 때만 자동 동기화한다.
- 별도의 `npm run register:commands`, Discord Public Key, Railway 공개 도메인이 필요 없다.
- Discord Developer Portal의 **General Information → Interactions Endpoint URL은 비워 둔다.** 기존 HTTP interaction 방식에서 전환했다면 URL을 지우고 Save Changes를 눌러야 한다. URL이 남아 있으면 Discord가 interaction을 Gateway로 보내지 않으므로, 봇은 시작할 때 `application.fetch()`로 이를 확인하고 명확한 오류와 함께 중단한다.
- 설치 scope는 `bot`과 `applications.commands`이며 권한은 View Channels, Send Messages, Attach Files만 사용한다.
- sandbox 모드에서는 테스트 데이터를 Railway volume에 저장하고, production 모드에서는 실제 사이트에 게시한다.

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

서비스 하나, replica 하나, `/data` persistent volume을 사용한다. SQLite가 단일 writer라 수평 복제하지 않는다. Serverless/sleeping은 끈다. `bot/Dockerfile`로 빌드하고 `/healthz`로 Gateway·복구·큐·저장소 준비 상태를 확인한다. 정상 시작은 짧지만, 강제 종료 직후 남은 15분 lease와 최장 게시 복구를 안전하게 기다리도록 healthcheck 제한은 1시간으로 둔다.

Railway는 volume을 붙이면 `RAILWAY_VOLUME_MOUNT_PATH=/data`를 자동 제공한다. production 컨테이너는 이 값이 없거나 DB·sandbox·backup 경로가 volume 밖이면 시작을 거부하며, 환경변수로 `false`를 넣어도 이 보호는 해제되지 않는다. 시작할 때 원본 DB 무결성을 확인하고, 6시간마다 검증된 SQLite 온라인 백업을 `/data/backups`에 만들며 최근 28개를 유지한다. Railway 자체 volume backup은 별도 계층이므로 Backups 탭에서 Daily와 Weekly 일정을 켜는 것을 권장한다.

볼륨은 한 번만 명시적으로 초기화한다. `PROFILE_STORAGE_ID`에 새 UUID를 넣고, 새 볼륨이면 `PROFILE_INITIALIZE_STORAGE=true`, 기존 DB가 든 현재 볼륨이면 여기에 `PROFILE_ADOPT_EXISTING_STORAGE=true`도 함께 넣어 한 번 배포한다. 기존 DB를 채택할 때는 writer migration 전에 원본 백업을 먼저 남긴다. 이 첫 배포는 식별 marker, 정상 스키마의 DB, 검증된 첫 백업, 준비 완료 marker를 만든 뒤 의도적으로 종료된다. 로그에서 초기화 완료를 확인한 다음 두 초기화 변수를 삭제하고 다시 배포해야 정상 기동한다. 이후 marker가 없거나 ID가 다르거나 준비 완료 DB가 사라졌거나 초기화 변수가 남아 있으면 봇은 시작하지 않으므로, 비어 있거나 엉뚱한 볼륨을 자동 승인하지 않는다.

현재 서비스가 읽는 `railway.json`은 Railway의 구형 Config as Code 형식이다. Railway의 공식 절차대로 연결된 CLI에서 `railway config migrate`로 실제 프로젝트 상태를 가져와 검토한 뒤 IaC로 전환해야 하며, 프로젝트 상태를 보지 않고 `.railway/railway.ts`를 임의 생성하면 안 된다.

개인 서버 테스트에 필요한 변수는 다음뿐이다.

```dotenv
PROFILE_PUBLISH_MODE=sandbox
DATABASE_PATH=/data/sandbox/grasp-profile-bot.sqlite
SANDBOX_PROFILE_DIRECTORY=/data/sandbox/profiles
PROFILE_BACKUP_DIRECTORY=/data/backups
PROFILE_STORAGE_ID=<이 볼륨에 고정할 UUID>
DISCORD_APPLICATION_ID=<Application ID>
DISCORD_BOT_TOKEN=<Bot Token>
```

production으로 바꿀 때에만 GitHub App 변수와 `MEMBERS_PAGE_URL`을 사용한다. GitHub App 권한은 대상 저장소 하나에 대한 Contents read/write, Actions read/write, Pages read-only, Metadata만 필요하다. Actions 권한을 변경한 뒤에는 해당 저장소에 설치된 GitHub App의 새 권한 요청을 한 번 승인해야 한다.

## HTTP endpoint

- `GET /healthz`: Railway 내부 health check 전용. Gateway 접속과 모든 기존 서버의 프로필 복구가 끝나기 전에는 503, 준비된 뒤에만 200을 반환한다. 현재 영구 큐의 대기 건수도 함께 보여 준다.

프로필 REST API, 로그인 페이지, 공개 interaction webhook, 파일 브라우저는 제공하지 않는다.
