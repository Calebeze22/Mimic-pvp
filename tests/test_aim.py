from realbot.aim import Aim
from realbot.config import profile
from realbot.util import Rand

DPC = 0.15


def run(cfg, target, ms, rate=(0.0, 0.0), seed=1):
    a = Aim(cfg, DPC, Rand(seed))
    path, moves = [], []
    t = 0.0
    while t < ms:
        dx, dy = a.tick(t, 0.004, target, rate)
        moves.append((dx, dy))
        path.append(a.view_yaw)
        t += 4
    return a, path, moves


def test_flick_settles_with_small_overshoot():
    cfg = profile('pro')['aim']
    cfg['tremor_deg'] = 0
    a, path, moves = run(cfg, (40.0, 0.0), 600)
    assert abs(path[-1] - 40) < 1.0
    assert max(path) < 40 * 1.15  # a little overshoot, like a wrist
    assert max(path) > 40  # but some
    assert all(isinstance(dx, int) for dx, _ in moves)


def test_speed_is_capped():
    cfg = profile('casual')['aim']
    a, path, _ = run(cfg, (170.0, 0.0), 400)
    steps = [(b - a_) / 0.004 for a_, b in zip(path, path[1:])]
    assert max(steps) <= cfg['max_speed_deg'] * 1.1


def test_counts_add_up_to_view():
    cfg = profile('good')['aim']
    a, path, moves = run(cfg, (-25.0, 12.0), 500)
    assert sum(dx for dx, _ in moves) * DPC == a.view_yaw
    assert abs(a.view_pitch - 12) < 1.5


def test_view_history():
    cfg = profile('good')['aim']
    a, _, _ = run(cfg, (30.0, 0.0), 300)
    early, _ = a.view_at(40)
    assert early < a.view_yaw
