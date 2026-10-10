# syntax=docker/dockerfile:1
#
# Wanderly API image. Build context: repository root.
#   docker build -f services/api/Dockerfile -t wanderly-api .
#
# Runtime is glibc-based (Debian bookworm slim), not Alpine/musl: onnxruntime-node, used by the
# local embedding model, ships glibc binaries only. The base image is pinned by digest for
# reproducible builds; Dependabot (docker ecosystem) refreshes the digest. The image reference is
# repeated literally in both FROM lines because Dependabot does not resolve ARG-based FROMs.
#
# Install scripts: `npm ci --ignore-scripts` everywhere. The root package.json `allowScripts`
# policy is only enforced by npm >= 11, while Node 22 bundles npm 10, which would run every
# install script, including onnxruntime-node's postinstall that downloads the CUDA provider
# (hundreds of MB) on linux/x64. The policy denies it anyway; the only allowed script (esbuild)
# is a binary self-check that is not needed to compile with tsc.

# ---------------------------------------------------------------------------------------------
# base: shared npm settings + workspace manifests
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# Manifests only (better layer caching). Every workspace manifest is copied because `npm ci`
# checks the whole lockfile against the workspace list, even when installing a subset.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
COPY evals/package.json evals/

# ---------------------------------------------------------------------------------------------
# deps: full dependency tree (dev included: TypeScript lives in the root devDependencies)
# ---------------------------------------------------------------------------------------------
FROM base AS deps
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts \
      --workspace @wanderly/contracts --workspace @wanderly/api --include-workspace-root

# ---------------------------------------------------------------------------------------------
# build: compile contracts then api to dist/
# ---------------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY services/api services/api
RUN npm run build --workspace @wanderly/contracts --workspace @wanderly/api

# ---------------------------------------------------------------------------------------------
# prod-deps: production dependencies only
# ---------------------------------------------------------------------------------------------
FROM base AS prod-deps
ARG TARGETARCH
# 1. Production install for contracts + api only.
# 2. onnxruntime-node bundles native binaries for every OS/arch (~300 MB); keep only linux/<arch>.
# 3. npm only creates nested node_modules on version conflicts: make sure they exist for COPY.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts \
      --workspace @wanderly/contracts --workspace @wanderly/api \
    && ORT_DIR=node_modules/onnxruntime-node/bin/napi-v6 \
    && case "${TARGETARCH:-amd64}" in amd64) ORT_ARCH=x64 ;; *) ORT_ARCH="${TARGETARCH}" ;; esac \
    && if [ -d "${ORT_DIR}/linux/${ORT_ARCH}" ]; then \
         find "${ORT_DIR}" -mindepth 2 -maxdepth 2 -type d ! -path "${ORT_DIR}/linux/${ORT_ARCH}" -exec rm -rf {} +; \
       fi \
    && mkdir -p services/api/node_modules packages/contracts/node_modules

# ---------------------------------------------------------------------------------------------
# runtime: compiled JS + production node_modules + SQL migrations, non-root
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

LABEL org.opencontainers.image.title="wanderly-api" \
      org.opencontainers.image.description="Wanderly API (Fastify, agent runtime, hybrid RAG)" \
      org.opencontainers.image.source="https://github.com/patrickz24/wanderly" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    EMBEDDING_CACHE_DIR=/app/.cache/models

# 1. Debian security updates released after the base image was built (the image scan fails on
#    fixable HIGH/CRITICAL; the layer is rebuilt whenever Dependabot refreshes the base digest).
# 2. The runtime only runs `node` (migrations included): drop the bundled package managers
#    (npm, npx, corepack, yarn), which are attack surface and carry their own vulnerable deps.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app

# Application files stay owned by root (read-only for the runtime user); only the model cache
# directory is writable by `node`.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=prod-deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY packages/contracts/package.json ./packages/contracts/
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=prod-deps /app/services/api/node_modules ./services/api/node_modules
COPY services/api/package.json ./services/api/
COPY --from=build /app/services/api/dist ./services/api/dist
COPY services/api/migrations ./services/api/migrations

RUN mkdir -p /app/.cache/models && chown node:node /app/.cache/models

# Same working directory as `npm start` / `npm run migrate` in the workspace.
WORKDIR /app/services/api
# The base image's `node` user, by numeric id so that runtimes enforcing runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 3000

# Liveness only (/health). Readiness (/ready) is checked by the orchestrator. slim images ship no
# curl/wget, so the probe uses Node's built-in fetch.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/main.js"]
