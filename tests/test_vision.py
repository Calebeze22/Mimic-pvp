import math

import pytest

from realbot import vision
import sim


@pytest.mark.parametrize('dist', [2.5, 3.0, 4.0, 6.0, 10.0])
@pytest.mark.parametrize('yaw', [-20.0, 0.0, 15.0])
def test_finds_opponent_and_distance(dist, yaw):
    f = sim.render(yaw, dist)
    det = vision.detect_player(f, sim.GUI)
    assert det is not None
    est = vision.estimate_distance(det, sim.FOCAL)
    assert abs(est - dist) / dist < 0.12, (est, dist)
    ang, _ = vision.angles_to(det.cx, 0, sim.W, sim.H, sim.FOCAL)
    assert abs(ang - yaw) < 1.0


def test_close_up_is_clipped_and_still_ranged():
    f = sim.render(0.0, 1.2, view_pitch=-10)
    det = vision.detect_player(f, sim.GUI)
    assert det is not None and det.clipped
    assert vision.estimate_distance(det, sim.FOCAL) < 2.0


def test_ignores_own_sword_and_sky():
    assert vision.detect_player(sim.render(), sim.GUI) is None
    assert vision.detect_player(sim.render(view_pitch=-40), sim.GUI) is None


def test_crosshair_on_target():
    det = vision.detect_player(sim.render(0.5, 3.0, view_pitch=15), sim.GUI)
    assert det.contains(sim.W / 2, sim.H / 2)
    det = vision.detect_player(sim.render(20, 3.0, view_pitch=15), sim.GUI)
    assert not det.contains(sim.W / 2, sim.H / 2)


@pytest.mark.parametrize('hp', [20, 13, 6, 1])
def test_reads_hearts(hp):
    assert vision.read_health(sim.render(health=hp), sim.GUI) == hp


def test_large_frames_scale_back():
    import cv2
    f = cv2.resize(sim.render(10.0, 4.0), (1920, 1080), interpolation=cv2.INTER_NEAREST)
    det = vision.detect_player(f, sim.GUI * 2)
    est = vision.estimate_distance(det, sim.FOCAL * 2)
    assert abs(est - 4.0) < 0.5
