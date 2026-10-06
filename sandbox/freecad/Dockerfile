# oasis-freecad — FreeCAD 1.1.1 + an MCP server, for ButterBolt only (CLAW-117).
#
# FreeCAD version = the Mac's (1.1.1), so a file saved here opens there with no
# format drift. Both downloads are pinned by SHA-256; the build fails on a
# mismatch. The AppImage is extracted (no FUSE in a container) and runs under
# Xvfb, because get_view needs a real 3D view.
#
# Runtime posture (set in bots/docker-compose.butterbolt-cad.yml): internal
# network only, read-only root, tmpfs /tmp + /home/cad, memory ceiling, no
# capabilities, uid 10001. See .swarm/CLAW-117_BUTTERBOLT_FREECAD.md.

FROM python:3.12-slim-bookworm

ARG FREECAD_VERSION=1.1.1
ARG FREECAD_APPIMAGE=FreeCAD_1.1.1-Linux-aarch64-py311.AppImage
ARG FREECAD_SHA256=8004e166dc5c516cc8e8d85a5f58b5d56c3836cf8652301c2e6b9e4b1fd27827
# neka-nat/freecad-mcp v0.1.16 — the same commit as ~/Documents/Runes/freecad-mcp.
ARG FREECAD_MCP_COMMIT=4cec559dbc69cb0939b90b3b3b3d0642aeb09f91
ARG FREECAD_MCP_SHA256=97b17b027b627d82f8113e36a6885042a81bdc7116b3991b9dbd50a24d6b8f60

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xvfb \
      libgl1 libegl1 libglu1-mesa libopengl0 \
      libx11-xcb1 libxkbcommon0 libxkbcommon-x11-0 \
      libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 \
      libxcb-shape0 libxcb-xinerama0 libxcb-xfixes0 libxcb-cursor0 libxcb-xkb1 \
      libxrender1 libxi6 libxext6 libsm6 libice6 libxcomposite1 libxdamage1 libxrandr2 libxtst6 \
      libfontconfig1 libfreetype6 libdbus-1-3 libglib2.0-0 libnss3 libasound2 \
      fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# FreeCAD: download, verify, extract, drop the AppImage in the same layer.
RUN set -eux; \
    arch="$(uname -m)"; \
    if [ "$arch" != "aarch64" ]; then echo "pinned AppImage is aarch64; this build is $arch" >&2; exit 1; fi; \
    cd /tmp; \
    curl -fL --retry 3 -o fc.AppImage \
      "https://github.com/FreeCAD/FreeCAD/releases/download/${FREECAD_VERSION}/${FREECAD_APPIMAGE}"; \
    echo "${FREECAD_SHA256}  fc.AppImage" | sha256sum -c -; \
    chmod +x fc.AppImage; \
    ./fc.AppImage --appimage-extract >/dev/null; \
    mv squashfs-root /opt/freecad; \
    rm -f fc.AppImage; \
    chmod -R a+rX /opt/freecad

# MCP SDK pinned to the version freecad-mcp v0.1.16 was locked against.
RUN pip install --no-cache-dir "mcp==1.13.0" "validators==0.35.0"

COPY addon/ /tmp/oasis-addon/
RUN set -eux; \
    cd /tmp; \
    curl -fL --retry 3 -o fcmcp.tgz \
      "https://github.com/neka-nat/freecad-mcp/archive/${FREECAD_MCP_COMMIT}.tar.gz"; \
    echo "${FREECAD_MCP_SHA256}  fcmcp.tgz" | sha256sum -c -; \
    tar xzf fcmcp.tgz; \
    src="/tmp/freecad-mcp-${FREECAD_MCP_COMMIT}"; \
    mkdir -p /opt/oasis; \
    cp -r "${src}/src/freecad_mcp" /opt/oasis/freecad_mcp; \
    cp "${src}/LICENSE" /opt/oasis/freecad_mcp/LICENSE; \
    moddir="$(find /opt/freecad -maxdepth 5 -type d -name Mod -path '*/Mod' | head -1)"; \
    test -n "$moddir"; \
    echo "FreeCAD system Mod dir: $moddir"; \
    mkdir -p "$moddir/OasisFreeCADMCP"; \
    cp -r "${src}/addon/FreeCADMCP/rpc_server" "$moddir/OasisFreeCADMCP/rpc_server"; \
    cp /tmp/oasis-addon/Init.py /tmp/oasis-addon/InitGui.py "$moddir/OasisFreeCADMCP/"; \
    chmod -R a+rX "$moddir/OasisFreeCADMCP" /opt/oasis; \
    rm -rf /tmp/fcmcp.tgz "${src}" /tmp/oasis-addon

COPY cadpaths.py oasis_freecad_mcp.py /opt/oasis/

RUN useradd --uid 10001 --user-group --home-dir /home/cad --no-create-home --shell /usr/sbin/nologin cad

USER 10001:10001
ENV PYTHONPATH=/opt/oasis \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OASIS_FREECAD_BIN=/opt/freecad/AppRun \
    OASIS_FREECAD_HOME=/home/cad
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=4).status == 200 else 1)"
ENTRYPOINT ["python", "/opt/oasis/oasis_freecad_mcp.py"]
