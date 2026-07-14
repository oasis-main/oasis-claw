# oasis-claw runtime shortcuts
#
# All targets are thin wrappers around `docker compose -f docker-compose.runtime.yml`.
# See .swarm/security-notes.md for when to use each.

COMPOSE := docker compose -f docker-compose.runtime.yml

.PHONY: help up restart recreate rebuild down logs status token healthz shell smoke creds-list creds-refresh assets-list assets-set assets-show

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

creds-list: ## list gog OAuth accounts across every bot (PROBE=1 for live probe)
	@./scripts/claw-creds list $(if $(PROBE),--probe,)

creds-refresh: ## refresh OAuth creds (BOTS='nimbus kolmogorov' or BOTS=--all; optional ACCOUNT=email, PASTE=1)
	@./scripts/claw-creds refresh $(BOTS) \
	    $(if $(ACCOUNT),--account $(ACCOUNT),) \
	    $(if $(PASTE),--paste,)

git-list: ## list per-bot GitHub token + push allowlist (PROBE=1 for live gh api)
	@./scripts/claw-git list $(if $(PROBE),--probe,)

git-check: ## live-check one bot's GitHub token (BOT=<name>)
	@test -n "$(BOT)" || { echo "BOT=<name> required"; exit 2; }
	@./scripts/claw-git check $(BOT)

git-set: ## store a bot's PAT + scope (BOT=<name>; prompts for token; REPOS='o/a o/b', NAME=, EMAIL=)
	@test -n "$(BOT)" || { echo "BOT=<name> required"; exit 2; }
	@./scripts/claw-git set $(BOT) \
	    $(if $(REPOS),--repos "$(REPOS)",) \
	    $(if $(NAME),--name "$(NAME)",) \
	    $(if $(EMAIL),--email "$(EMAIL)",)

git-repos: ## edit a bot's push allowlist (BOT=<name>; ADD=o/r or RM=o/r or SET='o/a o/b')
	@test -n "$(BOT)" || { echo "BOT=<name> required"; exit 2; }
	@./scripts/claw-git repos $(BOT) \
	    $(if $(ADD),--add $(ADD),) $(if $(RM),--remove $(RM),) \
	    $(if $(SET),--set "$(SET)",)

git-rotate: ## open the fine-grained-PAT page then store the new token (BOT=<name>)
	@test -n "$(BOT)" || { echo "BOT=<name> required"; exit 2; }
	@./scripts/claw-git rotate $(BOT)

git-app-init: ## store shared GitHub App creds once (APP_ID=<id> KEY=<pem> [INST=<installation-id>])
	@test -n "$(APP_ID)" || { echo "APP_ID=<id> required"; exit 2; }
	@test -n "$(KEY)"    || { echo "KEY=<path-to-pem> required"; exit 2; }
	@./scripts/claw-git app-init --app-id $(APP_ID) --key "$(KEY)" $(if $(INST),--installation-id $(INST),)

git-app-set: ## configure a bot for GitHub App auth (BOT=<name> REPOS='o/a o/b' [INST=<id>])
	@test -n "$(BOT)" || { echo "BOT=<name> required"; exit 2; }
	@./scripts/claw-git app-set $(BOT) \
	    $(if $(REPOS),--repos "$(REPOS)",) $(if $(INST),--installation-id $(INST),) \
	    $(if $(NAME),--name "$(NAME)",) $(if $(EMAIL),--email "$(EMAIL)",)

assets-list: ## list per-bot avatar inventory (name, size, dims, hash)
	@./scripts/claw-assets list

assets-set: ## set a bot's avatar (BOT=<name> AVATAR=<path>; optional NAME=<file>, RELOAD=0)
	@test -n "$(BOT)"    || { echo "BOT=<name> required";    exit 2; }
	@test -n "$(AVATAR)" || { echo "AVATAR=<path> required"; exit 2; }
	@./scripts/claw-assets set $(BOT) --avatar "$(AVATAR)" \
	    $(if $(NAME),--name "$(NAME)",) \
	    $(if $(filter 0 no false,$(RELOAD)),--no-reload,)

assets-show: ## open a bot's current avatar (BOT=<name>)
	@test -n "$(BOT)" || { echo "BOT=<name> required"; exit 2; }
	@./scripts/claw-assets show $(BOT)

wait-ready:
	@until $(COMPOSE) logs --since=30s openclaw 2>&1 | grep -q "\[gateway\] ready"; do sleep 1; done
	@echo "[gateway] ready"
