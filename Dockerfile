FROM node:24-bookworm-slim AS builder

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY server ./server
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    CHECKIN_TIMEZONE=Asia/Shanghai \
    CHECKIN_DATA_DIR=/data \
    CHECKIN_WEB_MODE=1 \
    CHECKIN_BROWSER_NO_SANDBOX=1 \
    CHECKIN_BROWSER_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates chromium fonts-liberation fonts-noto-cjk \
        gosu tini tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 700 /data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY --from=builder /app/dist-server ./dist-server
COPY web ./web
COPY browser-extension ./browser-extension
COPY deploy/entrypoint.sh deploy/healthcheck.mjs ./deploy/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN chmod 755 /app/deploy/entrypoint.sh

EXPOSE 8765
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=6s --start-period=45s --retries=3 \
    CMD ["node", "/app/deploy/healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
CMD ["node", "dist-server/main.js"]
