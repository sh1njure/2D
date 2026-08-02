"""
Tests for the parse logic that would silently lose data or misreport a match if
wrong — the brief mandates tests here. These cover the pure logic (no 332 MB
demo needed in CI): round segmentation, warmup/truncation handling, buy-type
classification, header validation, and steamid/coordinate normalization.
"""

import os
import sys

import pytest

# scripts/ is a standalone Phase-1 entrypoint, not an installed package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import parse_demo as pd  # noqa: E402


# --- round segmentation: the highest-risk logic --------------------------------
def test_pair_rounds_basic():
    # three clean rounds, each freeze-end followed by an official end.
    fe = [1000, 2000, 3000]
    oe = [1500, 2500, 3500]
    starts = [900, 1900, 2900]
    windows, warnings = pd.pair_rounds(fe, oe, starts)
    assert [w["end"] for w in windows] == [1500, 2500, 3500]
    assert [w["start"] for w in windows] == [900, 1900, 2900]
    assert warnings == []


def test_pair_rounds_drops_truncated_trailing_round_with_warning():
    # last freeze-end has no official end after it -> dropped, warned, not lost.
    fe = [1000, 2000, 3000]
    oe = [1500, 2500]  # round 3 never officially ended (demo cut)
    windows, warnings = pd.pair_rounds(fe, oe, starts_all=[])
    assert len(windows) == 2
    assert len(warnings) == 1
    assert "3000" in warnings[0]
    assert "truncated" in warnings[0].lower()


def test_pair_rounds_dedupes_two_freeze_ends_to_one_end():
    # noisy demo: two freeze-ends before a single official end.
    fe = [1000, 1100, 2000]
    oe = [1500, 2500]
    windows, _ = pd.pair_rounds(fe, oe, starts_all=[])
    # 1000 -> 1500; 1100 would also map to 1500 but that end is taken -> dropped;
    # 2000 -> 2500.
    assert [w["end"] for w in windows] == [1500, 2500]


def test_warmup_is_excluded_by_input_filtering():
    # The caller filters freeze/official ends to > match_start_tick. Simulate a
    # knife round at tick 500 before match start 3429: it must not appear.
    match_start = 3429
    raw_fe = [500, 5000, 6000]
    raw_oe = [800, 5500, 6500]
    fe = [t for t in raw_fe if t > match_start]
    oe = [t for t in raw_oe if t > match_start]
    windows, _ = pd.pair_rounds(fe, oe, starts_all=[])
    assert all(w["freeze_end"] > match_start for w in windows)
    assert len(windows) == 2  # the knife round is gone


# --- buy-type classification ---------------------------------------------------
@pytest.mark.parametrize(
    "values,is_pistol,expected",
    [
        ([0, 0, 0, 0, 0], True, "pistol"),
        ([200, 200, 650, 200, 200], False, "eco"),        # avg 290
        ([3000, 3000, 3000, 3000, 3000], False, "force"), # avg 3000
        ([5000, 5000, 4500, 4800, 5200], False, "full"),  # avg ~4900
        ([], False, "unknown"),
    ],
)
def test_buy_type(values, is_pistol, expected):
    assert pd._buy_type(values, is_pistol) == expected


# --- round-end reason mapping (verified values) --------------------------------
def test_round_end_reasons_map_to_readable_labels():
    assert pd.ROUND_END_REASON[1] == "bomb_exploded"
    assert pd.ROUND_END_REASON[7] == "bomb_defused"
    assert pd.ROUND_END_REASON[8] == "ct_elimination"
    assert pd.ROUND_END_REASON[9] == "t_elimination"


# --- header validation: corrupt / truncated / missing must fail cleanly --------
def test_validate_rejects_non_cs2_header(tmp_path):
    f = tmp_path / "old.dem"
    f.write_bytes(b"HL2DEMO\x00" + b"\x00" * 2000)  # CS:GO-era magic
    with pytest.raises(pd.DemoError, match="PBDEMS2"):
        pd._validate_file(str(f))


def test_validate_rejects_tiny_file(tmp_path):
    f = tmp_path / "tiny.dem"
    f.write_bytes(b"PBDEMS2\x00")  # valid magic but far too small
    with pytest.raises(pd.DemoError, match="too small"):
        pd._validate_file(str(f))


def test_validate_rejects_missing_file():
    with pytest.raises(pd.DemoError, match="not found"):
        pd._validate_file("/no/such/file.dem")


def test_validate_accepts_good_header(tmp_path):
    f = tmp_path / "ok.dem"
    f.write_bytes(b"PBDEMS2\x00" + b"\x00" * 5000)
    assert pd._validate_file(str(f)) == 5008


# --- steamid / coordinate normalization ---------------------------------------
def test_sid_normalizes_empty_and_world():
    assert pd._sid(None) is None
    assert pd._sid("0") is None       # world/suicide, not a real player
    assert pd._sid(float("nan")) is None
    assert pd._sid("76561198000000000") == "76561198000000000"


def test_num_handles_nan_and_rounds():
    assert pd._num(float("nan")) is None
    assert pd._num(None) is None
    assert pd._num(123.456) == 123.5


def test_side_name():
    assert pd._side_name(pd.TEAM_T) == "T"
    assert pd._side_name(pd.TEAM_CT) == "CT"
    assert pd._side_name(0) == "?"
