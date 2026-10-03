package mimic;

/**
 * The mouse hand. A spring-damper pulls the hand toward where the bot wants
 * to look, with damping below critical so big flicks overshoot a little and
 * settle, speed and acceleration capped at human limits, tremor on top, and
 * a lazy zone once the crosshair is already on the target (people stop
 * correcting when they're "on"). The output is whole mouse counts; the game
 * turns the camera from them with its own sensitivity, like any mouse.
 *
 * Angles are Minecraft degrees: yaw 0 faces south, pitch is positive down.
 */
final class Hand {
	private final Profile p;
	private final Rand.OU tremorYaw;
	private final Rand.OU tremorPitch;
	double yaw, pitch; // where the hand points (continuous)
	double vYaw, vPitch; // deg/s

	Hand(Profile p, Rand rand) {
		this.p = p;
		this.tremorYaw = rand.new OU(8, p.tremorDeg);
		this.tremorPitch = rand.new OU(8, p.tremorDeg * 0.7);
	}

	void reset(double yaw, double pitch) {
		this.yaw = yaw;
		this.pitch = pitch;
		vYaw = 0;
		vPitch = 0;
	}

	/**
	 * Moves the hand one tick toward {@code dYaw/dPitch}. {@code rateYaw/ratePitch}
	 * is how fast the target sweeps across view (deg/s), which the hand partly
	 * matches when tracking; {@code lazyR} is the target's angular half-size.
	 */
	void tick(double dt, double dYaw, double dPitch, double rateYaw, double ratePitch, double lazyR) {
		int sub = 5;
		double h = dt / sub;
		for (int i = 0; i < sub; i++) {
			vYaw = axis(h, wrap(dYaw - yaw), vYaw, rateYaw, p.freq, lazyR);
			vPitch = axis(h, dPitch - pitch, vPitch, ratePitch, p.freq * p.pitchFreqScale, lazyR);
			yaw += vYaw * h;
			pitch += vPitch * h;
		}
		yaw += tremorYaw.step(dt) * dt;
		pitch += tremorPitch.step(dt) * dt;
		pitch = Rand.clamp(pitch, -90, 90);
	}

	private double axis(double h, double err, double v, double ff, double freq, double lazyR) {
		double k = freq * freq;
		if (lazyR > 0) {
			double x = Rand.clamp(Math.abs(err) / lazyR, 0, 1);
			k *= p.lazyFloor + (1 - p.lazyFloor) * x * x;
		}
		double a = k * err + 2 * p.damping * freq * (ff * p.trackGain - v);
		a = Rand.clamp(a, -p.maxAccelDeg, p.maxAccelDeg);
		return Rand.clamp(v + a * h, -p.maxSpeedDeg, p.maxSpeedDeg);
	}

	static double wrap(double deg) {
		deg %= 360;
		if (deg >= 180) deg -= 360;
		if (deg < -180) deg += 360;
		return deg;
	}

	/** Degrees one mouse count turns the camera at this sensitivity (vanilla MouseHandler). */
	static double degreesPerCount(double sensitivity) {
		double f = sensitivity * 0.6 + 0.2;
		return f * f * f * 8 * 0.15;
	}
}
