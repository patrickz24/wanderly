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
#
# Host-side commands that need configuration (migrate, dev, test-integration) source .env
# (simple KEY=value lines) in their own shell only; nothing is exported to other targets, so a
# development NODE_ENV in .env cannot leak into `make build` or `make test`.

COMPOSE ?= docker compose
SERVICE ?=
LOCAL_DATABASE_URL := postgres://wanderly:wanderly@localhost:5432/wanderly
WITH_ENV = set -a; if [ -f .env ]; then . ./.env; fi; set +a; \
	export DATABASE_URL="$${DATABASE_URL:-$(LOCAL_DATABASE_URL)}";

.DEFAULT_GOAL := help

.PHONY: help install env up down logs ps db migrate seed dev dev-api dev-web test \
	test-integration lint typecheck eval build deploy clean

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

deploy: ## Deploy to production (milestone 7, see docs/DEPLOYMENT.md)
	@echo "make deploy: not available before milestone 7; the procedure will be in docs/DEPLOYMENT.md." >&2
	@exit 1

clean: ## Remove build outputs and coverage (keeps node_modules and Docker volumes)
	rm -rf packages/*/dist services/*/dist apps/*/dist evals/dist
	rm -rf packages/*/coverage services/*/coverage apps/*/coverage evals/coverage coverage
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -not -path '*/node_modules/*' -delete
