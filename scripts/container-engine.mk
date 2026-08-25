# ── Container engine resolution: Docker, Podman, or Colima ───────────────────
#
# oasis-claw runs on all three. This file is the ONE place that decides which
# engine a `make` run uses, so every Makefile in the repo agrees.
#
# Why this exists: Docker Desktop needs a paid licence at most large companies,
# so a corporate Linux workstation or VDI usually ships rootless Podman instead,
# and a macOS host usually ships Colima. The compose files themselves are
# engine-neutral; only the CLI names, the virtual machine front end, and a
# handful of rootless-Podman details differ, and all of them live here.
#
# Colima is not a third CLI. Colima is a Lima virtual machine that runs dockerd,
# and the ordinary docker CLI drives it. ENGINE therefore stays `docker` on a
# Colima host, and no compose file changes. What Colima does change is the
# daemon: the docker CLI is on PATH as soon as you install it, but every target
# still fails until `colima start` runs. CONTAINER_VM below reports that state
# in one line, instead of leaving the user with "Cannot connect to the Docker
# daemon".
#
# Licences, because that is usually why a host ends up on one engine and not
# another: Docker Desktop is the licensed product. The docker CLI and dockerd
# are Apache-2.0, Compose v2 is Apache-2.0, Podman is Apache-2.0, and Colima is
# MIT. Docker Desktop is the only part of this set with a subscription
# requirement.
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
#   CONTAINER_VM       colima | podman-machine | none.  Auto-detected.
#                      Names the virtual machine that hosts the engine daemon.
#                      macOS has no native container daemon, so one always runs
#                      inside a virtual machine there. `none` means the CLI
#                      reaches a local daemon directly, the normal case on
#                      Linux.
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
#
# ── macOS: Colima ────────────────────────────────────────────────────────────
#
# Colima gives macOS a dockerd without Docker Desktop:
#
#     brew install colima docker docker-compose
#     colima start --cpu 4 --memory 6 --disk 60
#
# ENGINE resolves to `docker`, because the docker CLI is the client.
#
# On an INTEL Mac, add two flags:
#
#     colima start --cpu 4 --memory 6 --disk 60 --vm-type qemu --mount-type 9p
#
# The `vz` virtualisation backend and the virtiofs mount type are Apple Silicon
# features. Colima does fall back on its own, but the failure is slow and the
# message is unclear, so pass the flags. `make engine` prints the correct
# command for the host it runs on.
#
# Podman is the alternative on Apple Silicon: `podman machine start`. It is NOT
# an alternative on an Intel Mac. Podman 6.0, released July 2026, dropped Intel
# Mac support, and Homebrew ships the 6.x line, so `brew install podman` fails
# there with an arm64 requirement. Colima is the supported path on Intel.
#
# A bind mount under Colima crosses the virtual machine boundary, so the host
# user maps into the virtual machine and a container UID that does not match it
# cannot write the mount. This is the same class of problem PODMAN_KEEPID
# solves above, but the fix differs: adjust the UID on the service or on the
# mount. Prove it with a real write into the mount. Do not trust an inspect
# field.

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

# ── virtual machine hosting the engine daemon ────────────────────────────────
# Knowing WHICH virtual machine turns "Cannot connect to the Docker daemon" into
# a command the user can run. On Linux this resolves to `none` and costs one
# `command -v`.
ifndef CONTAINER_VM
CONTAINER_VM := $(shell \
	if [ "$(ENGINE)" = "docker" ] && command -v colima >/dev/null 2>&1; then echo colima; \
	elif [ "$(ENGINE)" = "podman" ] && [ "$$(uname -s)" = "Darwin" ]; then echo podman-machine; \
	else echo none; fi)
endif

