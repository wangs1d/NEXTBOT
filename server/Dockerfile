# syntax=docker/dockerfile:1

# 国内网络可默认用 npmmirror；官方源：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org api`
ARG NPM_REGISTRY=https://registry.npmmirror.com

# 基础镜像用 Debian(glibc) 而不是 Alpine(musl)：
#   - onnxruntime-node 只发布 glibc 版本（bin/napi-v6/linux/x64），Alpine 上加载必失败，
#     本地 embedding 能力会被静默关闭；
#   - better-sqlite3 / sharp 在 glibc 上都有预编译产物，构建更稳。
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ARG NPM_REGISTRY
# 没有预编译产物时回落到源码编译
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# 这是一个 npm workspace 项目，锁文件在仓库根目录
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY agent-world/package.json agent-world/package.json
COPY packages/agent-protocol/package.json packages/agent-protocol/package.json
COPY packages/picture/package.json packages/picture/package.json
# onnxruntime-node 的 postinstall 在 linux/x64 上默认会去 nuget 下 CUDA EP（数百 MB），
# 我们只用 CPU：跳过，避免构建卡住/镜像暴涨。
ENV ONNXRUNTIME_NODE_INSTALL=skip
# 运行时只需要生产依赖：devDependencies（typescript/tsx/@types）不进最终镜像
RUN npm config set registry "${NPM_REGISTRY}" && npm ci --omit=dev

FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG NPM_REGISTRY
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server ./server
COPY agent-world ./agent-world
COPY packages ./packages
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm config set registry "${NPM_REGISTRY}" && npm ci
RUN npm run build -w nextbot-server

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# tzdata：Debian slim 不自带时区库，缺了 TZ=Asia/Shanghai 会退回 UTC
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /app/logs \
    && chown -R node:node /app/data /app/logs
# 只保留运行服务端需要的生产依赖
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/server/package.json ./package.json
# 显式提供 workspace 包与其运行时依赖，避免软链接在精简镜像中失效
COPY --from=build --chown=node:node /app/agent-world/package.json ./node_modules/@nextbot/agent-world/package.json
COPY --from=build --chown=node:node /app/agent-world/dist ./node_modules/@nextbot/agent-world/dist
COPY --from=build --chown=node:node /app/agent-world/node_modules/zod ./node_modules/zod
# 另外两个 workspace 包（server 的运行时依赖），fast-prebuild 会产出 dist
COPY --from=build --chown=node:node /app/packages/agent-protocol/package.json ./node_modules/@nextbot/agent-protocol/package.json
COPY --from=build --chown=node:node /app/packages/agent-protocol/dist ./node_modules/@nextbot/agent-protocol/dist
COPY --from=build --chown=node:node /app/packages/picture/package.json ./node_modules/@nextbot/picture/package.json
COPY --from=build --chown=node:node /app/packages/picture/dist ./node_modules/@nextbot/picture/dist
COPY --from=build --chown=node:node /app/server/dist ./dist
# worker_threads 脚本是 .mjs，tsc 不会拷贝；Docker 用 dist/index.js 启动时
# 必须在 dist/services/workers 下存在，否则 code.run / image.generate 直接 ENOENT。
COPY --from=build --chown=node:node /app/server/src/services/workers ./dist/services/workers
# 静态页面（/chat、/gallery-wall、/travel-map、/webpay…）都按 serverRoot()/web 读取，
# 不拷贝进镜像会在容器里全部 404。
COPY --from=build --chown=node:node /app/server/web ./web
# 本地 embedding 模型（约 24MB）：不拷贝则引擎初始化直接返回 null，
# 记忆向量召回会静默降级。模型目录由 local-embedding-engine 的 resolve* 查找。
COPY --from=build --chown=node:node /app/server/models/bge-small-zh-v1.5 ./models/bge-small-zh-v1.5
USER node
EXPOSE 3000
# 堆上限按容器 cgroup 反推：生产实测容器约 1.42GB（见 resource-pool.ts 注释），
# 512MB 只占 36%，新分配稍重就触发 full GC（"CPU 高"的常见成因）。
# 768MB ≈ 54%，给 embedding 子进程（onnxruntime）与 sharp 解码缓冲留出余量。
# --max-semi-space-size=32：默认 16MB 对分配极重的服务太小，对象过早晋升老生代。
CMD ["node", "--max-old-space-size=768", "--max-semi-space-size=32", "dist/index.js"]
