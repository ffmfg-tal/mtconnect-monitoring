from pathlib import Path

from forwarder.probe import parse_probe

FIXTURE = Path(__file__).parent / "fixtures" / "mazak_probe.xml"


def test_extracts_header():
    r = parse_probe(FIXTURE.read_text(encoding="utf-8"))
    assert r.instance_id
    assert r.schema_version


def test_extracts_at_least_one_device():
    r = parse_probe(FIXTURE.read_text(encoding="utf-8"))
    assert len(r.devices) >= 1
    d = r.devices[0]
    assert d.uuid
    assert d.name


def test_extracts_data_items_with_category_and_type():
    r = parse_probe(FIXTURE.read_text(encoding="utf-8"))
    all_items = [di for dev in r.devices for di in dev.data_items]
    assert len(all_items) > 0
    exec_items = [di for di in all_items if di.type == "EXECUTION"]
    assert len(exec_items) >= 1
    assert exec_items[0].category == "EVENT"


def test_every_data_item_has_component_path():
    r = parse_probe(FIXTURE.read_text(encoding="utf-8"))
    all_items = [di for dev in r.devices for di in dev.data_items]
    assert all(di.component_path for di in all_items)
