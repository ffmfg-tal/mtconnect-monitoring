FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2 \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system mtconnect --gid 2000 \
 && useradd --system --gid mtconnect --uid 2000 --home /app mtconnect

WORKDIR /app

COPY pyproject.toml ./
COPY src/ ./src/

RUN pip install --no-cache-dir . \
 && mkdir -p /var/lib/mtconnect \
 && chown -R mtconnect:mtconnect /var/lib/mtconnect /app

USER mtconnect

VOLUME ["/var/lib/mtconnect"]

ENTRYPOINT ["forwarder"]
