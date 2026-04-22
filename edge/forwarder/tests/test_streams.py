from pathlib import Path

from forwarder.streams import parse_streams

FIXTURE = Path(__file__).parent / "fixtures" / "mazak_sample_chunk1.xml"


def test_extracts_header_with_sequences():
    r = parse_streams(FIXTURE.read_text(encoding="utf-8"))
    assert r.instance_id
    assert r.first_sequence >= 0
    assert r.next_sequence > r.first_sequence


def test_extracts_observations_with_required_fields():
    r = parse_streams(FIXTURE.read_text(encoding="utf-8"))
    assert len(r.observations) > 0
    o = r.observations[0]
    assert o.device_uuid
    assert isinstance(o.sequence, int)
    assert o.timestamp
    assert o.data_item_id
    assert o.category in {"SAMPLE", "EVENT", "CONDITION"}


def test_parses_condition_level_when_category_is_condition():
    r = parse_streams(FIXTURE.read_text(encoding="utf-8"))
    conds = [o for o in r.observations if o.category == "CONDITION"]
    for c in conds:
        assert c.condition_level in {"NORMAL", "WARNING", "FAULT", "UNAVAILABLE"}


def test_parses_value_num_for_numeric_samples():
    r = parse_streams(FIXTURE.read_text(encoding="utf-8"))
    samples = [
        o for o in r.observations if o.category == "SAMPLE" and o.value_str and o.value_str != "UNAVAILABLE"
    ]
    numeric = [s for s in samples if s.value_num is not None]
    assert len(numeric) > 0
