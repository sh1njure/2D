# CS2 Demo Viewer — top-level task runner.
# Commands degrade gracefully: in Phase 0 only infra (db, redis) exists, so
# `make test` / `make lint` report that backend/frontend are not present yet
# instead of failing. They start doing real work in the phase that adds code.

.DEFAULT_GOAL := help
.PHONY: help up down logs ps test lint fmt

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

up: ## Start the stack (Phase 0: Postgres + Redis)
	docker compose up -d
	@docker compose ps

down: ## Stop the stack
	docker compose down

logs: ## Tail all service logs
	docker compose logs -f

ps: ## Show running services
	docker compose ps

test: ## Run tests (backend once it exists)
	@if [ -f backend/pyproject.toml ]; then \
		cd backend && python -m pytest -q; \
	else \
		echo "No backend yet (Phase 0). Tests arrive with the code that needs them."; \
	fi

lint: ## Lint backend + frontend (once they exist)
	@if [ -f backend/pyproject.toml ]; then \
		cd backend && ruff check . && mypy app; \
	else \
		echo "No backend yet (Phase 0)."; \
	fi
	@if [ -f frontend/package.json ]; then \
		cd frontend && npm run lint; \
	else \
		echo "No frontend yet (Phase 0)."; \
	fi

fmt: ## Auto-format backend
	@if [ -f backend/pyproject.toml ]; then cd backend && ruff format .; fi
