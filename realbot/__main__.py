"""Mimic PvP, real-client bot.

    python -m realbot check                 settings, input access, screen capture
    python -m realbot calibrate             measure how far one mouse count turns
    python -m realbot detect [--save DIR]   show what it sees, no input
    python -m realbot record --seconds 20   save frames for tuning
    python -m realbot run [--profile pro]   fight (starts paused: F8 go/pause, F9 quit)
"""
import argparse
import json
import math
import os
import sys
import time

import cv2

from . import vision
from .aim import Aim
from .brain import Brain, FrameInfo
from .capture import CONFIG_DIR, now_ms, open_capture
from .config import GameSettings, profile
from .perception import Perception
from .util import Rand

CALIBRATION = os.path.join(CONFIG_DIR, 'calibration.json')


def load_calibration():
    try:
        with open(CALIBRATION) as f:
            return json.load(f).get('deg_per_count')
    except Exception:
        return None


def wait_frame(cap, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        t, f = cap.latest()
        if f is not None:
            return t, f
        time.sleep(0.02)
    raise SystemExit('No frames from screen capture. Is Minecraft open and did you pick its window?')


class Eyes:
    """Turns a frame into what the brain gets."""

    def __init__(self, settings):
        self.settings = settings

    def look(self, t, frame):
        h, w = frame.shape[:2]
        gui = self.settings.effective_gui_scale(w, h)
        det = vision.detect_player(frame, gui)
        hp = vision.read_health(frame, gui)
        on = bool(det and det.contains(w / 2, h / 2))
        return det, FrameInfo(t=t, visible=det is not None, on_target=on, health=hp if hp > 0 else -1)


# ---------------------------------------------------------------- commands

def cmd_check(args):
    s = GameSettings.load(args.options)
    print(f'options.txt: {args.options or "~/.minecraft/options.txt"}')
    print(f'  sensitivity {s.sensitivity:.3f} -> {s.degrees_per_count():.4f} deg per mouse count, FOV {s.fov:.0f}')
    cal = load_calibration()
    if cal:
        print(f'  calibrated: {cal:.4f} deg per count')
    for p in s.problems() or ['settings look right']:
        print('  ' + p)
    try:
        from .inputdev import VirtualInput
        VirtualInput().close()
        print('virtual keyboard/mouse: ok')
    except Exception as e:
        print(f'virtual keyboard/mouse: FAILED ({e}). Run realbot/setup-arch.sh and log out and back in.')
    from .hotkey import Hotkeys
    print('F8/F9 hotkeys: ' + ('ok' if Hotkeys().available else 'no keyboard access (same fix as above)'))
    cap = open_capture(args.capture)
    t, f = wait_frame(cap)
    print(f'screen capture: ok, {f.shape[1]}x{f.shape[0]}')
    cap.stop()


def cmd_detect(args):
    s = GameSettings.load(args.options)
    eyes = Eyes(s)
    cap = open_capture(args.capture)
    wait_frame(cap)
    if args.save:
        os.makedirs(args.save, exist_ok=True)
    last, n, shown = None, 0, time.monotonic()
    try:
        while True:
            t, f = cap.latest()
            if t == last:
                time.sleep(0.002)
                continue
            last = t
            n += 1
            det, info = eyes.look(t, f)
            if time.monotonic() - shown >= 0.5:
                fps = n / (time.monotonic() - shown)
                n, shown = 0, time.monotonic()
                focal = s.focal_px(f.shape[0])
                if det:
                    d = vision.estimate_distance(det, focal)
                    yaw, pitch = vision.angles_to(det.cx, (det.y0 + det.y1) / 2, f.shape[1], f.shape[0], focal)
                    what = f'opponent {d:.1f} blocks, {yaw:+.1f} deg, box {det.w}x{det.h}{" clipped" if det.clipped else ""}' \
                           f'{" ON TARGET" if info.on_target else ""}'
                else:
                    what = 'no opponent'
                print(f'{fps:5.1f} fps  hp {info.health:>2}  {what}', flush=True)
                if args.save:
                    out = f.copy()
                    if det:
                        cv2.rectangle(out, (det.x0, det.y0), (det.x1, det.y1), (0, 0, 255), 2)
                    cv2.imwrite(os.path.join(args.save, f'{int(t)}.png'), out)
            if getattr(cap, 'done', False):
                break
    except KeyboardInterrupt:
        pass
    cap.stop()


def cmd_record(args):
    cap = open_capture(args.capture)
    wait_frame(cap)
    os.makedirs(args.out, exist_ok=True)
    end = time.monotonic() + args.seconds
    last, n = None, 0
    while time.monotonic() < end:
        t, f = cap.latest()
        if t != last:
            last = t
            cv2.imwrite(os.path.join(args.out, f'{n:05d}.png'), f)
            n += 1
        time.sleep(1 / args.fps)
    cap.stop()
    print(f'saved {n} frames to {args.out}')


def measure_turn(before, after, focal):
    """Degrees the view turned right between two frames (center crop)."""
    h, w = before.shape[:2]
    cy, cx, r = h // 2, w // 2, min(h, w) // 4
    a = cv2.cvtColor(before[cy - r:cy + r, cx - r:cx + r], cv2.COLOR_BGR2GRAY).astype('float32')
    b = cv2.cvtColor(after[cy - r:cy + r, cx - r:cx + r], cv2.COLOR_BGR2GRAY).astype('float32')
    win = cv2.createHanningWindow(a.shape[::-1], cv2.CV_32F)
    (dx, _dy), resp = cv2.phaseCorrelate(a, b, win)
    return math.degrees(math.atan(-dx / focal)), resp


def cmd_calibrate(args):
    from .inputdev import VirtualInput
    s = GameSettings.load(args.options)
    cap = open_capture(args.capture)
    wait_frame(cap)
    out = VirtualInput()
    print('Stand in game facing something with detail (blocks, not sky), click into Minecraft,')
    print('and keep your hands off the mouse. Starting in 5 seconds...')
    time.sleep(5)
    expected = s.degrees_per_count()
    counts = max(10, int(round(4.0 / expected)))  # about a 4 degree turn
    results = []
    for i in range(8):
        sign = 1 if i % 2 == 0 else -1
        time.sleep(0.25)
        _, a = cap.latest()
        for _ in range(counts // 5):  # in small steps like a real mouse
            out.move(5 * sign, 0)
            time.sleep(0.004)
        out.move((counts % 5) * sign, 0)
        time.sleep(0.25)
        _, b = cap.latest()
        deg, resp = measure_turn(a, b, s.focal_px(a.shape[0]))
        if resp > 0.1:
            results.append(abs(deg) / counts)
    out.close()
    cap.stop()
    if len(results) < 4:
        raise SystemExit('Could not measure the turn. Face a detailed wall a few blocks away and try again.')
    results.sort()
    dpc = results[len(results) // 2]
    print(f'measured {dpc:.5f} deg per count (settings say {expected:.5f}, ratio {dpc / expected:.3f})')
    if abs(dpc / expected - 1) > 0.15:
        print('That is far from what the settings say. Check Raw Input is ON and your desktop has no mouse acceleration for it.')
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CALIBRATION, 'w') as f:
        json.dump({'deg_per_count': dpc, 'sensitivity': s.sensitivity}, f)
    print(f'saved to {CALIBRATION}')


def cmd_run(args):
    from .hotkey import Hotkeys
    from .inputdev import Keys, VirtualInput

    s = GameSettings.load(args.options)
    for p in s.problems():
        print('warning: ' + p)
    cfg = profile(args.profile)
    rand = Rand(args.seed)
    dpc = load_calibration() or s.degrees_per_count()
    cap = open_capture(args.capture)
    wait_frame(cap)
    out = VirtualInput()
    hot = Hotkeys(ignore_names=out.names)
    keys = Keys(out, s, cfg['keys'], rand)
    aim = Aim(cfg['aim'], dpc, rand)
    perc = Perception(cfg['perception'], rand, args.latency)
    brain = Brain(cfg, keys, aim, perc, rand)
    eyes = Eyes(s)
    if not hot.available:
        print('No access to the physical keyboard, so F8/F9 will not work: it starts in 5 s, Ctrl+C here stops it.')
        time.sleep(5)
        hot.paused = False
    else:
        print('Paused. Click into Minecraft and press F8 to start. F8 pauses, F9 quits.')

    running = False
    last_t, prev, report = None, now_ms(), now_ms()
    try:
        while not hot.quit:
            loop_start = now_ms()
            now = loop_start
            dt = min(0.05, max(0.001, (now - prev) / 1000))
            prev = now
            if hot.paused:
                if running:
                    brain.reset(now)
                    running = False
                    print('paused', flush=True)
                time.sleep(0.05)
                continue
            if not running:
                brain.reset(now)
                running = True
                print(f'fighting ({args.profile})', flush=True)

            t, frame = cap.latest()
            if t != last_t and frame is not None:
                last_t = t
                det, info = eyes.look(t, frame)
                h, w = frame.shape[:2]
                vy, vp = aim.view_at(t - args.latency)
                perc.add(t, det, vy, vp, w, h, s.focal_px(h))
                brain.see(info)

            brain.update(now, dt)
            desired, rate, lazy = brain.look
            dx, dy = aim.tick(now, dt, desired, rate, lazy)
            out.move(dx, dy)

            if now - report > 10000:
                report = now
                print(f'[{args.profile}] {brain.stat_line()}  hp {brain.health}', flush=True)
            spare = 4 - (now_ms() - loop_start)
            if spare > 0:
                time.sleep(spare / 1000)
    except KeyboardInterrupt:
        pass
    finally:
        keys.release_all()
        out.close()
        cap.stop()
        print(brain.stat_line())


def main(argv=None):
    ap = argparse.ArgumentParser(prog='python -m realbot', description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--options', help='path to the bot account\'s options.txt (default ~/.minecraft/options.txt)')
    ap.add_argument('--capture', default='auto', help='auto, portal, portal-monitor, x11, or a folder of frames')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('check')
    sub.add_parser('calibrate')
    d = sub.add_parser('detect')
    d.add_argument('--save', help='save an annotated frame twice a second to this folder')
    r = sub.add_parser('record')
    r.add_argument('--seconds', type=float, default=20)
    r.add_argument('--fps', type=float, default=20)
    r.add_argument('--out', default='frames')
    run = sub.add_parser('run')
    run.add_argument('--profile', default='pro', choices=['casual', 'good', 'pro'])
    run.add_argument('--latency', type=float, default=35, help='ms from a mouse move to it showing on screen')
    run.add_argument('--seed', type=int)
    args = ap.parse_args(argv)
    {'check': cmd_check, 'calibrate': cmd_calibrate, 'detect': cmd_detect, 'record': cmd_record, 'run': cmd_run}[args.cmd](args)


if __name__ == '__main__':
    sys.exit(main())
