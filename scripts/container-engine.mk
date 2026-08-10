# ── Container engine resolution: Docker or Podman ────────────────────────────
#
# oasis-claw runs on either engine. This file is the ONE place that decides
# which engine a `make` run uses, so every Makefile in the repo agrees.
#
# Why this exists: Docker Desktop needs a paid licence at most large companies,
# so a corporate Linux workstation or VDI usually ships rootless Podman instead.
# The compose files themselves are engine-neutral; only the CLI names and a
# handful of rootless-Podman details differ, and both live here.
#
# Include it, then use the variables below:
#
#     .DEFAULT_GOAL := help                  # this file defines targets too
#     include scripts/container-engine.mk    # from the repo root
#
# From a subdirectory, derive the path so the include survives any working
# directory:
#
#     MK_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
#     include $(MK_DIR)../scripts/container-engine.mk
#
# ── Variables this file sets ─────────────────────────────────────────────────
#
#   ENGINE             docker | podman | none.  Auto-detected.
#                      Override per run:   make ENGINE=podman up
#                      Override per shell:  export ENGINE=podman
#   CONTAINER          The engine CLI. Use it for run / exec / cp / logs /
#                      inspect / volume. Prefer it over the compose front end
#                      for anything that must work on both engines, because
#                      podman-compose implements only a subset of the compose
#                      subcommands (it has no `cp`, and `--since` on `logs` is
#                      not reliable).
#   COMPOSE_CMD        The compose front end: "docker compose",
#                      "podman compose", or "podman-compose".
#   IS_PODMAN          Non-empty when ENGINE is podman. Use it as a switch:
#                        $(if $(IS_PODMAN),--userns=$(PODMAN_KEEPID),)
#   PODMAN_KEEPID      The keep-id user-namespace mode for rootless Podman.
#                      See "Rootless Podman" below.
#   OASIS_MOUNT_LABEL  ",z" on a host that enforces SELinux, empty elsewhere.
#                      EXPORTED, so a compose file can append it to a bind
#                      mount option string:
#                        - ./role.yaml:/app/role.yaml:ro${OASIS_MOUNT_LABEL:-}
#                      Without the label, SELinux denies every bind mount on
#                      RHEL, Fedora, and CentOS. The option is inert on Docker
#                      and on a host with SELinux off, so it is always safe.
#                      Use lower-case "z" (shared), never "Z" (private): "Z"
#                      relabels the tree for one container only and locks the
#                      host user out of the user's own files.
#
# ── Detection order ──────────────────────────────────────────────────────────
#
#   1. ENGINE from the command line or the environment always wins.
#   2. A `docker` command that is really the podman-docker shim -> podman.
#      (The shim is a wrapper script; `docker --version` prints "podman".
#      Trusting the command name alone would pick the wrong CLI flags.)
#   3. A real `docker`  -> docker.
#   4. `podman`         -> podman.
#   5. Neither          -> none. Targets then fail through _require-engine with
#      a readable message instead of "docker: command not found".
#
# ── Rootless Podman ──────────────────────────────────────────────────────────
#
# Under rootless Podman the host user maps to UID 0 INSIDE the container, and
# every other container UID comes from the user's /etc/subuid range. A container
# process running as UID 1000 (the `node` user in the oasis-claw runtime image)
# therefore lands on a subordinate UID on the host and CANNOT write a
# bind-mounted host directory that the host user owns.
#
# PODMAN_KEEPID fixes that for the services that need a writable host bind
# mount. `keep-id:uid=1000,gid=1000` maps the host user to container UID 1000,
# so `node` inside the container IS the host user outside it. Files the agent
# writes on a bind mount come out owned by the host user, as they do on Docker.
#
# Apply it only to a service that has a READ-WRITE host bind mount. A service
# with read-only mounts of world-readable files, or with named volumes only,
# works under the default mapping and does not need it. keep-id needs a
# /etc/subuid and /etc/subgid entry for the user; without one, Podman fails at
# container creation with a mapping error.

# ── engine ───────────────────────────────────────────────────────────────────
# `ifndef` covers the environment case. A command-line assignment (make
# ENGINE=podman) outranks any assignment in a makefile, so it needs no guard.
ifndef ENGINE
ENGINE := $(shell \
	if command -v docker >/dev/null 2>&1; then \
	  if docker --version 2>/dev/null | grep -qi podman; then echo podman; \
	  else echo docker; fi; \
	elif command -v podman >/dev/null 2>&1; then echo podman; \
	else echo none; fi)
endif

IS_PODMAN := $(filter podman,$(ENGINE))
PODMAN_KEEPID := keep-id:uid=1000,gid=1000