# Intel Macs need an explicit backend and mount type; see "macOS: Colima" above.
# Empty on Apple Silicon and on Linux, so COLIMA_START is correct on any host.
#
# `uname -m` CANNOT be used here. On an Apple Silicon Mac, an x86_64 build of
# make or of /bin/sh runs under Rosetta, and every `uname -m` inside it reports
# x86_64. Homebrew's Intel prefix (/usr/local) is a common way to end up with
# one. The flags would then be added on Apple Silicon, where they force a slow
# emulated VM. `hw.optional.arm64` is a hardware property and reports the real
# machine whether or not the caller is translated. The sysctl does not exist off
# macOS, so the Darwin test guards it.
COLIMA_INTEL_FLAGS := $(shell \
	if [ "$$(uname -s)" = "Darwin" ] \
	   && [ "$$(sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]; then \
	  echo ' --vm-type qemu --mount-type 9p'; fi)
COLIMA_START := colima start --cpu 4 --memory 6 --disk 60$(COLIMA_INTEL_FLAGS)

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
	@echo "CONTAINER_VM      = $(CONTAINER_VM)"
	@echo "OASIS_MOUNT_LABEL = '$(OASIS_MOUNT_LABEL)'$(if $(OASIS_MOUNT_LABEL), (SELinux is enforcing),)"
	$(if $(PODMAN_COMPOSE_PROVIDER),@echo "compose provider  = $(PODMAN_COMPOSE_PROVIDER) (pinned)")
	@printf "%-18s= " "version"; { $(CONTAINER) --version 2>/dev/null || echo "(engine CLI not runnable)"; } | head -1
	@printf "%-18s= " "compose"; { $(COMPOSE_CMD) version 2>/dev/null || echo "(compose front end not runnable)"; } | head -1
	@printf "%-18s= " "daemon"; { $(CONTAINER) info >/dev/null 2>&1 && echo "reachable"; } || echo "NOT reachable"
	@if [ "$(CONTAINER_VM)" = "colima" ]; then \
	  printf "%-18s= " "colima"; colima status 2>&1 | head -1; \
	  echo "start it with:      $(COLIMA_START)"; \
	elif [ "$(CONTAINER_VM)" = "podman-machine" ]; then \
	  printf "%-18s= " "podman machine"; podman machine list 2>/dev/null | tail -n +2 | head -1; \
	  echo "start it with:      podman machine start"; \
	fi
	@echo ""
	@echo "Override with:  make ENGINE=podman <target>   (or export ENGINE=podman)"

# Gate for any target that runs a container. Keeps `make help` and `make engine`
# usable on a host with no engine at all.
#
# The third check costs one `info` call per target. It buys the Colima and
# Podman-machine cases a command to run: on macOS the CLI is present long before
# the daemon is, so "not on PATH" is the wrong diagnosis and the raw engine error
# names no fix.
_require-engine:
	@test "$(ENGINE)" != "none" || { \
	  echo "No container engine found. Install one, or set ENGINE=<name>."; \
	  echo "  Debian / Ubuntu:  sudo apt-get install -y podman uidmap"; \
	  echo "  RHEL / Fedora:    sudo dnf install -y podman"; \
	  echo "  macOS:            brew install colima docker docker-compose"; \
	  exit 2; }
	@command -v $(CONTAINER) >/dev/null 2>&1 || { \
	  echo "ENGINE=$(ENGINE) but '$(CONTAINER)' is not on PATH."; exit 2; }
	@$(CONTAINER) info >/dev/null 2>&1 || { \
	  echo "ENGINE=$(ENGINE): the CLI is installed, but its daemon does not answer."; \
	  if [ "$(CONTAINER_VM)" = "colima" ]; then \
	    echo "  Colima is installed and its virtual machine is not running. Start it:"; \
	    echo "    $(COLIMA_START)"; \
	  elif [ "$(CONTAINER_VM)" = "podman-machine" ]; then \
	    echo "  Start the Podman machine:  podman machine start"; \
	  elif [ "$(ENGINE)" = "docker" ]; then \
	    echo "  Start the Docker daemon, or install Colima and start it:"; \
	    echo "    brew install colima docker docker-compose && $(COLIMA_START)"; \
	  else \
	    echo "  Start the $(ENGINE) service, then run this target again."; \
	  fi; \
	  exit 2; }
