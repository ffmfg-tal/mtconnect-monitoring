from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    agent_url: str
    cloud_base_url: str
    cloud_secret: str
    buffer_path: str
    poll_interval_s: float
    forward_interval_s: float
    forward_batch_size: int

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            agent_url=os.environ.get("MTC_AGENT_URL", "http://localhost:5000"),
            cloud_base_url=os.environ.get("MTC_CLOUD_URL", "http://localhost:8787"),
            cloud_secret=os.environ.get("MTC_EDGE_SECRET", "test-secret"),
            buffer_path=os.environ.get("MTC_BUFFER_PATH", "/var/lib/mtconnect/forwarder.sqlite"),
            poll_interval_s=float(os.environ.get("MTC_POLL_INTERVAL_S", "1.0")),
            forward_interval_s=float(os.environ.get("MTC_FORWARD_INTERVAL_S", "1.0")),
            forward_batch_size=int(os.environ.get("MTC_FORWARD_BATCH", "500")),
        )
