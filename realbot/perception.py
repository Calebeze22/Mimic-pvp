"""What a human "sees": the opponent where they were one reaction time ago,
pushed forward by an imperfect guess of their motion. The point on the body
they aim at wanders slowly instead of locking onto one pixel.

Observations come from screen detections converted to the bot's own angle
frame (view angles when the frame was drawn + offset on screen).
"""
from collections import deque
from dataclasses import dataclass
import math

from .util import OU, clamp
from .vision import estimate_distance


@dataclass
class Obs:
    t: float
    yaw: float  # body center, bot frame, degrees
    pitch_top: float  # top of the helmet
    pitch_bot: float  # bottom of the boots (or the lowest visible part)
    half_w: float  # angular half width, degrees
    dist: float  # blocks, camera to body


@dataclass
class Seen:
    yaw: float
    pitch: float  # the aim point
    rate_yaw: float  # deg/s
    rate_pitch: float
    dist: float
    dist_rate: float  # blocks/s, + = moving away
    half_w: float
    age: float  # ms since this was actually on screen


class Perception:
    LOST_MS = 300  # not on screen this long = gone

    def __init__(self, cfg, rand, display_latency_ms=35):
        self.cfg = cfg
        self.rand = rand
        self.latency = display_latency_ms
        self.hist = deque(maxlen=240)
        self.off_y = OU(rand, 1.5, cfg['wander'])
        self.off_x = OU(rand, 1.5, cfg['wander'])
        self.reaction = cfg['reaction_ms']
        self.track_delay = cfg['track_ms']
        self.last_seen = None  # last Obs

    def refresh_reaction(self):
        """A fresh reaction time each time attention moves to something new."""
        r = self.cfg
        self.reaction = clamp(self.rand.lognormal(r['reaction_ms'], r['reaction_sd_ms']),
                              r['reaction_ms'] * 0.6, r['reaction_ms'] * 2.5)
        self.track_delay = self.reaction * r['track_ms'] / r['reaction_ms']

    def add(self, t_frame, det, view_yaw, view_pitch, width, height, focal):
        """A detection from a frame captured at t_frame, with the view angles
        the game had when it drew that frame."""
        if det is None:
            return None
        def ang(px, center):
            return math.degrees(math.atan((px - center) / focal))
        dist = estimate_distance(det, focal) or 3.0
        o = Obs(t=t_frame, yaw=view_yaw + ang(det.cx, width / 2),
                pitch_top=view_pitch + ang(det.y0, height / 2), pitch_bot=view_pitch + ang(det.y1, height / 2),
                half_w=math.degrees(math.atan(det.w / 2 / focal)), dist=dist)
        if det.clipped:
            # Bottom is cut off by the HUD or the screen edge: the body is
            # PLAYER_HEIGHT tall, so place the feet from the distance.
            full = math.degrees(math.atan2(1.85, dist))
            o.pitch_bot = max(o.pitch_bot, o.pitch_top + full)
        self.hist.append(o)
        self.last_seen = o
        return o

    def _at(self, t):
        h = self.hist
        if not h:
            return None
        if t <= h[0].t:
            return h[0]
        for i in range(len(h) - 1, 0, -1):
            a, b = h[i - 1], h[i]
            if a.t <= t <= b.t:
                f = (t - a.t) / max(1.0, b.t - a.t)
                mix = lambda x, y: x + (y - x) * f
                return Obs(t, mix(a.yaw, b.yaw), mix(a.pitch_top, b.pitch_top), mix(a.pitch_bot, b.pitch_bot),
                           mix(a.half_w, b.half_w), mix(a.dist, b.dist))
        return h[-1]

    def visible(self, now):
        return self.last_seen is not None and now - self.last_seen.t <= self.LOST_MS

    def perceive(self, now, dt):
        """The target as the bot's "brain" has it now, or None if lost.
        Following a target already in view uses the shorter visual-feedback
        delay of continuous tracking; reacting to something new (a new
        target) takes the full reaction time, handled by the brain."""
        if not self.visible(now):
            return None
        t_seen = min(now - self.track_delay, self.last_seen.t)
        o = self._at(t_seen)
        w = 150
        a = self._at(t_seen - w)
        span = max(1.0, o.t - a.t) / 1000
        r_yaw = (o.yaw - a.yaw) / span
        r_pitch = ((o.pitch_top + o.pitch_bot) - (a.pitch_top + a.pitch_bot)) / 2 / span
        d_rate = (o.dist - a.dist) / span
        # Humans extrapolate, but only partly.
        lead = (now - o.t) / 1000 * self.cfg['prediction']
        yaw = o.yaw + r_yaw * lead
        top = o.pitch_top + r_pitch * lead
        bot = o.pitch_bot + r_pitch * lead
        frac = clamp(self.cfg['aim_height'] + self.off_y.step(dt), 0.15, 0.95)  # up from the feet
        pitch = bot + (top - bot) * frac
        yaw += clamp(self.off_x.step(dt), -0.8, 0.8) * o.half_w
        return Seen(yaw, pitch, r_yaw, r_pitch, max(0.3, o.dist + d_rate * lead), d_rate, o.half_w,
                    now - self.last_seen.t)

    def reset(self):
        self.hist.clear()
        self.last_seen = None
