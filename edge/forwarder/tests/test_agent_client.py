from pathlib import Path

from pytest_httpx import HTTPXMock

from forwarder.agent_client import AgentClient

FIX = Path(__file__).parent / "fixtures"


async def test_fetch_probe(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://agent.test:5000/probe",
        text=(FIX / "mazak_probe.xml").read_text(encoding="utf-8"),
    )
    client = AgentClient("http://agent.test:5000")
    xml = await client.fetch_probe()
    assert xml.startswith("<?xml")
    await client.close()


async def test_fetch_sample_at_cursor(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://agent.test:5000/sample?from=100&count=1000",
        text=(FIX / "mazak_sample_chunk1.xml").read_text(encoding="utf-8"),
    )
    client = AgentClient("http://agent.test:5000")
    xml = await client.fetch_sample(from_sequence=100, count=1000)
    assert "MTConnectStreams" in xml
    await client.close()


async def test_fetch_current(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://agent.test:5000/current",
        text=(FIX / "mazak_sample_chunk1.xml").read_text(encoding="utf-8"),
    )
    client = AgentClient("http://agent.test:5000")
    xml = await client.fetch_current()
    assert "MTConnectStreams" in xml
    await client.close()
