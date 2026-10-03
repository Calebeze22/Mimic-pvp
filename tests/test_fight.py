"""End to end: the real bot code, seeing only rendered frames and acting
only through keys and mouse counts, against a strafing opponent."""
import sim


def test_walks_up_and_fights():
    arena, brain = sim.fight('pro', seconds=20, seed=3)
    s = arena.stats
    print(s, brain.stat_line())
    assert s['close_at'] is not None and s['close_at'] < 4000, 'never walked up to the opponent'
    assert s['hits'] >= 12
    assert s['hits'] / s['clicks'] >= 0.6
    assert s['crits'] >= 1
    assert s['sprint_hits'] >= 1


def test_never_spam_clicks():
    arena, _ = sim.fight('pro', seconds=12, seed=5)
    gaps = [b - a for a, b in zip(arena.click_times, arena.click_times[1:])]
    assert gaps and min(gaps) > 300  # waits for the sword to recharge


def test_turns_around_when_hit_from_behind():
    arena, brain = sim.fight('good', seconds=6, seed=7, start_dist=2.5, start_off=170)
    assert arena.stats['hits'] >= 1
