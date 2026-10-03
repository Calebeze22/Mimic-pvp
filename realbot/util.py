"""Random timing helpers shared by the human model."""
import math
import random


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class Rand(random.Random):
    """random.Random plus the distributions the human model needs. Seeded
    so a run can be replayed when tuning; unseeded by default."""

    def chance(self, p):
        return self.random() < p

    def lognormal(self, mean, sd):
        """Log-normal by its real mean and sd (what you'd measure). Reaction
        and motor times are right-skewed, never symmetric."""
        if sd <= 0:
            return mean
        v = sd * sd
        mu = math.log(mean * mean / math.sqrt(v + mean * mean))
        sigma = math.sqrt(math.log(1 + v / (mean * mean)))
        return math.exp(self.gauss(mu, sigma))


class OU:
    """Ornstein-Uhlenbeck noise: smooth and mean-reverting, so errors are
    correlated over time like a real hand. Stationary sd is about
    sigma / sqrt(2 * theta)."""

    def __init__(self, rand, theta, sigma):
        self.rand = rand
        self.theta = theta
        self.sigma = sigma
        self.x = 0.0

    def step(self, dt):
        self.x += -self.theta * self.x * dt + self.sigma * math.sqrt(dt) * self.rand.gauss(0, 1)
        return self.x
