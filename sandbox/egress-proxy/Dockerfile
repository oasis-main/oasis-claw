# Fail-closed egress proxy for the oasis-claw operating-system-sandbox (CLAW-033).
#
# Multi-stage: a static Go binary on `scratch`. No shell, no libc, no CA bundle
# — the proxy performs no outbound TLS validation (CONNECT tunnels stay opaque),
# so the entire runtime attack surface is one static binary and nothing else.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 GOFLAGS=-mod=mod go build -trimpath -ldflags="-s -w" -o /egress-proxy .
# Pre-created, correctly-owned mountpoint for the AUDIT_FILE sink. Docker seeds a
# fresh NAMED VOLUME from the image path's ownership/permissions — without this
# the volume would be root:root and the non-root proxy could not write its audit.
# 0755 so the (differently-uid'd) vetting service can read it back.
# The .keep is load-bearing: COPY of an EMPTY directory contributes nothing to
# the layer, so the destination would not exist and the volume would fall back to
# root:root — which is exactly how this failed the first time.
RUN mkdir -p /out/audit && touch /out/audit/.keep

FROM scratch
COPY --from=build /egress-proxy /egress-proxy
COPY allowlist.txt /etc/egress/allowlist.txt
COPY --from=build --chown=65532:65532 /out/audit /var/lib/egress/audit
# Non-root numeric UID (works without /etc/passwd on scratch).
USER 65532:65532
EXPOSE 3128
ENTRYPOINT ["/egress-proxy"]
