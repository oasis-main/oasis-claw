# oasis-state sidecar — bash + rclone + age + tar, nothing else.
#
# Built and used implicitly by snapshot.sh / restore.sh. You don't run this
# image directly; the wrapper scripts `docker run --rm` it with the right
# mounts (oasis_openclaw_home volume, host rclone config, host age key,
# host state-repo working tree).

FROM alpine:3.20

RUN apk add --no-cache \
      bash \
      coreutils \
      tar \
      gzip \
      rclone \
      age \
      git \
      jq \
      ca-certificates \
 && rm -rf /var/cache/apk/*

# The sidecar runs as the same uid as oasis-claw-runtime's `node` user so
# tarballs created here can be unpacked into the same volume without
# chown shenanigans on restore.
ARG UID=1000
ARG GID=1000
RUN addgroup -g ${GID} state && adduser -D -u ${UID} -G state state

USER state
WORKDIR /work

ENTRYPOINT ["/bin/bash"]
