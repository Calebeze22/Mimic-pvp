"""The fight: what to hold, when to click, where to look.

It only knows what a player knows: what's on screen (where the opponent is,
how big, its own hearts) and what its own hands did (when it last clicked,
when it jumped, which keys are down). All times are ms.

Sword timing: a full-strength hit needs 625 ms since the last click (any
click, hit or miss, restarts it). A crit is an unsprinted hit while falling,
which on flat ground is about 300-600 ms after leaving the ground.
"""
from dataclasses import dataclass

from .util import clamp

SWORD_MS = 625
AIRTIME_MS = 600  # a flat-ground jump
FALL_FROM_MS = 300  # apex; falling after this
SERVER_REACH = 3.0


@dataclass
class FrameInfo:
    t: float  # when it was captured
    visible: bool  # opponent on screen in this frame
    on_target: bool  # crosshair on their body in this frame
    health: int  # own half-hearts, -1 if unreadable


class Brain:
    def __init__(self, cfg, keys, aim, perc, rand):
        self.cfg = cfg
        self.c = cfg['combat']
        self.keys = keys
        self.aim = aim
        self.perc = perc
        self.rand = rand
        self.look = None  # (desired, rate, lazy_r) for the aim this tick
        self.frame = None
        self.health = 20
        self._hp_reads = []
        self.hurt_t = -1e9
        self.last_click_t = -1e9
        self.last_hit_t = -1e9
        self.jump_t = -1e9
        self.engaged = False
        self.react_until = 0
        self.mode = 'sprint'
        self.click = None
        self.wtap_until = 0
        self.wtap_from = 0
        self.retreat_until = 0
        self.spacing_check_at = 0
        self.strafe_dir = 1
        self.strafing = False
        self.next_strafe_switch = 0
        self.sprinting = False
        self.idle_look = None
        self.idle_since = 0
        self.search = None
        self.stats = dict(clicks=0, hits=0, crits=0, sprint_hits=0, misses=0)

    # ------------------------------------------------------------ inputs

    def see(self, info):
        self.frame = info
        if info.health >= 0:
            self._hp_reads = (self._hp_reads + [info.health])[-3:]
            hp = sorted(self._hp_reads)[len(self._hp_reads) // 2]
            if hp < self.health and len(self._hp_reads) >= 2:
                self.hurt_t = info.t
            self.health = hp

    def strength(self, now):
        return clamp((now - self.last_click_t) / SWORD_MS, 0, 1)

    def ms_to_full(self, now):
        return max(0.0, SWORD_MS * 0.93 - (now - self.last_click_t))

    def airborne(self, now):
        return self.jump_t + 30 <= now <= self.jump_t + AIRTIME_MS

    def falling(self, now):
        return self.jump_t + FALL_FROM_MS <= now <= self.jump_t + AIRTIME_MS - 25

    def stat_line(self):
        s = self.stats
        swings = s['hits'] + s['misses']
        acc = round(100 * s['hits'] / swings) if swings else 0
        return f"hits {s['hits']} (crit {s['crits']}, sprint {s['sprint_hits']}) misses {s['misses']} acc {acc}%"

    # ------------------------------------------------------------ tick

    def update(self, now, dt):
        k = self.keys
        k.update(now)
        self._track_sprint(now)
        seen = self.perc.perceive(now, dt)
        if seen and not self.engaged:
            self.engaged = True
            self.search = None
            self.perc.refresh_reaction()
            self.react_until = now + self.perc.reaction
            if now - self.idle_since > 3000:
                k.tap('hotbar1', delay=self.rand.lognormal(250, 80))  # make sure the sword is out
                self.last_click_t = max(self.last_click_t, now)  # switching items resets the charge
            self._pick_mode(seen, now)
        if seen:
            self._fight(seen, now)
        else:
            if self.engaged:
                self.engaged = False
                self.click = None
            self._no_target(now)

    def _track_sprint(self, now):
        k = self.keys
        if not k.is_down('forward') or k.is_down('back'):
            self.sprinting = False
        elif k.is_down('sprint') and k.held_for('sprint', now) > 50 and k.held_for('forward', now) > 50:
            self.sprinting = True

    # ------------------------------------------------------------ fight

    def _pick_mode(self, seen, now):
        """Open with a sprint hit (knockback starts the combo), crit while
        they stand and trade, sprint-hit again when they run or it's low."""
        opening = now - self.last_hit_t > 2000
        fleeing = seen.dist_rate > 2.5
        low = self.health <= self.c['low_health']
        self.mode = 'crit' if (not opening and not fleeing and not low and self.rand.chance(self.c['crit_rate'])) else 'sprint'

    def _fight(self, seen, now):
        if now < self.react_until:  # hasn't reacted to them yet
            self.look = ((self.aim.yaw, self.aim.pitch), (0.0, 0.0), 0.0)
        else:
            self.look = ((seen.yaw, seen.pitch), (seen.rate_yaw, seen.rate_pitch), seen.half_w * 0.8)
        if self.rand.random() < 0.0015:  # attention shifts now and then
            self.perc.refresh_reaction()
        self._move(seen, now)
        self._attack(seen, now)

    def _move(self, seen, now):
        k = self.keys
        c = self.c
        dist = seen.dist
        fwd = back = sprint = False
        jump = False
        ttf = self.ms_to_full(now)
        opp_ready = now - self.hurt_t > 550  # their sword has charged since they last hit us

        if dist > 3.4:
            fwd = sprint = True
            if dist > 7 and not self.airborne(now) and now - self.jump_t > 900 and self.rand.chance(0.02):
                jump = True  # sprint-jumping is faster
        else:
            # Spacing: on cooldown while they're ready, step out of their
            # reach instead of trading a weak hit for a full one.
            if now >= self.spacing_check_at:
                self.spacing_check_at = now + self.rand.uniform(200, 400)
                if ttf > 200 and opp_ready and dist < 3.1 and self.rand.chance(c['spacing']):
                    self.retreat_until = now + min(ttf - 100, 300)
            if now < self.retreat_until:
                back = True
            elif dist < c['close_gap']:
                back = dist < c['close_gap'] * 0.6  # don't walk into them, circle instead
            else:
                fwd = True
                sprint = self.mode == 'sprint' or dist > 3.0

            if self.mode == 'crit':
                sprint = False
                ready_soon = ttf <= 350
                if ready_soon and dist < 3.6 and not self.airborne(now) and now - self.jump_t > AIRTIME_MS + 60:
                    if self.sprinting and now >= self.wtap_until:
                        # Still sprinting: let go of W a moment so the crit counts.
                        self.wtap_from, self.wtap_until = now, now + self.rand.uniform(70, 120)
                    elif not self.sprinting:
                        jump = True

        if self.wtap_from <= now < self.wtap_until:
            fwd = sprint = False

        left = right = False
        if dist < 5:
            if now >= self.next_strafe_switch:
                if self.rand.chance(0.7):
                    self.strafe_dir = -self.strafe_dir
                self.strafing = self.rand.chance(c['strafe'])
                self.next_strafe_switch = now + max(200, self.rand.lognormal(c['strafe_switch_ms'], c['strafe_switch_ms'] * 0.45))
            if self.strafing:
                right = self.strafe_dir > 0
                left = not right

        k.want('forward', fwd)
        k.want('back', back)
        k.want('left', left)
        k.want('right', right)
        k.want('sprint', sprint)
        if jump:
            self.jump_t = k.tap('jump', hold_ms=self.rand.uniform(70, 140))

    def _attack(self, seen, now):
        c = self.c
        if now < self.react_until:
            self.click = None
            return
        f = self.frame
        on_target = bool(f and f.visible and f.on_target and now - f.t < 120)
        reach = seen.dist - 0.3  # to the edge of their hitbox

        if self.click is None:
            s = self.strength(now)
            in_range = reach + self.rand.gauss(0, 0.12) <= min(c['reach'], SERVER_REACH)
            want = early = False
            at = None
            if in_range and s >= 0.92:
                if self.mode == 'crit':
                    if self.airborne(now) and not self.sprinting:
                        # Hit on the way down; a player times this by feel.
                        at = self.jump_t + clamp(self.rand.lognormal(430, 55), FALL_FROM_MS + 20, AIRTIME_MS - 40)
                        want = at > now or self.falling(now)
                    elif now - self.jump_t > AIRTIME_MS + 400:
                        want = True  # couldn't get the jump in; just hit
                else:
                    want = True
            elif in_range and 0.6 <= s < 0.9 and self.rand.chance(c['early_click_chance'] / 6):
                want = early = True  # impatient click
            if want:
                delay = self.rand.lognormal(c['click_delay_ms'], c['click_delay_sd_ms'])
                # Better players hold the click until the crosshair is on them.
                at = max(at or 0, now + delay)
                self.click = dict(at=at, early=early, since=at,
                                  disciplined=self.rand.chance(c['aim_discipline']))

        if self.click is None or now < self.click['at']:
            return
        click = self.click
        self.click = None
        if reach > 3.8:
            return  # they're clearly gone; a person wouldn't click
        if not on_target and click['disciplined']:
            if now - click['since'] < 350 and reach <= SERVER_REACH + 0.2:
                click['at'] = now + 16  # hold it a moment for the crosshair
                self.click = click
            return  # or let the chance go rather than whiff

        self.keys.click(delay=0)
        self.stats['clicks'] += 1
        self.last_click_t = now
        if not on_target or reach > SERVER_REACH:
            self.stats['misses'] += 1
            return
        self.stats['hits'] += 1
        self.last_hit_t = now
        if self.falling(now) and not self.sprinting and self.strength(now) >= 0:
            self.stats['crits'] += 1
        if self.sprinting:
            self.stats['sprint_hits'] += 1
            if self.rand.chance(c['wtap_chance']):
                # W-tap: let go of W briefly so the next hit gets full sprint knockback.
                self.wtap_from = now + self.rand.lognormal(60, 20)
                self.wtap_until = self.wtap_from + self.rand.uniform(60, 140)
        self._pick_mode(seen, now)

    # ------------------------------------------------------------ no target

    def _no_target(self, now):
        k = self.keys
        self.click = None
        last = self.perc.last_seen
        recently_seen = last is not None and now - last.t < 4000
        hurt_unseen = now - self.hurt_t < 1500
        if self.search is None and (recently_seen or hurt_unseen):
            if recently_seen:
                # Look where they went: past the edge they left by.
                side = 1 if last.yaw - self.aim.view_yaw >= 0 else -1
                yaw = last.yaw + side * self.rand.uniform(25, 60)
                pitch = clamp(last.pitch_top + 5, -30, 40)
            else:
                side = self.rand.choice((-1, 1))
                yaw = self.aim.view_yaw + side * self.rand.uniform(150, 200)  # hit from behind: turn around
                pitch = self.rand.uniform(-5, 10)
            self.search = dict(yaw=yaw, pitch=pitch, side=side, until=now + 1800)
        if self.search is not None:
            s = self.search
            if now > s['until']:
                if now - s['until'] > 2500:
                    self.search = None
                else:
                    s['yaw'] = self.aim.yaw + s['side'] * 60  # keep turning the same way
            for key in ('forward', 'back', 'left', 'right', 'sprint'):
                k.want(key, False)
            if self.search is not None:
                self.look = ((s['yaw'], s['pitch']), (0.0, 0.0), 0.0)
                self.idle_since = now
                return
        self._idle(now)

    def _idle(self, now):
        for key in ('forward', 'back', 'left', 'right', 'sprint'):
            self.keys.want(key, False)
        # Glance around now and then, the way a waiting player moves the mouse.
        if self.idle_look is None or now >= self.idle_look[2]:
            self.idle_look = (self.aim.yaw + self.rand.gauss(0, 25), clamp(self.rand.gauss(0, 8), -30, 30),
                              now + self.rand.lognormal(2500, 1200))
        self.look = ((self.idle_look[0], self.idle_look[1]), (0.0, 0.0), 0.0)

    def reset(self, now):
        self.keys.release_all()
        self.click = None
        self.engaged = False
        self.search = None
        self.idle_look = None
        self.idle_since = now
        self.perc.reset()
        self.aim.settle()
