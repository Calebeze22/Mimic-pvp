"""Presses keys and moves the mouse through Linux virtual input devices
(uinput). To the desktop and to Minecraft these are an ordinary USB
keyboard and mouse: the game is untouched and only ever sees key presses
and mouse movement.

Needs write access to /dev/uinput (see realbot/setup-arch.sh).
"""
import heapq
import itertools

from .util import clamp

MOVE_ACTIONS = ('forward', 'back', 'left', 'right', 'jump', 'sprint')


class VirtualInput:
    """A virtual keyboard plus a virtual mouse."""

    def __init__(self, name='Mimic'):
        from evdev import UInput, ecodes as e
        self.e = e
        keys = [c for n, c in e.ecodes.items() if n.startswith('KEY_') and isinstance(c, int) and c < 0x100]
        self.kbd = UInput({e.EV_KEY: sorted(set(keys))}, name=f'{name} keyboard')
        self.mouse = UInput({e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE, e.BTN_SIDE, e.BTN_EXTRA],
                             e.EV_REL: [e.REL_X, e.REL_Y, e.REL_WHEEL]}, name=f'{name} mouse')
        self.names = (f'{name} keyboard', f'{name} mouse')

    def key(self, code_name, down):
        code = self.e.ecodes[code_name]
        dev = self.mouse if code_name.startswith('BTN_') else self.kbd
        dev.write(self.e.EV_KEY, code, 1 if down else 0)
        dev.syn()

    def move(self, dx, dy):
        if dx:
            self.mouse.write(self.e.EV_REL, self.e.REL_X, int(dx))
        if dy:
            self.mouse.write(self.e.EV_REL, self.e.REL_Y, int(dy))
        if dx or dy:
            self.mouse.syn()

    def close(self):
        self.kbd.close()
        self.mouse.close()


class Keys:
    """The brain says which keys it wants held; each change reaches the
    keyboard a human motor delay later. Clicks are a press and a release a
    few dozen ms apart, like a finger.

    Times are in ms (any monotonic clock); call update(now) every loop."""

    def __init__(self, out, settings, cfg, rand):
        self.out = out
        self.codes = dict(settings.keys)
        self.cfg = cfg
        self.rand = rand
        self.down = {}  # action -> held right now (what the game sees)
        self.since = {}  # action -> time of the last real change
        self.wanted = {}
        self._queue = []  # (at, seq, action, state)
        self._seq = itertools.count()
        self.now = 0.0
        self.clicks = 0

    def _delay(self, mean=None, sd=None):
        m = self.cfg['delay_ms'] if mean is None else mean
        s = self.cfg['delay_sd_ms'] if sd is None else sd
        return clamp(self.rand.lognormal(m, s), m * 0.35, m * 4)

    def want(self, action, state, delay=None):
        """Hold (True) or release (False) a key after a motor delay."""
        if self.wanted.get(action, False) == state:
            return
        self.wanted[action] = state
        at = self.now + (self._delay() if delay is None else delay)
        heapq.heappush(self._queue, (at, next(self._seq), action, state))

    def tap(self, action, hold_ms=None, delay=None):
        """Press and release once (jump, a hotbar key)."""
        at = self.now + (self._delay() if delay is None else delay)
        hold = hold_ms if hold_ms is not None else clamp(self.rand.lognormal(85, 25), 45, 180)
        heapq.heappush(self._queue, (at, next(self._seq), action, True))
        heapq.heappush(self._queue, (at + hold, next(self._seq), action, False))
        return at

    def click(self, delay=0.0):
        """Left click. Returns when the press lands."""
        self.clicks += 1
        return self.tap('attack', hold_ms=clamp(self.rand.lognormal(70, 22), 35, 140), delay=delay)

    def update(self, now):
        self.now = now
        while self._queue and self._queue[0][0] <= now:
            at, _, action, state = heapq.heappop(self._queue)
            self._set(action, state, at)

    def _set(self, action, state, at):
        if self.down.get(action, False) == state:
            return
        code = self.codes.get(action)
        if code is None:
            return
        self.out.key(code, state)
        self.down[action] = state
        self.since[action] = at

    def is_down(self, action):
        return self.down.get(action, False)

    def held_for(self, action, now):
        """ms the key has been in its current state."""
        return now - self.since.get(action, -1e9)

    def pending(self, action):
        return any(a == action for _, _, a, _ in self._queue)

    def release_all(self):
        self._queue.clear()
        self.wanted.clear()
        for action, held in list(self.down.items()):
            if held:
                self._set(action, False, self.now)


class Mouse:
    """Sends whole mouse counts, carrying the fraction over so nothing is
    lost or invented."""

    def __init__(self, out):
        self.out = out
        self.total_x = 0
        self.total_y = 0

    def move(self, dx, dy):
        dx, dy = int(dx), int(dy)
        if dx or dy:
            self.out.move(dx, dy)
            self.total_x += dx
            self.total_y += dy
