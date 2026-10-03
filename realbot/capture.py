"""Gets frames of the Minecraft window, the same pixels you see.

Wayland: the desktop's screen-sharing portal (the same thing OBS and Discord
use), so the desktop asks once which window to share. X11: mss. Files: for
testing and tuning on recorded frames.

Every source keeps only the newest frame; latest() returns (time_ms, frame)
with frame as a BGR numpy array, or (None, None) before the first one.
"""
import glob
import json
import os
import threading
import time

import numpy as np

CONFIG_DIR = os.path.expanduser('~/.config/mimic-pvp')


def now_ms():
    return time.monotonic() * 1000


class _Latest:
    def __init__(self):
        self._lock = threading.Lock()
        self._frame = None
        self._t = None
        self.count = 0

    def put(self, frame, t=None):
        with self._lock:
            self._frame = frame
            self._t = now_ms() if t is None else t
            self.count += 1

    def latest(self):
        with self._lock:
            return self._t, self._frame


class PortalCapture(_Latest):
    """xdg-desktop-portal ScreenCast -> PipeWire -> GStreamer appsink.
    Works on KDE, GNOME, Hyprland and wlroots desktops with their portal
    installed. The desktop's chooser opens the first time; the choice is
    remembered (restore token) so later runs start straight away."""

    TOKEN_FILE = os.path.join(CONFIG_DIR, 'portal-token.json')

    def __init__(self, monitor=False):
        super().__init__()
        import gi
        gi.require_version('Gst', '1.0')
        from gi.repository import Gio, GLib, Gst
        self.Gio, self.GLib, self.Gst = Gio, GLib, Gst
        Gst.init(None)
        self.monitor = monitor
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.sender = self.bus.get_unique_name()[1:].replace('.', '_')
        self._n = 0
        self.pipeline = None
        self._stop = False

    # -- portal plumbing

    def _request(self, method, args_fn):
        """Calls a portal method that answers through a Request object and
        waits for its Response signal."""
        GLib = self.GLib
        self._n += 1
        token = f'mimic{os.getpid()}_{self._n}'
        path = f'/org/freedesktop/portal/desktop/request/{self.sender}/{token}'
        loop = GLib.MainLoop()
        result = {}

        def on_response(_conn, _sender, _path, _iface, _signal, params):
            code, results = params.unpack()
            result['code'] = code
            result['results'] = results
            loop.quit()

        sub = self.bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request',
                                        'Response', path, None, self.Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)
        try:
            self.bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
                               'org.freedesktop.portal.ScreenCast', method, args_fn(token), None,
                               self.Gio.DBusCallFlags.NONE, -1, None)
            GLib.timeout_add_seconds(120, loop.quit)
            loop.run()
        finally:
            self.bus.signal_unsubscribe(sub)
        if result.get('code') != 0:
            raise RuntimeError(f'screen sharing {method} was cancelled or refused (code {result.get("code")})')
        return result['results']

    def _prop(self, name):
        v = self.bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
                               'org.freedesktop.DBus.Properties', 'Get',
                               self.GLib.Variant('(ss)', ('org.freedesktop.portal.ScreenCast', name)),
                               None, self.Gio.DBusCallFlags.NONE, -1, None)
        return v.unpack()[0]

    def start(self):
        GLib, Gio = self.GLib, self.Gio
        V = GLib.Variant
        res = self._request('CreateSession', lambda t: V('(a{sv})', ({
            'handle_token': V('s', t), 'session_handle_token': V('s', t + 's')},)))
        session = res['session_handle']

        types = 1 if self.monitor else 2  # 2 = a window
        try:
            if not (self._prop('AvailableSourceTypes') & types):
                types = 1
        except Exception:
            pass
        opts = {'types': V('u', types), 'multiple': V('b', False)}
        try:
            if self._prop('AvailableCursorModes') & 1:
                opts['cursor_mode'] = V('u', 1)  # hidden; MC hides it anyway
        except Exception:
            pass
        try:
            if self._prop('version') >= 4:
                opts['persist_mode'] = V('u', 2)
                tok = self._load_token()
                if tok:
                    opts['restore_token'] = V('s', tok)
        except Exception:
            pass
        self._request('SelectSources', lambda t: V('(oa{sv})', (session, dict(opts, handle_token=V('s', t)))))
        res = self._request('Start', lambda t: V('(osa{sv})', (session, '', {'handle_token': V('s', t)})))
        if res.get('restore_token'):
            self._save_token(res['restore_token'])
        node = res['streams'][0][0]

        reply, fds = self.bus.call_with_unix_fd_list_sync(
            'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.ScreenCast', 'OpenPipeWireRemote', V('(oa{sv})', (session, {})),
            GLib.VariantType('(h)'), Gio.DBusCallFlags.NONE, -1, None, None)
        fd = fds.get(reply.unpack()[0])

        Gst = self.Gst
        self.pipeline = Gst.parse_launch(
            f'pipewiresrc fd={fd} path={node} do-timestamp=true keepalive-time=1000 ! '
            'videoconvert ! video/x-raw,format=BGRx ! '
            'appsink name=sink max-buffers=1 drop=true sync=false emit-signals=false')
        self.sink = self.pipeline.get_by_name('sink')
        self.pipeline.set_state(Gst.State.PLAYING)
        threading.Thread(target=self._pull, daemon=True).start()
        return self

    def _pull(self):
        Gst = self.Gst
        while not self._stop:
            sample = self.sink.emit('try-pull-sample', 100 * Gst.MSECOND)
            if sample is None:
                continue
            t = now_ms()
            caps = sample.get_caps().get_structure(0)
            w, h = caps.get_value('width'), caps.get_value('height')
            buf = sample.get_buffer()
            ok, info = buf.map(Gst.MapFlags.READ)
            if not ok:
                continue
            try:
                stride = info.size // h
                arr = np.frombuffer(info.data, dtype=np.uint8, count=stride * h).reshape(h, stride)
                frame = arr[:, :w * 4].reshape(h, w, 4)[:, :, :3].copy()
            finally:
                buf.unmap(info)
            self.put(frame, t)

    def _load_token(self):
        try:
            with open(self.TOKEN_FILE) as f:
                return json.load(f).get('window' if not self.monitor else 'monitor')
        except Exception:
            return None

    def _save_token(self, tok):
        os.makedirs(CONFIG_DIR, exist_ok=True)
        data = {}
        try:
            with open(self.TOKEN_FILE) as f:
                data = json.load(f)
        except Exception:
            pass
        data['window' if not self.monitor else 'monitor'] = tok
        with open(self.TOKEN_FILE, 'w') as f:
            json.dump(data, f)

    def stop(self):
        self._stop = True
        if self.pipeline is not None:
            self.pipeline.set_state(self.Gst.State.NULL)


