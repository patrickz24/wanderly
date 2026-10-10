# Wanderly developer commands. Run `make` (or `make help`) to list them.
#
# POSIX make + sh. On Windows, run it from Git Bash or WSL. Without make, use the npm/docker
# equivalents below:
#   make install           npm ci
#   make env               cp .env.example .env, then set SESSION_SECRET (>= 32 random chars)
#   make up                docker compose up --build -d --wait
#   make down              docker compose down
#   make logs              docker compose logs -f --tail=100
#   make db                docker compose up -d --wait db
#   make migrate           npm run migrate               (needs DATABASE_URL in the environment)
#   make dev               make db migrate, then `npm run dev:api` (with the .env variables
#                          exported) and `npm run dev:web`
#   make test              npm test
#   make test-integration  npm run test:integration     (needs the database: make db migrate)
#   make lint              npm run lint && npm run format:check
#   make typecheck         npm run typecheck
#   make build             npm run build
#   make deploy            flyctl deploy --config infra/fly/api.fly.toml --ha=false --no-public-ips
#                          then flyctl deploy --config infra/fly/web.fly.toml --ha=false
#
# Host-side commands that need configuration (migrate, dev, test-integration) source .env
# (simple KEY=value lines) in their own shell only; nothing is exported to other targets, so a
# development NODE_ENV in .env cannot leak into `make build` or `make test`.

COMPOSE ?= docker compose
SERVICE ?=
LOCAL_DATABASE_URL := postgres://wanderly:wanderly@localhost:5432/wanderly
WITH_ENV = set -a; if [ -f .env ]; then . ./.env; fi; set +a; \
	export DATABASE_URL="$${DATABASE_URL:-$(LOCAL_DATABASE_URL)}";

# Fly.io (docs/DEPLOYMENT.md). App names are read from the config files.
FLY_API_CONFIG := infra/fly/api.fly.toml
FLY_WEB_CONFIG := infra/fly/web.fly.toml
FLYCTL = $(shell command -v flyctl 2>/dev/null || command -v fly 2>/dev/null)
fly_app = $(shell sed -n 's/^app = "\(.*\)"$$/\1/p' $(1))

# $(call fly_preflight,<config>): flyctl is installed, authenticated, and the app exists.
define fly_preflight
	@if [ -z "$(FLYCTL)" ]; then \
		echo "flyctl not found: install it, then run 'fly auth login' (docs/DEPLOYMENT.md, section 2)." >&2; exit 1; fi
	@[ -n "$$FLY_API_TOKEN" ] || $(FLYCTL) auth whoami >/dev/null 2>&1 || { \
		echo "flyctl is not authenticated: run 'fly auth login' or set FLY_API_TOKEN." >&2; exit 1; }
	@$(FLYCTL) status --app "$(call fly_app,$(1))" >/dev/null 2>&1 || { \
		echo "Fly app '$(call fly_app,$(1))' not found or not accessible: run the one-time setup (docs/DEPLOYMENT.md, section 4)." >&2; exit 1; }
endef

.DEFAULT_GOAL := help

.PHONY: help install env up down logs ps db migrate seed dev dev-api dev-web test \
	test-integration lint typecheck eval build deploy deploy-api deploy-web clean

help: ## List available commands
	@echo "Usage: make <target>"
	@echo ""
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z_-]+:.*## / { printf "  %-18s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install dependencies from the lockfile (npm ci)
	npm ci

env: ## Create .env from .env.example with a random SESSION_SECRET (never overwrites)
	@if [ -f .env ]; then \
		echo ".env already exists, left unchanged."; \
	elif [ ! -f .env.example ]; then \
		echo ".env.example is missing." >&2; exit 1; \
	else \
		secret=$$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))") && \
		sed "s/^SESSION_SECRET=.*/SESSION_SECRET=$$secret/" .env.example > .env && \
		echo "Created .env with a random SESSION_SECRET. Add ANTHROPIC_API_KEY there when needed."; \
	fi

up: env ## Build and start the whole stack (db, migrate, api, web) and wait until healthy
	$(COMPOSE) up --build -d --wait
	@echo ""
	@echo "Web: http://localhost:$${WEB_PORT:-8080}   API: http://localhost:$${API_PORT:-3000}/health"

down: ## Stop the stack (keeps the database and model volumes)
	$(COMPOSE) down

logs: ## Follow logs (one service: make logs SERVICE=api)
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

ps: ## Show stack status and health
	$(COMPOSE) ps

db: ## Start only Postgres (for host-side development and integration tests)
	$(COMPOSE) up -d --wait db

migrate: ## Apply pending SQL migrations to DATABASE_URL (from .env, else local compose db)
	@$(WITH_ENV) npm run migrate

seed: ## Load the travel corpus into the database (milestone 2)
	@echo "make seed: available at milestone 2 (corpus ingestion)."

dev: env db migrate ## Run the API (:3000) and web (:5173) dev servers against the compose database
	@echo "API on http://localhost:3000, web on http://localhost:5173 (Ctrl+C stops both)."
	@$(MAKE) --no-print-directory -j2 dev-api dev-web

dev-api:
	@$(WITH_ENV) npm run dev:api

dev-web:
	npm run dev:web

test: ## Run unit tests in every workspace
	npm test

test-integration: db migrate ## Run database integration tests (starts Postgres and migrates)
	@$(WITH_ENV) npm run test:integration

lint: ## ESLint + Prettier check
	npm run lint
	npm run format:check

typecheck: ## Type-check every workspace
	npm run typecheck

eval: ## Run the LLM evaluation pipeline (milestone 5)
	@echo "make eval: available at milestone 5 (evaluation pipeline)."

build: ## Build every workspace (contracts first)
	npm run build

deploy: ## Deploy the API (with migrations), then the web app, to Fly.io (docs/DEPLOYMENT.md)
	@$(MAKE) --no-print-directory deploy-api
	@$(MAKE) --no-print-directory deploy-web

# One Machine per app (--ha=false): the API rate limiter is in memory, so it must be a single
# instance. The API never gets a public IP (--no-public-ips); it is reached over Flycast.
deploy-api: ## Deploy only the API to Fly.io (its release command applies migrations first)
	$(call fly_preflight,$(FLY_API_CONFIG))
	$(FLYCTL) deploy --config $(FLY_API_CONFIG) --ha=false --no-public-ips

deploy-web: ## Deploy only the web app (nginx + SPA) to Fly.io
	$(call fly_preflight,$(FLY_WEB_CONFIG))
	$(FLYCTL) deploy --config $(FLY_WEB_CONFIG) --ha=false

clean: ## Remove build outputs and coverage (keeps node_modules and Docker volumes)
	rm -rf packages/*/dist services/*/dist apps/*/dist evals/dist
	rm -rf packages/*/coverage services/*/coverage apps/*/coverage evals/coverage coverage
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -not -path '*/node_modules/*' -delete
