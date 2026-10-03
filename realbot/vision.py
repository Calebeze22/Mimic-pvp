"""Reads what a player would read off the screen: where the opponent is (by
their diamond armor), roughly how far away, and the bot's own hearts.

Nothing here touches the game; it only looks at pixels.
"""
from dataclasses import dataclass
import math

import cv2
import numpy as np

# Diamond armor is a saturated cyan/teal. OpenCV hue runs 0-180, so this is
# roughly 160-200 degrees. The sky is a paler blue around 210-220 degrees.
ARMOR_HSV_LO = np.array([78, 110, 80], dtype=np.uint8)
ARMOR_HSV_HI = np.array([97, 255, 255], dtype=np.uint8)
PLAYER_HEIGHT = 1.85  # top of helmet to bottom of boots, blocks
PLAYER_WIDTH = 0.65


@dataclass
class Detection:
    x0: int
    y0: int
    x1: int
    y1: int
    area: int
    clipped: bool  # touches the screen edge or the HUD mask, so height is unreliable

    @property
    def w(self):
        return self.x1 - self.x0

    @property
    def h(self):
        return self.y1 - self.y0

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    def contains(self, x, y, shrink=0.15):
        dx = self.w * shrink / 2
        dy = self.h * shrink / 2
        return self.x0 + dx <= x <= self.x1 - dx and self.y0 + dy <= y <= self.y1 - dy


def hud_mask(width, height, gui):
    """Areas of the screen that show the bot's own stuff, never the opponent:
    the hotbar/hearts strip and the first-person hand (a diamond sword is
    cyan too). gui may be fractional when the frame was scaled down."""
    m = np.full((height, width), 255, dtype=np.uint8)
    hud_top = int(height - 44 * gui)
    m[max(0, hud_top):, :] = 0
    m[int(height * 0.58):, int(width * 0.6):] = 0  # held sword, bottom right
    return m


def detect_player(frame_bgr, gui, min_area_frac=0.00004, max_width=960):
    """Finds the opponent. Large frames are scaled down first (the armor is
    big and blocky, so this loses nothing) and the box is scaled back."""
    fh, fw = frame_bgr.shape[:2]
    scale = 1.0
    if fw > max_width:
        scale = max_width / fw
        frame_bgr = cv2.resize(frame_bgr, (max_width, int(round(fh * scale))), interpolation=cv2.INTER_AREA)
        gui = gui * scale
    det = _detect(frame_bgr, gui, min_area_frac)
    if det is None or scale == 1.0:
        return det
    k = 1 / scale
    return Detection(int(det.x0 * k), int(det.y0 * k), int(round(det.x1 * k)), int(round(det.y1 * k)),
                     int(det.area * k * k), det.clipped)


def _detect(frame_bgr, gui, min_area_frac):
    h, w = frame_bgr.shape[:2]
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, ARMOR_HSV_LO, ARMOR_HSV_HI)
    hud = hud_mask(w, h, gui)
    mask = cv2.bitwise_and(mask, hud)
    if cv2.countNonZero(mask) < max(4, int(min_area_frac * w * h)):
        return None
    # Helmet, chestplate, leggings and boots are separate patches with skin and
    # shading between them; a tall closing joins one player's pieces.
    k = max(3, int(h * 0.012))
    joined = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k * 4)))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    if n <= 1:
        return None
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, bw, bh, area = stats[best]
    if area < max(4, int(min_area_frac * w * h)):
        return None
    hud_top = int(h - 44 * gui)
    clipped = x <= 0 or y <= 0 or x + bw >= w or y + bh >= hud_top or (y + bh >= int(h * 0.58) and x + bw >= int(w * 0.6))
    return Detection(int(x), int(y), int(x + bw), int(y + bh), int(area), bool(clipped))


def estimate_distance(det, focal_px):
    """Blocks from the camera, from apparent size (pinhole camera)."""
    if det.h > 0 and not det.clipped:
        return focal_px * PLAYER_HEIGHT / det.h
    if det.w > 0:
        return focal_px * PLAYER_WIDTH / det.w
    return None


def angles_to(x, y, width, height, focal_px):
    """Screen point -> (yaw, pitch) offset from the crosshair, degrees.
    Positive yaw = right, positive pitch = down."""
    return (math.degrees(math.atan((x - width / 2) / focal_px)),
            math.degrees(math.atan((y - height / 2) / focal_px)))


def read_health(frame_bgr, gui):
    """Counts the bot's hearts (0-20 half-hearts) from the HUD.
    Hearts sit left of center above the hotbar: 10 hearts, 8 GUI px apart."""
    h, w = frame_bgr.shape[:2]
    x0 = w // 2 - 91 * gui
    y = h - 39 * gui + 4 * gui
    hp = 0
    for i in range(10):
        for half in (0, 1):
            px = x0 + i * 8 * gui + (2 + half * 4) * gui
            if not (0 <= px < w and 0 <= y < h):
                continue
            b, g, r = (int(v) for v in frame_bgr[y, px])
            if r > 150 and g < 90 and b < 90:
                hp += 1
    return hp
