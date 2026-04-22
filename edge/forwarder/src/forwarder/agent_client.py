from __future__ import annotations

import httpx


class AgentClient:
    def __init__(self, base_url: str, *, timeout: float = 30.0) -> None:
        self._client = httpx.AsyncClient(base_url=base_url, timeout=timeout)

    async def close(self) -> None:
        await self._client.aclose()

    async def fetch_probe(self) -> str:
        r = await self._client.get("/probe")
        r.raise_for_status()
        return r.text

    async def fetch_current(self) -> str:
        r = await self._client.get("/current")
        r.raise_for_status()
        return r.text

    async def fetch_sample(
        self,
        *,
        from_sequence: int,
        count: int = 1000,
        interval_ms: int | None = None,
        heartbeat_ms: int | None = None,
    ) -> str:
        params: dict[str, str | int] = {"from": from_sequence, "count": count}
        if interval_ms is not None:
            params["interval"] = interval_ms
        if heartbeat_ms is not None:
            params["heartbeat"] = heartbeat_ms
        r = await self._client.get("/sample", params=params)
        r.raise_for_status()
        return r.text
