# GRASP profile Discord bot

This service gives GRASP members a narrow Discord interface for editing only their own public website profile. It does not accept repository paths, arbitrary JSON, arbitrary commits, or general GitHub operations.

## Implemented profile boundary

- `/register` creates one profile for the invoking Discord account without owner approval. New profiles start with `listed: false`.
- `/profile` edits the canonical fields, member category, photo, and Members-page visibility.
- Photos are decoded as JPEG, PNG, or WebP, auto-oriented, center-cropped to an exact 4:5 rectangle, resized down to at most 800×1000, stripped of metadata, and encoded as WebP. The processed result must be confirmed from a Discord preview before publication.
- `DISCORD_OWNER_USER_ID` alone may hide, revoke, restore, transfer, or correct the category of another binding. Every owner check is repeated by the interaction router and service layer.
- A profile operation may touch only `src/data/members/<slug>.json` and, when requested, `src/data/members/<slug>.webp`.
- GitHub writes use blob optimistic locks, an isolated `bot/profile/...` ref, the repository validation workflow, and a non-forced fast-forward of `main`. A successful response means the existing Pages deployment was observed as successful, not merely that a commit was created.
- Validation and deployment polling use bounded timeouts chosen to keep the deferred Discord response within the interaction token lifetime. A timeout fails closed or reports `published_deploy_failed`; it never force-pushes or rolls back `main` automatically.

`listed` is a display preference, not a privacy control. Member JSON, photos, commits, and Git history remain public in this repository.

## Local verification

Node.js 24 or newer is required.

```bash
cd bot
npm ci
npm run check
npm run build
```

The test suite uses in-memory SQLite, generated image fixtures, a fake Discord webhook/CDN, and scripted GitHub responses. It does not need Discord, GitHub, or Railway credentials.

For local service execution, copy `.env.example` to `.env`, fill it locally, load those variables in your shell, and run `npm run dev`. Never commit `.env`, a GitHub App PEM file, or any token.

## External setup to do at deployment time

Before the first real registration, remove the existing manually maintained `taein-oh.json` and
`taein-oh.png` in a normal reviewed commit, wait for that Pages deployment to finish, and then
register the owner through Discord. They are intentionally left in place during local bot
development so the current Members page does not disappear early.

### 1. Discord application

Create a Discord Developer application and install it only in the GRASP guild with the `applications.commands` scope. The HTTP interaction service does not need Gateway intents or Discord channel permissions.

Collect these values as Railway variables:

- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_GUILD_ID`
- `DISCORD_OWNER_USER_ID`

Keep `DISCORD_BOT_TOKEN` only in the local environment used to run `npm run register:commands`; the deployed HTTP service does not read it. After the Railway public domain exists, set the Discord Interactions Endpoint URL to `https://<domain>/interactions`. Then run the registration command once from a local `bot/` checkout with its development dependencies installed. It replaces this application's guild command set with the three commands defined in `src/discord/commands.ts`; the pruned production image intentionally cannot run this one-off script.

The admin command is always guarded by `DISCORD_OWNER_USER_ID`. Command visibility may additionally be restricted in Discord's integration settings, but that UI restriction is not the security boundary.

### 2. GitHub App

Create a private GitHub App and install it only on `grasp-kaist/grasp-kaist.github.io` with:

- Contents: read and write
- Actions: read-only
- Pages: read-only
- Metadata: automatically included

No Workflows, Pull requests, Administration, Checks, or Pages write permission is used. Save these only as service variables:

- `GITHUB_APP_ID`
- `GITHUB_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY` (recommended for Railway) or local `GITHUB_APP_PRIVATE_KEY_PATH`

The `.github/workflows/validate-profile-bot.yml` workflow must already exist on `main` before the bot publishes its first profile. If repository rules later block direct fast-forwards, grant only this App a narrow bypass instead of weakening the publisher or enabling force-pushes.

### 3. Railway service

Connect this repository to one always-on service. The checked-in `railway.json` selects `bot/Dockerfile`, limits rebuild triggers to bot/schema changes, and configures `/healthz`. Use one replica and attach a persistent volume at `/data`; SQLite is intentionally single-writer and must not be horizontally replicated.

The container starts only long enough as root to assign the mounted `/data` directory to the image's unprivileged `node` user, then drops its UID/GID before loading the service. Do not set `RAILWAY_RUN_UID`; the checked-in entrypoint handles Railway volume ownership without leaving the bot running as root.

Add the runtime variables from `.env.example` except `DISCORD_BOT_TOKEN`, generate a public HTTPS domain, and keep app sleeping/serverless mode disabled so Discord's initial response deadline is reliable. The site stays on GitHub Pages; Railway runs only this separate interaction service.

Recommended operational settings:

- `DATABASE_PATH=/data/grasp-profile-bot.sqlite`
- one service replica
- daily volume backups
- no custom domain or external database for the MVP

## Runtime endpoints

- `POST /interactions`: signed Discord interaction endpoint
- `GET /healthz`: readiness response used by Railway

The service intentionally exposes no profile REST API, login page, generic webhook, file browser, or repository mutation endpoint.
