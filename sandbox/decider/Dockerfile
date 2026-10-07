# oasis-decider — typed-decision sidecar for the reviewer (CLAW-118, SHADOW).
#
# Model: convaiinnovations/laya-typed-decisions (ModernBERT-large, 421M,
# Apache-2.0, safetensors only). Weights are BAKED into the image at a pinned
# commit and the build fails if model.safetensors does not match its LFS
# SHA-256. The container runs with HF_HUB_OFFLINE=1 and never downloads.
#
# Inference code: the `laya` package, pinned to one version AND one wheel hash
# (pip --require-hashes). Version 0.4.0 was read before pinning: no network,
# subprocess, eval/exec, or pickle calls in the inference path; weights load
# through safetensors.load_file only. Re-read the diff before bumping it.
#
# Library versions match the oasis-semantics image (torch 2.13.0 CPU,
# transformers 5.15.0), the stack already proven on this host.
#
# Runtime posture (sandbox/docker-compose.sandbox-runtime.yml): internal
# networks only, read-only root, tmpfs /tmp, no capabilities, uid 10001,
# memory ceiling.

FROM python:3.12-slim

ARG LAYA_REPO=convaiinnovations/laya-typed-decisions
ARG LAYA_REVISION=e929ae5cf69bc34259cd2f95c9e91145b818b1f0
ARG LAYA_WEIGHTS_SHA256=4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.13.0 \
 && pip install \
      transformers==5.15.0 tokenizers==0.22.2 safetensors==0.8.0 \
      huggingface_hub==1.27.0 numpy==2.5.2

COPY requirements-laya.txt /tmp/requirements-laya.txt
RUN pip install --no-deps --require-hashes -r /tmp/requirements-laya.txt

# Weights: pinned commit, then a hard SHA-256 check on the one large file.
RUN set -eux; \
    python3 -c "from huggingface_hub import snapshot_download; snapshot_download('${LAYA_REPO}', revision='${LAYA_REVISION}', local_dir='/opt/decider/model', allow_patterns=['config.json','rl_agent_config.json','model.safetensors','encoder/*','tokenizer/*'])"; \
    echo "${LAYA_WEIGHTS_SHA256}  /opt/decider/model/model.safetensors" | sha256sum -c -; \
    rm -rf /opt/decider/model/.cache; \
    chmod -R a+rX,go-w /opt/decider

RUN groupadd -g 10001 decider && useradd -u 10001 -g 10001 -s /bin/false -d /tmp decider

COPY decider_server.py /opt/decider/decider_server.py

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    USE_TF=0 \
    HOME=/tmp \
    DECIDER_MODEL_DIR=/opt/decider/model \
    DECIDER_MODEL_NAME=${LAYA_REPO} \
    DECIDER_MODEL_REVISION=${LAYA_REVISION} \
    DECIDER_PORT=8790

USER 10001:10001
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8790/healthz', timeout=4)"
CMD ["python3", "/opt/decider/decider_server.py"]
