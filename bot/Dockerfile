FROM node:24-bookworm-slim AS build

WORKDIR /app/bot

COPY bot/package.json bot/package-lock.json ./
RUN npm ci

COPY bot/tsconfig.json ./
COPY bot/src ./src
COPY schemas /app/schemas

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATABASE_PATH=/data/grasp-profile-bot.sqlite

WORKDIR /app/bot

COPY --from=build /app/bot/package.json ./package.json
COPY --from=build /app/bot/node_modules ./node_modules
COPY --from=build /app/bot/dist ./dist
COPY --from=build /app/schemas /app/schemas

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "dist/container-entrypoint.js"]
