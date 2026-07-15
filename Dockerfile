# syntax=docker/dockerfile:1

# --- Builder stage ---
FROM node:24 AS builder

WORKDIR /app

RUN corepack enable && corepack prepare yarn@4.17.1 --activate

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN yarn build

# Prune devDependencies out of node_modules for a smaller runtime copy.
RUN yarn workspaces focus --production --all 2>/dev/null || true

# --- Runtime stage ---
FROM node:24-slim AS runtime

# smartmontools provides the smartctl binary used to read HDD temperatures
# (SMART attribute 194) from raw disk devices via /dev/sdX.
RUN apt-get update \
    && apt-get install -y --no-install-recommends smartmontools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# smartctl needs raw device I/O access (SYS_RAWIO) on the host. The
# container runs as root to satisfy that requirement; see docker-compose.yml
# and the README for the least-privilege device + capability list used at
# runtime instead of --privileged.
USER root

EXPOSE 3000

CMD ["node", "dist/index.js"]
