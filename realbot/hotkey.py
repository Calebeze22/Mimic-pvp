"""F8 pauses/resumes, F9 quits. Read straight from the physical keyboards,
so they work while Minecraft has focus (and the game never sees them as
anything but an unbound F-key)."""
import select
import threading


class Hotkeys:
    def __init__(self, ignore_names=()):
        self.paused = True
        self.quit = False
        self.toggles = 0
        self._ignore = set(ignore_names)
        self._devs = []
        try:
            import evdev
            self.e = evdev.ecodes
            for path in evdev.list_devices():
                try:
                    d = evdev.InputDevice(path)
                except OSError:
                    continue
                keys = d.capabilities().get(self.e.EV_KEY, [])
                if d.name in self._ignore or self.e.KEY_F8 not in keys:
                    d.close()
                    continue
                self._devs.append(d)
        except ImportError:
            pass
        if self._devs:
            threading.Thread(target=self._run, daemon=True).start()

    @property
    def available(self):
        return bool(self._devs)

    def _run(self):
        fds = {d.fd: d for d in self._devs}
        while not self.quit:
            r, _, _ = select.select(list(fds), [], [], 0.25)
            for fd in r:
                try:
                    events = list(fds[fd].read())
                except OSError:
                    continue
                for ev in events:
                    if ev.type != self.e.EV_KEY or ev.value != 1:
                        continue
                    if ev.code == self.e.KEY_F8:
                        self.paused = not self.paused
                        self.toggles += 1
                    elif ev.code == self.e.KEY_F9:
                        self.quit = True
