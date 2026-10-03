"""Skill profiles and the player's Minecraft settings (read from options.txt).

Profiles trade skill against how perfect the bot looks. Every number sits in
a range measured for real players; "pro" is near the top of human
performance, never past it.
"""
import copy
import math
import os

PROFILES = {
    'casual': {
        'aim': dict(freq=9, damping=0.62, pitch_scale=0.75, max_speed_deg=600, max_accel_deg=5000,
                    tremor_deg=2.2, track_gain=0.55, lazy_floor=0.25),
        'perception': dict(reaction_ms=260, track_ms=150, reaction_sd_ms=60, prediction=0.75, aim_height=0.7, wander=0.18),
        'keys': dict(delay_ms=90, delay_sd_ms=35),
        'combat': dict(click_delay_ms=140, click_delay_sd_ms=70, early_click_chance=0.18, crit_rate=0.35,
                       wtap_chance=0.2, strafe=0.5, strafe_switch_ms=1100, spacing=0.3, reach=2.8,
                       aim_discipline=0.4, close_gap=1.6, low_health=6),
    },
    'good': {
        'aim': dict(freq=13, damping=0.68, pitch_scale=0.8, max_speed_deg=900, max_accel_deg=8000,
                    tremor_deg=1.5, track_gain=0.75, lazy_floor=0.2),
        'perception': dict(reaction_ms=210, track_ms=120, reaction_sd_ms=45, prediction=0.9, aim_height=0.72, wander=0.14),
        'keys': dict(delay_ms=70, delay_sd_ms=25),
        'combat': dict(click_delay_ms=85, click_delay_sd_ms=40, early_click_chance=0.08, crit_rate=0.6,
                       wtap_chance=0.45, strafe=0.8, strafe_switch_ms=800, spacing=0.6, reach=2.9,
                       aim_discipline=0.75, close_gap=2.0, low_health=6),
    },
    'pro': {
        'aim': dict(freq=17, damping=0.72, pitch_scale=0.85, max_speed_deg=1200, max_accel_deg=12000,
                    tremor_deg=1.0, track_gain=0.88, lazy_floor=0.15),
        'perception': dict(reaction_ms=175, track_ms=100, reaction_sd_ms=35, prediction=0.97, aim_height=0.74, wander=0.1),
        'keys': dict(delay_ms=55, delay_sd_ms=20),
        'combat': dict(click_delay_ms=55, click_delay_sd_ms=25, early_click_chance=0.03, crit_rate=0.8,
                       wtap_chance=0.6, strafe=0.95, strafe_switch_ms=650, spacing=0.85, reach=3.0,
                       aim_discipline=0.92, close_gap=2.3, low_health=6),
    },
}


def profile(name):
    if name not in PROFILES:
        raise ValueError(f'unknown profile {name!r} (casual, good, pro)')
    return copy.deepcopy(PROFILES[name])


# options.txt key names (GLFW) -> Linux input event codes.
_SPECIAL = {
    'left.control': 'KEY_LEFTCTRL', 'right.control': 'KEY_RIGHTCTRL', 'left.shift': 'KEY_LEFTSHIFT',
    'right.shift': 'KEY_RIGHTSHIFT', 'left.alt': 'KEY_LEFTALT', 'right.alt': 'KEY_RIGHTALT',
    'space': 'KEY_SPACE', 'tab': 'KEY_TAB', 'caps.lock': 'KEY_CAPSLOCK', 'enter': 'KEY_ENTER',
    'up': 'KEY_UP', 'down': 'KEY_DOWN', 'left': 'KEY_LEFT', 'right': 'KEY_RIGHT',
}


