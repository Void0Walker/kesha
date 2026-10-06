FROM node:24.14-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# matrix-sdk-crypto-nodejs downloads its native binary during install
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# Data (SQLite, Matrix sync and crypto stores) on a volume owned by uid 1000
USER node
VOLUME /data
# Node warns on every start that node:sqlite is experimental
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
CMD ["node", "src/main.ts"]
