"""The hand on the mouse.

A spring-damper pulls the crosshair toward where the bot wants to look,
damped below critical so big flicks overshoot a little and settle, like a
wrist. Speed and acceleration are capped at human limits, smooth noise adds
tremor, and the pull goes lazy once the crosshair is already on the target
(people stop correcting when they're "on").

Angles are degrees in the bot's own frame: yaw is the sum of every mouse
count it has sent times degrees-per-count, so it needs no game data. Output
is whole mouse counts; fractions carry over to the next move.
"""
from collections import deque

from .util import OU, clamp


class Aim:
    def __init__(self, cfg, deg_per_count, rand):
        self.cfg = cfg
        self.dpc = deg_per_count
        self.rand = rand
        self.tremor_yaw = OU(rand, 8, cfg['tremor_deg'])
        self.tremor_pitch = OU(rand, 8, cfg['tremor_deg'] * 0.7)
        self.count_x = 0  # counts sent so far
        self.count_y = 0
        self.yaw = 0.0  # where the hand is (continuous)
        self.pitch = 0.0
        self.v_yaw = 0.0
        self.v_pitch = 0.0
        self.history = deque(maxlen=512)  # (t_ms, view_yaw, view_pitch)

    @property
    def view_yaw(self):
        """Where the game is looking, from the counts actually sent."""
        return self.count_x * self.dpc

    @property
    def view_pitch(self):
        return self.count_y * self.dpc

    def view_at(self, t):
        """View angles at an earlier time (the moment a frame was drawn)."""
        best = None
        for ht, y, p in reversed(self.history):
            if ht <= t:
                return y, p
            best = (y, p)
        return best if best else (self.view_yaw, self.view_pitch)

    def settle(self):
        """Stop the hand where the view is (after a pause or a teleport)."""
        self.yaw, self.pitch = self.view_yaw, self.view_pitch
        self.v_yaw = self.v_pitch = 0.0

    def tick(self, now, dt, desired, rate=(0.0, 0.0), lazy_r=0.0):
        """desired: (yaw, pitch) to look at. rate: the target's angular
        velocity (deg/s), partly matched when tracking. lazy_r: the target's
        angular half-size; inside it the hand relaxes.
        Returns (dx, dy) mouse counts to send now."""
        c = self.cfg
        sub = max(1, int(dt / 0.004))
        h = dt / sub
        max_v = c['max_speed_deg']
        max_a = c['max_accel_deg']
        for _ in range(sub):
            self.v_yaw = self._axis(h, desired[0] - self.yaw, self.v_yaw, rate[0], c['freq'], lazy_r, max_a, max_v)
            self.v_pitch = self._axis(h, desired[1] - self.pitch, self.v_pitch, rate[1],
                                      c['freq'] * c['pitch_scale'], lazy_r, max_a, max_v)
            self.yaw += self.v_yaw * h
            self.pitch += self.v_pitch * h
        self.yaw += self.tremor_yaw.step(dt) * dt
        self.pitch += self.tremor_pitch.step(dt) * dt
        self.pitch = clamp(self.pitch, -89.0, 89.0)

        dx = round((self.yaw - self.view_yaw) / self.dpc)
        dy = round((self.pitch - self.view_pitch) / self.dpc)
        self.count_x += dx
        self.count_y += dy
        self.history.append((now, self.view_yaw, self.view_pitch))
        return dx, dy

    def _axis(self, h, err, v, ff, freq, lazy_r, max_a, max_v):
        k = freq * freq
        if lazy_r > 0:
            x = clamp(abs(err) / lazy_r, 0, 1)
            k *= self.cfg['lazy_floor'] + (1 - self.cfg['lazy_floor']) * x * x
        a = k * err + 2 * self.cfg['damping'] * freq * (ff * self.cfg['track_gain'] - v)
        a = clamp(a, -max_a, max_a)
        return clamp(v + a * h, -max_v, max_v)
