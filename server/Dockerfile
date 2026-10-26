# syntax=docker/dockerfile:1

# 国内网络可默认用 npmmirror；官方源：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org api`
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM node:22-alpine AS deps
WORKDIR /app
ARG NPM_REGISTRY
# better-sqlite3 等 native 模块在 musl 上无预编译产物，源码编译需要完整工具链
RUN apk add --no-cache python3 make g++
# 这是一个 npm workspace 项目，锁文件在仓库根目录
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY agent-world/package.json agent-world/package.json
RUN npm config set registry "${NPM_REGISTRY}" && npm ci

FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_REGISTRY
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY server ./server
COPY agent-world ./agent-world
RUN npm config set registry "${NPM_REGISTRY}" && npm ci
RUN npm run build -w nextbot-server

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs
# 只保留运行服务端需要的生产依赖
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/server/package.json ./package.json
# 显式提供 workspace 包与其运行时依赖，避免软链接在精简镜像中失效
COPY --from=build --chown=node:node /app/agent-world/package.json ./node_modules/@nextbot/agent-world/package.json
COPY --from=build --chown=node:node /app/agent-world/dist ./node_modules/@nextbot/agent-world/dist
COPY --from=build --chown=node:node /app/agent-world/node_modules/zod ./node_modules/zod
COPY --from=build --chown=node:node /app/server/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "--max-old-space-size=512", "dist/index.js"]
