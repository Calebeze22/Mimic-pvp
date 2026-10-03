"""A tiny stand-in for Minecraft: draws what the bot's screen would show
(sky, ground, an opponent in diamond armor, the HUD) and moves the bot from
the keys and mouse counts it sends. Good enough to test the loop end to
end; not vanilla physics."""
import math

import numpy as np

W, H = 960, 540
FOV = 70
FOCAL = (H / 2) / math.tan(math.radians(FOV) / 2)
GUI = 2
EYE = 1.62
SKY = (235, 180, 120)  # BGR, pale blue
GROUND = (60, 150, 80)
ARMOR = [(220, 200, 60), (190, 175, 45), (235, 215, 90)]  # diamond, a few shades
SKIN = (120, 160, 200)


def wrap(a):
    return (a + 180) % 360 - 180


def project(rel_yaw, dist, z, view_pitch):
    """Screen point of something rel_yaw degrees right, dist blocks away,
    z blocks above the bot's feet."""
    x = W / 2 + FOCAL * math.tan(math.radians(rel_yaw))
    down = math.degrees(math.atan2(EYE - z, dist))
    y = H / 2 + FOCAL * math.tan(math.radians(down - view_pitch))
    return x, y


def render(rel_yaw=None, dist=None, view_pitch=0.0, health=20, opp_z=0.0, cam_z=0.0, sword=True):
    img = np.empty((H, W, 3), np.uint8)
    horizon = int(H / 2 - FOCAL * math.tan(math.radians(view_pitch)))
    img[:max(0, min(H, horizon))] = SKY
    img[max(0, min(H, horizon)):] = GROUND
    if rel_yaw is not None and abs(rel_yaw) < 80 and dist > 0.3:
        pieces = [(1.45, 1.85, 0), (0.78, 1.42, 1), (0.33, 0.76, 2), (0.0, 0.3, 0)]  # helmet, chest, legs, boots
        hw = math.degrees(math.atan2(0.3, dist))
        for z0, z1, shade in pieces:
            xa, ya = project(rel_yaw - hw, dist, opp_z + z1 - cam_z, view_pitch)
            xb, yb = project(rel_yaw + hw, dist, opp_z + z0 - cam_z, view_pitch)
            x0, x1 = int(max(0, min(xa, xb))), int(min(W, max(xa, xb)))
            y0, y1 = int(max(0, ya)), int(min(H, yb))
            if x1 > x0 and y1 > y0:
                img[y0:y1, x0:x1] = ARMOR[shade]
        # face showing through the helmet
        xa, ya = project(rel_yaw - hw * 0.5, dist, opp_z + 1.75 - cam_z, view_pitch)
        xb, yb = project(rel_yaw + hw * 0.5, dist, opp_z + 1.55 - cam_z, view_pitch)
        if xb > xa and yb > ya:
            img[int(max(0, ya)):int(min(H, yb)), int(max(0, xa)):int(min(W, xb))] = SKIN
    # HUD: hotbar, hearts, held sword
    img[H - 22 * GUI:, W // 2 - 91 * GUI:W // 2 + 91 * GUI] = (90, 90, 90)
    x0 = W // 2 - 91 * GUI
    hy = H - 39 * GUI
    for i in range(10):
        hx = x0 + i * 8 * GUI
        img[hy:hy + 9 * GUI, hx:hx + 9 * GUI] = (30, 30, 30)
        if health >= 2 * i + 1:
            img[hy + GUI:hy + 8 * GUI, hx + GUI:hx + 4 * GUI + GUI // 2] = (25, 25, 220)
        if health >= 2 * i + 2:
            img[hy + GUI:hy + 8 * GUI, hx + 4 * GUI + GUI // 2:hx + 8 * GUI] = (25, 25, 220)
    if sword:
        img[int(H * 0.68):H - 50, int(W * 0.72):int(W * 0.8)] = ARMOR[0]
    return img


class FakeInput:
    def __init__(self):
        self.held = set()
        self.dx = 0
        self.dy = 0
        self.presses = []  # (code, down)

    def key(self, code, down):
        (self.held.add if down else self.held.discard)(code)
        self.presses.append((code, down))

    def move(self, dx, dy):
        self.dx += dx
        self.dy += dy


class Arena:
    """Bot vs a scripted opponent who strafes, keeps spacing and swings
    back. Steps in ms; the bot's view lags its mouse by display_ms."""

    def __init__(self, rand, start_dist=10.0, start_off=35.0, dpc=0.15, display_ms=25, opp_speed=3.5,
                 opp_hits=True):
        self.r = rand
        self.dpc = dpc
        self.display_ms = display_ms
        self.t = 0.0
        self.bot = [0.0, 0.0]
        self.bot_v = [0.0, 0.0]
        self.yaw0 = -start_off  # bot looks start_off degrees left of the opponent
        self.opp = [0.0, start_dist]
        self.opp_v = [0.0, 0.0]
        self.opp_speed = opp_speed
        self.opp_dir = 1
        self.opp_switch = 0.0
        self.opp_hits = opp_hits
        self.opp_last_hit = -1e9
        self.kb = [0.0, 0.0]
        self.jump_t = -1e9
        self.health = 20
        self.inp = FakeInput()
        self.mouse_hist = [(0.0, 0, 0)]
        self.stats = dict(clicks=0, hits=0, crits=0, sprint_hits=0, min_dist=1e9, close_at=None, bot_hurt=0)
        self.click_times = []

    # -- view

    def view(self, t=None):
        t = self.t if t is None else t
        cx, cy = 0, 0
        for ht, x, y in self.mouse_hist:
            if ht <= t - self.display_ms:
                cx, cy = x, y
            else:
                break
        return self.yaw0 + cx * self.dpc, max(-89.0, min(89.0, cy * self.dpc))

    def cam_z(self):
        s = (self.t - self.jump_t) / 600
        return 4 * 1.25 * s * (1 - s) if 0 <= s <= 1 else 0.0

    def rel(self):
        dx, dy = self.opp[0] - self.bot[0], self.opp[1] - self.bot[1]
        d = math.hypot(dx, dy)
        yaw, pitch = self.view()
        return wrap(math.degrees(math.atan2(dx, dy)) - yaw), d, pitch

    def frame(self):
        rel, d, pitch = self.rel()
        return render(rel, d, pitch, health=self.health, cam_z=self.cam_z())

    # -- world

    def held(self, code):
        return code in self.inp.held

    def step(self, ms):
        dt = ms / 1000
        self.t += ms
        if self.inp.dx or self.inp.dy:
            _, x, y = self.mouse_hist[-1]
            self.mouse_hist.append((self.t, x + self.inp.dx, y + self.inp.dy))
            self.mouse_hist = self.mouse_hist[-400:]
            self.inp.dx = self.inp.dy = 0
        self._bot_move(dt)
        self._opp_move(dt)
        d = math.hypot(self.opp[0] - self.bot[0], self.opp[1] - self.bot[1])
        if d < self.stats['min_dist']:
            self.stats['min_dist'] = d
        if d < 3.3 and self.stats['close_at'] is None:
            self.stats['close_at'] = self.t

    def sprinting(self):
        return self.held('KEY_W') and self.held('KEY_LEFTCTRL') and not self.held('KEY_S')

    def _bot_move(self, dt):
        yaw, _ = self.view()
        fwd = (self.held('KEY_W') - self.held('KEY_S'))
        side = (self.held('KEY_D') - self.held('KEY_A'))
        n = math.hypot(fwd, side) or 1
        speed = 5.6 if self.sprinting() else 4.3
        if self.cam_z() > 0:
            speed *= 1.1
        y = math.radians(yaw)
        f = (math.sin(y), math.cos(y))
        rt = (math.cos(y), -math.sin(y))
        want = [(fwd * f[i] + side * rt[i]) / n * speed for i in range(2)]
        a = min(1, dt / 0.08)
        for i in range(2):
            self.bot_v[i] += (want[i] - self.bot_v[i]) * a
            self.bot[i] += (self.bot_v[i] + self.kb[i]) * dt
            self.kb[i] *= max(0, 1 - dt / 0.2)
        if self.held('KEY_SPACE') and self.t - self.jump_t > 620:
            self.jump_t = self.t

    def _opp_move(self, dt):
        dx, dy = self.bot[0] - self.opp[0], self.bot[1] - self.opp[1]
        d = math.hypot(dx, dy) or 1
        to = (dx / d, dy / d)
        perp = (-to[1], to[0])
        if self.t >= self.opp_switch:
            self.opp_dir = -self.opp_dir
            self.opp_switch = self.t + self.r.uniform(500, 1300)
        approach = 1 if d > 3.2 else (-0.7 if d < 2.4 else 0)
        if d > 6:
            approach, side = 0.3, 0  # waits for the bot to come
        else:
            side = self.opp_dir
        v = [(approach * to[i] + side * perp[i]) * self.opp_speed for i in range(2)]
        for i in range(2):
            self.opp_v[i] += (v[i] - self.opp_v[i]) * min(1, dt / 0.1)
            self.opp[i] += self.opp_v[i] * dt
        if self.opp_hits and d < 3.0 and self.t - self.opp_last_hit > 700:
            self.opp_last_hit = self.t
            self.health = max(1, self.health - 1)
            self.stats['bot_hurt'] += 1
            for i in range(2):
                self.kb[i] += to[i] * 5

    def on_click(self):
        """Referee: does a click now land, judged from the real positions?"""
        self.stats['clicks'] += 1
        self.click_times.append(self.t)
        rel, d, pitch = self.rel()
        reach = d - 0.3
        half = math.degrees(math.atan2(0.3, max(d, 0.3))) + 0.3
        z = self.cam_z()
        top = math.degrees(math.atan2(EYE + z - 1.85, d))
        bot = math.degrees(math.atan2(EYE + z, d))
        on = abs(rel) <= half and top - 1 <= pitch <= bot + 1
        if not (on and reach <= 3.0):
            return False
        self.stats['hits'] += 1
        s = (self.t - self.jump_t) / 600
        sprint = self.sprinting()
        if 0.5 < s < 1 and not sprint:
            self.stats['crits'] += 1
        if sprint:
            self.stats['sprint_hits'] += 1
        dx, dy = self.opp[0] - self.bot[0], self.opp[1] - self.bot[1]
        k = (1.2 if sprint else 0.6) / max(d, 0.1)
        self.opp[0] += dx * k * 0.5
        self.opp[1] += dy * k * 0.5
        return True


def fight(profile_name='pro', seconds=20, seed=3, **arena_kw):
    """Runs the real bot code against the Arena. Returns (arena, brain)."""
    from realbot.__main__ import Eyes
    from realbot.aim import Aim
    from realbot.brain import Brain
    from realbot.config import GameSettings, profile
    from realbot.inputdev import Keys
    from realbot.perception import Perception
    from realbot.util import Rand

    rand = Rand(seed)
    settings = GameSettings({'fov': '0.0', 'guiScale': str(GUI), 'fovEffectScale': '0.0', 'mouseSensitivity': '0.5'})
    cfg = profile(profile_name)
    arena = Arena(Rand(seed + 100), dpc=settings.degrees_per_count(), **arena_kw)
    inp = arena.inp
    orig_key = inp.key

    def key(code, down):
        orig_key(code, down)
        if code == 'BTN_LEFT' and down:
            arena.on_click()
    inp.key = key
    keys = Keys(inp, settings, cfg['keys'], rand)
    aim = Aim(cfg['aim'], settings.degrees_per_count(), rand)
    perc = Perception(cfg['perception'], rand, 35)
    brain = Brain(cfg, keys, aim, perc, rand)
    eyes = Eyes(settings)
    brain.reset(0)
    next_frame = 0.0
    step = 4
    while arena.t < seconds * 1000:
        now = arena.t
        if now >= next_frame:
            next_frame += 1000 / 60
            f = arena.frame()
            det, info = eyes.look(now, f)
            vy, vp = aim.view_at(now - 35)
            # the bot's frame is relative to where it started looking
            perc.add(now, det, vy, vp, W, H, settings.focal_px(H))
            brain.see(info)
        brain.update(now, step / 1000)
        desired, rate, lazy = brain.look
        dx, dy = aim.tick(now, step / 1000, desired, rate, lazy)
        inp.move(dx, dy)
        arena.step(step)
    return arena, brain