# ── CLI + compose front end ──────────────────────────────────────────────────
ifeq ($(ENGINE),podman)
  CONTAINER ?= podman
  # `podman compose` is the preferred front end. It does not implement compose
  # itself — it finds an external provider, wires DOCKER_HOST to the Podman
  # socket, and execs it. The Compose v2 binary is Apache-2.0 and is NOT part of
  # the licensed Docker Desktop product, so installing it on a corporate host is
  # a licence question about Docker Desktop, not about Compose.
  #
  # Podman searches PATH for `docker-compose`, and it takes the FIRST match
  # whether or not that file is a working binary. A truncated or failed download
  # left at /usr/local/bin/docker-compose therefore breaks `podman compose`
  # entirely, with "exec format error" and no hint that a good binary exists
  # further along. Probe the standard cli-plugins locations and pin a provider
  # that actually runs. PODMAN_COMPOSE_PROVIDER overrides Podman's own search.
  PODMAN_COMPOSE_PROVIDER ?= $(shell \
	if podman compose version >/dev/null 2>&1; then echo ""; \
	else for c in "$$HOME/.docker/cli-plugins/docker-compose" \
	              /usr/local/lib/docker/cli-plugins/docker-compose \
	              /opt/homebrew/lib/docker/cli-plugins/docker-compose \
	              /usr/lib/docker/cli-plugins/docker-compose \
	              /usr/libexec/docker/cli-plugins/docker-compose; do \
	      if [ -x "$$c" ] && "$$c" version >/dev/null 2>&1; then echo "$$c"; break; fi; \
	    done; fi)
  ifneq ($(PODMAN_COMPOSE_PROVIDER),)
    export PODMAN_COMPOSE_PROVIDER
  endif
  # podman-compose is the fallback: a smaller Python reimplementation, and the
  # usual choice on a corporate Linux host.
  COMPOSE_CMD ?= $(shell \
	if [ -n "$(PODMAN_COMPOSE_PROVIDER)" ]; then echo "podman compose"; \
	elif podman compose version >/dev/null 2>&1; then echo "podman compose"; \
	elif command -v podman-compose >/dev/null 2>&1; then echo "podman-compose"; \
	else echo "podman compose"; fi)
else
  CONTAINER ?= docker
  COMPOSE_CMD ?= $(shell \
	if docker compose version >/dev/null 2>&1; then echo "docker compose"; \
	elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; \
	else echo "docker compose"; fi)
endif

# ── SELinux bind-mount label ─────────────────────────────────────────────────
# `selinuxenabled` exits 0 only when SELinux is on. It does not exist on macOS
# or on Debian and Ubuntu, so the whole chain fails and the label stays empty.
ifndef OASIS_MOUNT_LABEL
OASIS_MOUNT_LABEL := $(shell command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled 2>/dev/null && echo ',z')
endif
export OASIS_MOUNT_LABEL

.PHONY: engine _require-engine

engine: ## print the resolved container engine and compose front end
	@echo "ENGINE            = $(ENGINE)"
	@echo "CONTAINER         = $(CONTAINER)"
	@echo "COMPOSE_CMD       = $(COMPOSE_CMD)"
	@echo "OASIS_MOUNT_LABEL = '$(OASIS_MOUNT_LABEL)'$(if $(OASIS_MOUNT_LABEL), (SELinux is enforcing),)"
	$(if $(PODMAN_COMPOSE_PROVIDER),@echo "compose provider  = $(PODMAN_COMPOSE_PROVIDER) (pinned)")
	@printf "%-18s= " "version"; { $(CONTAINER) --version 2>/dev/null || echo "(engine CLI not runnable)"; } | head -1
	@printf "%-18s= " "compose"; { $(COMPOSE_CMD) version 2>/dev/null || echo "(compose front end not runnable)"; } | head -1
	@echo ""
	@echo "Override with:  make ENGINE=podman <target>   (or export ENGINE=podman)"

# Gate for any target that runs a container. Keeps `make help` and `make engine`
# usable on a host with no engine at all.
_require-engine:
	@test "$(ENGINE)" != "none" || { \
	  echo "No container engine found. Install Docker or Podman, or set ENGINE=<name>."; \
	  echo "  Debian / Ubuntu:  sudo apt-get install -y podman uidmap"; \
	  echo "  RHEL / Fedora:    sudo dnf install -y podman"; \
	  exit 2; }
	@command -v $(CONTAINER) >/dev/null 2>&1 || { \
	  echo "ENGINE=$(ENGINE) but '$(CONTAINER)' is not on PATH."; exit 2; }
