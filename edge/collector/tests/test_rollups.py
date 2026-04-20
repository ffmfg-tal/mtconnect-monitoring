from datetime import datetime, timezone

from collector.rollups import MinuteAccumulator, minute_bucket_iso

UTC = timezone.utc


def ts(minute: int, second: int) -> datetime:
    return datetime(2026, 4, 20, 14, minute, second, tzinfo=UTC)


class TestMinuteBucketIso:
    def test_floors_to_minute(self):
        assert minute_bucket_iso(ts(5, 37)) == "2026-04-20T14:05:00Z"

    def test_floor_exact_minute(self):
        assert minute_bucket_iso(ts(0, 0)) == "2026-04-20T14:00:00Z"


class TestMinuteAccumulator:
    def test_attribute_within_single_minute_no_flush(self):
        acc = MinuteAccumulator("haas-vf2-1")
        flushed = acc.attribute("ACTIVE", ts(0, 10), ts(0, 40))
        assert flushed == []

    def test_close_flushes_pending_bucket(self):
        acc = MinuteAccumulator("haas-vf2-1")
        acc.attribute("ACTIVE", ts(0, 10), ts(0, 40), program="O1", tool_number=7)
        final = acc.close()
        assert final is not None
        assert final.machine_id == "haas-vf2-1"
        assert final.minute_bucket == "2026-04-20T14:00:00Z"
        assert final.active_seconds == 30
        assert final.feed_hold_seconds == 0
        assert final.stopped_seconds == 0
        assert final.interrupted_seconds == 0
        assert final.offline_seconds == 0
        assert final.part_count_delta == 0
        assert final.program == "O1"
        assert final.tool_number == 7

    def test_close_when_empty_returns_none(self):
        acc = MinuteAccumulator("haas-vf2-1")
        assert acc.close() is None

    def test_multiple_states_in_same_minute(self):
        acc = MinuteAccumulator("haas-vf2-1")
        acc.attribute("ACTIVE", ts(0, 0), ts(0, 20))
        acc.attribute("FEED_HOLD", ts(0, 20), ts(0, 35))
        acc.attribute("STOPPED", ts(0, 35), ts(0, 55))
        final = acc.close()
        assert final.active_seconds == 20
        assert final.feed_hold_seconds == 15
        assert final.stopped_seconds == 20

    def test_attribute_crossing_minute_boundary_flushes(self):
        acc = MinuteAccumulator("haas-vf2-1")
        # 14:00:55 -> 14:01:10, all ACTIVE
        flushed = acc.attribute("ACTIVE", ts(0, 55), ts(1, 10))
        assert len(flushed) == 1
        first = flushed[0]
        assert first.minute_bucket == "2026-04-20T14:00:00Z"
        assert first.active_seconds == 5

        # 10 seconds left in current bucket (14:01)
        final = acc.close()
        assert final.minute_bucket == "2026-04-20T14:01:00Z"
        assert final.active_seconds == 10

    def test_attribute_spanning_multiple_full_minutes(self):
        acc = MinuteAccumulator("haas-vf2-1")
        # 14:00:30 -> 14:03:15, all ACTIVE (165 seconds across 4 buckets)
        flushed = acc.attribute("ACTIVE", ts(0, 30), ts(3, 15))
        assert len(flushed) == 3
        assert flushed[0].minute_bucket == "2026-04-20T14:00:00Z"
        assert flushed[0].active_seconds == 30
        assert flushed[1].minute_bucket == "2026-04-20T14:01:00Z"
        assert flushed[1].active_seconds == 60
        assert flushed[2].minute_bucket == "2026-04-20T14:02:00Z"
        assert flushed[2].active_seconds == 60

        final = acc.close()
        assert final.minute_bucket == "2026-04-20T14:03:00Z"
        assert final.active_seconds == 15

    def test_note_part_completed_increments_current_bucket(self):
        acc = MinuteAccumulator("haas-vf2-1")
        acc.attribute("ACTIVE", ts(0, 0), ts(0, 30))
        acc.note_part_completed(ts(0, 30))
        acc.note_part_completed(ts(0, 45))
        final = acc.close()
        assert final.part_count_delta == 2

    def test_program_and_tool_follow_latest_attribute(self):
        acc = MinuteAccumulator("haas-vf2-1")
        acc.attribute("ACTIVE", ts(0, 0), ts(0, 20), program="O1", tool_number=3)
        acc.attribute("ACTIVE", ts(0, 20), ts(0, 40), program="O2", tool_number=4)
        final = acc.close()
        assert final.program == "O2"
        assert final.tool_number == 4

    def test_program_preserved_across_minute_boundary(self):
        acc = MinuteAccumulator("haas-vf2-1")
        flushed = acc.attribute("ACTIVE", ts(0, 50), ts(1, 30), program="O9", tool_number=1)
        assert flushed[0].program == "O9"
        final = acc.close()
        assert final.program == "O9"

    def test_offline_seconds_tracked(self):
        acc = MinuteAccumulator("haas-vf2-1")
        acc.attribute("OFFLINE", ts(0, 0), ts(1, 0))
        # 60 seconds exactly lands on next minute boundary → should flush one minute
        final = acc.close()
        assert final is None  # already flushed

    def test_offline_seconds_flushed_at_boundary(self):
        acc = MinuteAccumulator("haas-vf2-1")
        flushed = acc.attribute("OFFLINE", ts(0, 0), ts(1, 0))
        assert len(flushed) == 1
        assert flushed[0].offline_seconds == 60
        assert flushed[0].minute_bucket == "2026-04-20T14:00:00Z"

    def test_interrupted_seconds_tracked(self):
        acc = MinuteAccumulator("haas-vf2-1")
        acc.attribute("INTERRUPTED", ts(0, 0), ts(0, 45))
        final = acc.close()
        assert final.interrupted_seconds == 45
