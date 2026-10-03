#!/usr/bin/env python3
# Linux input for real-client mode. Creates a virtual keyboard and mouse with
# the kernel's uinput (the same layer a USB keyboard and mouse use), so it
# works under any Wayland compositor or X11. Also watches the real keyboards
# for F8, which hands the game to the bot and pauses it.
#
# Commands on stdin, one per line:
#   m <dx> <dy>      move the mouse
#   k <code> <0|1>   key up/down (Linux key code)
#   b <0|1>          left mouse button up/down
# Prints "ready <n>" once (n = keyboards watched for F8), then "f8" per press.

import os
import select
import sys

try:
    from evdev import InputDevice, UInput, ecodes as e, list_devices
except ImportError:
    print('error python-evdev is missing: sudo pacman -S python-evdev', flush=True)
    sys.exit(1)

NAME = 'mimic-virtual'
try:
    kb = UInput({e.EV_KEY: list(range(1, 128))}, name=NAME + '-keyboard')
    mouse = UInput({e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT], e.EV_REL: [e.REL_X, e.REL_Y]}, name=NAME + '-mouse')
except Exception as ex:  # noqa: BLE001
    print('error cannot open /dev/uinput (%s). See "Laptop setup" in the README.' % ex, flush=True)
    sys.exit(1)

watched = {}
for path in list_devices():
    try:
        d = InputDevice(path)
        if d.name.startswith(NAME):
            continue
        if e.KEY_F8 in d.capabilities().get(e.EV_KEY, []):
            watched[d.fd] = d
    except OSError:
        pass
print('ready %d' % len(watched), flush=True)

stdin = sys.stdin.fileno()
buf = b''
while True:
    ready, _, _ = select.select([stdin] + list(watched), [], [])
    for fd in ready:
        if fd == stdin:
            chunk = os.read(stdin, 65536)
            if not chunk:
                sys.exit(0)
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                p = line.split()
                if not p:
                    continue
                if p[0] == b'm':
                    mouse.write(e.EV_REL, e.REL_X, int(p[1]))
                    mouse.write(e.EV_REL, e.REL_Y, int(p[2]))
                    mouse.syn()
                elif p[0] == b'k':
                    kb.write(e.EV_KEY, int(p[1]), int(p[2]))
                    kb.syn()
                elif p[0] == b'b':
                    mouse.write(e.EV_KEY, e.BTN_LEFT, int(p[1]))
                    mouse.syn()
        else:
            try:
                for ev in watched[fd].read():
                    if ev.type == e.EV_KEY and ev.code == e.KEY_F8 and ev.value == 1:
                        print('f8', flush=True)
            except OSError:
                del watched[fd]