def key_code(mc_name):
    """'key.keyboard.w' -> 'KEY_W', 'key.mouse.left' -> 'BTN_LEFT'."""
    if mc_name.startswith('key.mouse.'):
        b = mc_name[len('key.mouse.'):]
        return {'left': 'BTN_LEFT', 'right': 'BTN_RIGHT', 'middle': 'BTN_MIDDLE'}.get(b, 'BTN_SIDE' if b == '4' else 'BTN_EXTRA')
    k = mc_name[len('key.keyboard.'):]
    if k in _SPECIAL:
        return _SPECIAL[k]
    if len(k) == 1 and k.isalnum():
        return 'KEY_' + k.upper()
    if k.startswith('keypad.'):
        return 'KEY_KP' + k.split('.', 1)[1].upper()
    return 'KEY_' + k.replace('.', '').upper()


class GameSettings:
    """The bits of the bot account's options.txt the bot depends on."""

    DEFAULT_KEYS = {
        'forward': 'key.keyboard.w', 'back': 'key.keyboard.s', 'left': 'key.keyboard.a',
        'right': 'key.keyboard.d', 'jump': 'key.keyboard.space', 'sprint': 'key.keyboard.left.control',
        'attack': 'key.mouse.left', 'use': 'key.mouse.right', 'hotbar1': 'key.keyboard.1',
    }
    OPTION_KEYS = {
        'forward': 'key_key.forward', 'back': 'key_key.back', 'left': 'key_key.left', 'right': 'key_key.right',
        'jump': 'key_key.jump', 'sprint': 'key_key.sprint', 'attack': 'key_key.attack', 'use': 'key_key.use',
        'hotbar1': 'key_key.hotbar.1',
    }

    def __init__(self, values=None):
        v = values or {}
        self.raw = v
        self.sensitivity = float(v.get('mouseSensitivity', 0.5))
        # options.txt stores FOV as -1..1 around 70 degrees.
        self.fov = 70 + 40 * float(v.get('fov', 0.0))
        self.gui_scale = int(v.get('guiScale', 0))
        self.fov_effects = float(v.get('fovEffectScale', 1.0))
        self.raw_input = v.get('rawMouseInput', 'true') == 'true'
        self.toggle_sprint = v.get('toggleSprint', 'false') == 'true'
        self.invert_y = v.get('invertYMouse', v.get('invertMouseY', 'false')) == 'true'
        self.keys = {a: key_code(v.get(o, self.DEFAULT_KEYS[a])) for a, o in self.OPTION_KEYS.items()}

    @classmethod
    def load(cls, path=None):
        path = path or os.path.expanduser('~/.minecraft/options.txt')
        values = {}
        if os.path.exists(path):
            with open(path, encoding='utf-8', errors='replace') as f:
                for line in f:
                    if ':' in line:
                        k, val = line.rstrip('\n').split(':', 1)
                        values[k] = val.strip('"')
        return cls(values)

    def degrees_per_count(self):
        """Vanilla: degrees turned per mouse count at this sensitivity."""
        f = self.sensitivity * 0.6 + 0.2
        return f * f * f * 8 * 0.15

    def effective_gui_scale(self, width, height):
        """guiScale 0 means auto: the largest scale that fits 320x240 per unit."""
        if self.gui_scale > 0:
            return self.gui_scale
        s = 1
        while (s + 1) * 320 <= width and (s + 1) * 240 <= height:
            s += 1
        return s

    def problems(self):
        """Settings that would make the bot misread the screen or the mouse."""
        out = []
        if not self.raw_input:
            out.append('Turn on Raw Input (Options > Controls > Mouse Settings) so mouse movement is exact.')
        if self.fov_effects > 0:
            out.append('Set FOV Effects to 0% (Options > Accessibility) so sprinting does not change the zoom.')
        if self.invert_y:
            out.append('Turn off Invert Mouse so moving the mouse down looks down.')
        if self.toggle_sprint:
            out.append('Set Sprint to Hold (Options > Controls) so the bot controls sprinting like it expects.')
        return out

    def focal_px(self, height):
        """Pixels per unit of tan(angle): Minecraft's FOV setting is vertical."""
        return (height / 2) / math.tan(math.radians(self.fov) / 2)
