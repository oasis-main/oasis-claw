# oasis-claw runtime shortcuts
#
# All targets are thin wrappers around `docker compose -f docker-compose.runtime.yml`.
# See .swarm/security-notes.md for when to use each.

COMPOSE := docker compose -f docker-compose.runtime.yml

.PHONY: help up restart recreate rebuild down logs status token healthz shell smoke

help:
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## start runtime (build only if image missing)
	$(COMPOSE) up -d openclaw

restart: ## restart gateway — picks up `openclaw config set` changes
	$(COMPOSE) restart openclaw
	@$(MAKE) -s wait-ready

recreate: ## recreate container — picks up .env changes (creds rotation)
	$(COMPOSE) up -d --force-recreate openclaw
	@$(MAKE) -s wait-ready

rebuild: ## rebuild image + recreate — picks up Dockerfile / entrypoint changes
	$(COMPOSE) up -d --build --force-recreate openclaw
	@$(MAKE) -s wait-ready

down: ## stop + remove container (volume preserved)
	$(COMPOSE) down

logs: ## tail gateway logs
	$(COMPOSE) logs -f openclaw

status: ## one-line health + plugin count
	@$(COMPOSE) ps openclaw
	@$(COMPOSE) logs --tail=200 openclaw 2>&1 | grep -oE "[0-9]+ plugins:" | tail -1

token: ## print gateway auth token (do NOT paste anywhere)
	@$(COMPOSE) exec -T openclaw cat /home/node/.openclaw/.gateway-token; echo

healthz: ## authenticated healthz probe
	@TOKEN=$$($(COMPOSE) exec -T openclaw cat /home/node/.openclaw/.gateway-token); \
	curl -sS -H "Authorization: Bearer $$TOKEN" http://127.0.0.1:18789/healthz; echo

shell: ## interactive shell inside the runtime container
	$(COMPOSE) exec openclaw bash

smoke: ## run plugin-registration smoke test (mock API, no live LLM)
	docker compose -f docker-compose.smoke.yml up --build --abort-on-container-exit

wait-ready:
	@until $(COMPOSE) logs --since=30s openclaw 2>&1 | grep -q "\[gateway\] ready"; do sleep 1; done
	@echo "[gateway] ready"
