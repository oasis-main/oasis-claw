# claw-vet watch — the first-visit egress vetting service (CLAW-034), containerized.
#
# WHY A CONTAINER AND NOT A HOST DAEMON:
#   macOS TCC blocks launchd agents from reading ~/Documents, so the host-daemon
#   route silently no-ops (it is why com.oasis-x.nimbus-watchdog had been dead).
#   Containerizing sidesteps TCC entirely — and lands a BETTER trust posture than
#   launchd would have: on the host, claw-vet runs with Mike's full user rights;
#   here it holds exactly four things and nothing else.
#
# WHAT IT CAN TOUCH:
#   • the learned store            RW  — it is the ONLY writer (CLAW-034 boundary)
#   • bots/<bot>/role.yaml         RO  — the policy it enforces
#   • the proxy's audit stream     RO  — its work queue
#   • the oasis-generation gateway     — the classifier
#
# WHAT IT DELIBERATELY DOES NOT HAVE:
#   • NO docker socket. Reading `docker logs` would need /var/run/docker.sock,
#     which is root-equivalent on the host — the AUDIT_FILE sink exists precisely
#     so this mount is unnecessary.
#   • NO route to oasis_sandboxed. The bots cannot reach the thing that decides
#     their egress; a compromised agent loop cannot talk to its own vetter.
#   • NO provider keys — inference goes through the gateway like everything else.
FROM python:3.12-slim

# whois feeds collect_whois_age (domain age is a real signal for throwaway attack
# domains); ca-certificates for the TLS/HTTP metadata probes. claw-vet is
# otherwise stdlib-only — PyYAML is the single dependency, for role.yaml.
RUN apt-get update \
    && apt-get install -y --no-install-recommends whois ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir pyyaml==6.0.2

# claw-vet resolves REPO as the parent of its own directory, so the script must
# live at /app/scripts/claw-vet for ROLES_DIR to land on /app/bots. Both are
# bind-mounted read-only at run time (see the compose service) — nothing is baked
# in, so a role.yaml or policy edit takes effect on restart with no rebuild.
WORKDIR /app

# Non-root, and specifically the HOST's uid:gid — the learned store is a host
# bind-mount, so anything written here must stay owned by Mike and editable from
# the host. Override at build time if that ever changes.
ARG VET_UID=501
ARG VET_GID=20
USER ${VET_UID}:${VET_GID}

ENTRYPOINT ["python3", "/app/scripts/claw-vet"]
CMD ["watch", "--interval", "30"]
