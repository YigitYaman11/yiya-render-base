# Yiya bulut render temel imaji — HERKESE ACIK icerik; render kodu YOK, sir YOK.
# Icerik: Node 24.14.0 (worker ile ayni), Playwright 1.62.0 Chromium + headless-shell + sistem bagimliliklari,
# ffmpeg (Ubuntu 24.04: 6.1.1, libx264 + h264_nvenc), fontconfig, glvnd EGL (NVIDIA), sharp 0.34.5 (emlak doku / gorsel), kucuk baslatici.
# Derleme:  docker build -t yiya-render-base:2026-11-02 -f Dockerfile .
FROM ubuntu:24.04

ARG NODE_VERSION=24.14.0
ARG NODE_SHA256_LINUX_X64=
ENV DEBIAN_FRONTEND=noninteractive \
    NVIDIA_DRIVER_CAPABILITIES=all \
    NVIDIA_VISIBLE_DEVICES=all \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    YIYA_RUNTIME_MODULES=/opt/yiya-rt/node_modules \
    YIYA_FFMPEG_PATH=/usr/bin/ffmpeg \
    YIYA_FFPROBE_PATH=/usr/bin/ffprobe \
    YIYA_ROOT=/tmp/yiya

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils tar ffmpeg fontconfig \
      libegl1 libgles2 libgl1 libglvnd0 libopengl0 libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLo /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    (cd /tmp && grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sed "s#node-v${NODE_VERSION}-linux-x64.tar.xz#node.tar.xz#" | sha256sum -c -); \
    if [ -n "${NODE_SHA256_LINUX_X64}" ]; then echo "${NODE_SHA256_LINUX_X64}  /tmp/node.tar.xz" | sha256sum -c -; fi; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm -f /tmp/node.tar.xz /tmp/SHASUMS256.txt; \
    node --version

RUN mkdir -p /opt/yiya-rt && cd /opt/yiya-rt \
    && printf '{"name":"yiya-rt","private":true,"dependencies":{"playwright":"1.62.0","express":"4.22.2","dotenv":"16.6.1","sharp":"0.34.5"}}' > package.json \
    && npm install --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium chromium-headless-shell \
    && rm -rf /root/.npm /var/lib/apt/lists/*

RUN mkdir -p /usr/share/glvnd/egl_vendor.d \
    && printf '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}\n' > /usr/share/glvnd/egl_vendor.d/10_nvidia.json

COPY launcher.mjs /opt/yiya/launcher.mjs

RUN useradd -m -u 10001 yiya && mkdir -p /tmp/yiya && chown yiya:yiya /tmp/yiya
USER yiya
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/yiya/launcher.mjs"]
