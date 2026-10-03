package mimic;

import java.util.Random;

/** The distributions the human model needs. Reaction and motor times are log-normal (right-skewed). */
final class Rand {
	private final Random r = new Random();

	double uniform(double a, double b) { return a + (b - a) * r.nextDouble(); }

	boolean chance(double p) { return r.nextDouble() < p; }

	double gaussian(double mean, double sd) { return mean + sd * r.nextGaussian(); }

	/** Log-normal with this real mean and sd (what you'd measure). */
	double lognormal(double mean, double sd) {
		double v = sd * sd;
		double mu = Math.log(mean * mean / Math.sqrt(v + mean * mean));
		double sigma = Math.sqrt(Math.log(1 + v / (mean * mean)));
		return Math.exp(gaussian(mu, sigma));
	}

	/** Ticks (50 ms) of a log-normal delay, at least {@code min}. */
	int ticks(double meanMs, double sdMs, int min) {
		return Math.max(min, (int) Math.round(lognormal(meanMs, sdMs) / 50));
	}

	/** Ornstein-Uhlenbeck noise: smooth, mean-reverting, like a hand's tremor and drift. */
	final class OU {
		private final double theta;
		private final double sigma;
		private double x;

		OU(double theta, double sigma) {
			this.theta = theta;
			this.sigma = sigma;
		}

		double step(double dt) {
			x += -theta * x * dt + sigma * Math.sqrt(dt) * r.nextGaussian();
			return x;
		}
	}

	static double clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }
}