class MssCapture(_Latest):
    """X11: grabs a screen region (the whole monitor by default)."""

    def __init__(self, region=None, monitor=1, fps=120):
        super().__init__()
        self.region = region
        self.monitor = monitor
        self.interval = 1 / fps
        self._stop = False

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        return self

    def _run(self):
        import mss
        with mss.mss() as sct:
            area = self.region or sct.monitors[self.monitor]
            while not self._stop:
                t0 = time.monotonic()
                img = np.asarray(sct.grab(area))[:, :, :3].copy()
                self.put(img)
                time.sleep(max(0, self.interval - (time.monotonic() - t0)))

    def stop(self):
        self._stop = True


class FileCapture(_Latest):
    """Plays back image files (a folder from `realbot record`, or a glob)."""

    def __init__(self, pattern, fps=60, loop=True):
        super().__init__()
        import cv2
        files = sorted(glob.glob(os.path.join(pattern, '*.png')) if os.path.isdir(pattern) else glob.glob(pattern))
        if not files:
            raise FileNotFoundError(f'no frames match {pattern}')
        self.frames = [cv2.imread(f) for f in files]
        self.interval = 1 / fps
        self.loop = loop
        self._stop = False
        self.done = False

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        return self

    def _run(self):
        while not self._stop:
            for f in self.frames:
                if self._stop:
                    return
                self.put(f)
                time.sleep(self.interval)
            if not self.loop:
                self.done = True
                return

    def stop(self):
        self._stop = True


def open_capture(spec):
    """'auto' | 'portal' | 'portal-monitor' | 'x11' | a folder or glob of images."""
    if spec == 'auto':
        spec = 'portal' if os.environ.get('WAYLAND_DISPLAY') else 'x11'
    if spec == 'portal':
        return PortalCapture().start()
    if spec == 'portal-monitor':
        return PortalCapture(monitor=True).start()
    if spec == 'x11':
        return MssCapture().start()
    return FileCapture(spec).start()
