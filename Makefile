# oasis-claw runtime shortcuts
#
# All targets are thin wrappers around `<compose> -f docker-compose.runtime.yml`.
# See .swarm/security-notes.md for when to use each.
#
# The container engine is Docker or Podman, resolved by the include below.
# `make engine` prints which one this host uses. Override with ENGINE=podman.

.DEFAULT_GOAL := help
include scripts/container-engine.mk

COMPOSE := $(COMPOSE_CMD) -f docker-compose.runtime.yml

.PHONY: help up restart recreate rebuild down logs status token healthz shell smoke creds-list creds-refresh assets-list assets-set assets-show reviewer-policy

# Where a deployment keeps its PRIVATE reviewer overlay and the merged result.
# Both live under a gitignored path: the committed policy is a generic baseline
# with `per_bot` empty, and real bot identities/scopes must never be committed.
REVIEWER_POLICY_BASE    ?= extensions/oasis-reviewer/policy/reviewer-policy.json
REVIEWER_POLICY_OVERLAY ?= bots/reviewer-policy.local.json
REVIEWER_POLICY_OUT     ?= bots/.runtime/reviewer-policy.json

# Every target that starts a container first checks that an engine exists. A
# rule with prerequisites and no recipe only ADDS prerequisites, so each target
# keeps the recipe it declares below.
up restart recreate rebuild down logs status token healthz shell smoke: _require-engine

help:
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

reviewer-policy: ## merge the private reviewer overlay over the committed generic base
	@if [ ! -f "$(REVIEWER_POLICY_OVERLAY)" ]; then \
	  echo "No private overlay at $(REVIEWER_POLICY_OVERLAY) — nothing to merge."; \
	  echo "The committed policy is a generic baseline with per_bot empty. A real"; \
	  echo "deployment supplies its own overlay there; see scripts/reviewer-policy-merge.py."; \
	  exit 0; \
	fi
	@mkdir -p $(dir $(REVIEWER_POLICY_OUT))
	@python3 scripts/reviewer-policy-merge.py \
	  "$(REVIEWER_POLICY_BASE)" "$(REVIEWER_POLICY_OVERLAY)" "$(REVIEWER_POLICY_OUT)"

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

stuck-lanes: ## find Telegram lanes silently blocked behind a poisoned update
	@scripts/claw-stuck-lanes

healthz: ## authenticated healthz probe
	@TOKEN=$$($(COMPOSE) exec -T openclaw cat /home/node/.openclaw/.gateway-token); \
	curl -sS -H "Authorization: Bearer $$TOKEN" http://127.0.0.1:18789/healthz; echo

shell: ## interactive shell inside the runtime container
	$(COMPOSE) exec openclaw bash

smoke: ## run plugin-registration smoke test (mock API, no live LLM)
	$(COMPOSE_CMD) -f docker-compose.smoke.yml up --build --abort-on-container-exit

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

# ── nimbus-watchdog (launchd) ────────────────────────────────────────────────
# The script is DEPLOYED outside the repo on purpose. macOS TCC blocks launchd
# agents from reading ~/Documents, so an agent pointed into this repo fails with
# "Operation not permitted" (exit 126) on every fire — and does so SILENTLY,
# which for a watchdog is indistinguishable from healthy. That is how this agent
# sat dead. The script needs only `docker` + ~/Library/Logs, so a deployed copy
# outside TCC-protected space is the whole fix: no Full Disk Access grant, and no
# container holding a root-equivalent docker socket just to run `docker restart`.
WATCHDOG_DIR := $(HOME)/Library/Application Support/oasis-x
WATCHDOG_PLIST := $(HOME)/Library/LaunchAgents/com.oasis-x.nimbus-watchdog.plist

.PHONY: watchdog-install watchdog-status watchdog-uninstall egress-check egress-sync

watchdog-install: ## (re)deploy + load the nimbus telegram-channel watchdog — re-run after editing the script
	@mkdir -p "$(WATCHDOG_DIR)"
	@cp scripts/nimbus-watchdog.sh "$(WATCHDOG_DIR)/nimbus-watchdog.sh"
	@chmod +x "$(WATCHDOG_DIR)/nimbus-watchdog.sh"
	@cp scripts/com.oasis-x.nimbus-watchdog.plist "$(WATCHDOG_PLIST)"
	@plutil -lint "$(WATCHDOG_PLIST)" >/dev/null
	@launchctl bootout gui/$$(id -u)/com.oasis-x.nimbus-watchdog 2>/dev/null || true
	@launchctl bootstrap gui/$$(id -u) "$(WATCHDOG_PLIST)"
	@echo "watchdog installed — verify with: make watchdog-status"

watchdog-status: ## show the watchdog's last exit code (0 = healthy; 126 = TCC-blocked, see watchdog-install)
	@launchctl print gui/$$(id -u)/com.oasis-x.nimbus-watchdog 2>/dev/null \
	  | grep -E "state =|last exit code" || echo "not loaded"
	@tail -3 "$(HOME)/Library/Logs/nimbus-watchdog.stderr.log" 2>/dev/null || true

watchdog-uninstall: ## unload the watchdog
	@launchctl bootout gui/$$(id -u)/com.oasis-x.nimbus-watchdog 2>/dev/null || true
	@echo "watchdog unloaded"

# ── egress partitioning health ───────────────────────────────────────────────
egress-check: ## verify client.map still matches live bot IPs (CLAW-050 isolation)
	@python3 ./scripts/claw-egress-sync --check

egress-sync: ## regenerate client.map from live bot IPs after a restart/recreate
	@python3 ./scripts/claw-egress-sync
