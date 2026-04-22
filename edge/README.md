# edge

## Local end-to-end smoke test (no real machine)

### Prerequisites

- podman + podman-compose
- Python 3.12 + this repo's edge/forwarder installed
- Cloud worker running locally (see `cloud/README.md` for `npm run dev`)
- Ruby 3.x (optional — used by compose's `simulator` service)

### Run

```bash
cd cloud && npm run dev &                           # terminal 1
cd edge/compose && cp .env.example .env && podman-compose up --build   # terminal 2
```

Expected:

- `simulator` container opens SHDR listener on :7878 within the compose network, piping mazak.txt
- `cppagent` container connects and exposes :5000 (mapped to host :5000)
- `forwarder` container fetches /probe, seeds cursor from /current, polls /sample, POSTs to http://host.containers.internal:8787

Verify:

```bash
curl http://localhost:5000/probe | head -20        # cppagent is up
curl http://localhost:8787/machines                # cloud has received the probe
curl http://localhost:8787/machines/000-mazak-01/current   # observations flowing
```

### Tear down

```bash
cd edge/compose && podman-compose down -v
```

## Unit tests

```bash
cd edge/forwarder && pytest -v
```
