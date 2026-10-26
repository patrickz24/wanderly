# syntax=docker/dockerfile:1
#
# Wanderly web image. Build context: repository root.
#   docker build -f apps/web/Dockerfile -t wanderly-web .
#
# Build with Node (glibc, same base as the API), serve the static bundle with the unprivileged
# nginx image (runs as uid 101, listens on 8080). Base images are pinned by digest for
# reproducible builds; Dependabot (docker ecosystem) refreshes the digests.
#
# `npm ci --ignore-scripts`: see services/api/Dockerfile (allowScripts is not enforced by the
# npm 10 bundled with Node 22). Vite/rolldown, Tailwind oxide and lightningcss load their
# native binaries from platform optionalDependencies, with no install script.

# ---------------------------------------------------------------------------------------------
# deps: contracts + web dependency tree (dev included: Vite, TypeScript, Tailwind)
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS deps
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
# Every workspace manifest is needed: `npm ci` checks the lockfile against the whole workspace list.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
COPY evals/package.json evals/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts \
      --workspace @wanderly/contracts --workspace @wanderly/web --include-workspace-root

# ---------------------------------------------------------------------------------------------
# build: type-check and bundle (contracts first: production consumers import its dist/)
# ---------------------------------------------------------------------------------------------
FROM deps AS build
# Empty = same origin (nginx proxies /api). Baked in at build time by Vite.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN npm run build --workspace @wanderly/contracts --workspace @wanderly/web

# ---------------------------------------------------------------------------------------------
# runtime: static files + nginx config, non-root
# ---------------------------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime

LABEL org.opencontainers.image.title="wanderly-web" \
      org.opencontainers.image.description="Wanderly web client (React SPA served by nginx)" \
      org.opencontainers.image.source="https://github.com/patrickz24/wanderly" \
      org.opencontainers.image.licenses="MIT"

# The base image runs as uid 101; package changes need root (uid 0), dropped again below.
USER 0
# 1. Remove the optional dynamic modules (image-filter, xslt, geoip, njs): this config loads none
#    of them, and they pull in libgd, libtiff, libxslt and GeoIP (attack surface + CVEs).
# 2. Alpine security updates released after the base image was built (the image scan fails on
#    fixable HIGH/CRITICAL; the layer is rebuilt whenever Dependabot refreshes the base digest).
# 3. Drop the stock server block: ours is rendered from the template below at startup.
RUN apk del --no-cache nginx-module-image-filter nginx-module-xslt nginx-module-geoip \
        nginx-module-njs \
    && apk upgrade --no-cache \
    && rm -f /etc/nginx/conf.d/default.conf

# The server block is an envsubst template rendered by the image entrypoint into
# /etc/nginx/conf.d (writable by uid 101 in this image; a tmpfs under compose's read-only root
# filesystem). Only WANDERLY_* variables are substituted, so nginx's own $variables are kept.
# Defaults fit docker-compose; infra/fly/web.fly.toml overrides them for Fly.io.
ENV NGINX_ENVSUBST_FILTER="^WANDERLY_" \
    WANDERLY_API_UPSTREAM="api:3000" \
    WANDERLY_REAL_IP_HEADER="X-Real-IP" \
    WANDERLY_REAL_IP_FROM="127.0.0.1/32"

# Content and template are owned by root, read-only for the nginx user.
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

USER 101
EXPOSE 8080

# Probes nginx itself (static index), not the API behind it.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/"]
