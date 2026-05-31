FROM python:3.13-slim

WORKDIR /app

ARG YTDLP_REPO=https://github.com/yt-dlp/yt-dlp.git
ARG YTDLP_REF=master

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates git curl tini && \
    git clone --depth 1 --branch "${YTDLP_REF}" "${YTDLP_REPO}" /tmp/yt-dlp && \
    pip install --no-cache-dir "/tmp/yt-dlp[default]" && \
    rm -rf /tmp/yt-dlp && \
    apt-get purge -y git && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY ui ./ui

ENV DOWNLOAD_DIR=/downloads
ENV TEMP_DIR=/downloads/.tmp
ENV PORT=8090

VOLUME /downloads
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/" || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["python", "-m", "backend.main"]
