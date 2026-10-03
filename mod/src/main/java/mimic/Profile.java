package mimic;

/**
 * Skill levels. Every number is in a range measured for real players; "pro"
 * sits near the top of human performance and never past it.
 */
final class Profile {
	final String name;
	// hand (aim)
	double freq, damping, pitchFreqScale, maxSpeedDeg, maxAccelDeg, tremorDeg, trackGain, lazyFloor;
	// perception
	double reactionMs, reactionSdMs, prediction, aimHeight, aimPointWander;
	// keys
	double keyDelayMs, keyDelaySdMs;
	// combat
	double clickDelayMs, clickDelaySdMs, earlyClickChance, critRate, wtapChance, strafe, strafeSwitchMs, spacing, reach, lowHealth, aimDiscipline, closeGap;

	private Profile(String name) { this.name = name; }

	static Profile of(String name) {
		Profile p = new Profile(name);
		switch (name) {
			case "casual" -> {
				p.aim(9, 0.62, 0.75, 600, 5000, 2.2, 0.55, 0.25);
				p.perception(260, 60, 0.75, 0.7, 0.18);
				p.keys(90, 35);
				p.combat(140, 70, 0.18, 0.35, 0.2, 0.5, 1100, 0.3, 2.85, 6, 0.4, 1.6);
			}
			case "good" -> {
				p.aim(13, 0.68, 0.8, 900, 8000, 1.5, 0.75, 0.2);
				p.perception(210, 45, 0.9, 0.72, 0.14);
				p.keys(70, 25);
				p.combat(85, 40, 0.08, 0.6, 0.45, 0.8, 800, 0.6, 2.95, 6, 0.75, 2.0);
			}
			case "pro" -> {
				p.aim(17, 0.72, 0.85, 1200, 12000, 1.0, 0.88, 0.15);
				p.perception(175, 35, 0.97, 0.74, 0.1);
				p.keys(55, 20);
				p.combat(55, 25, 0.03, 0.8, 0.6, 0.95, 650, 0.85, 3.0, 6, 0.92, 2.3);
			}
			default -> { return null; }
		}
		return p;
	}

	private void aim(double freq, double damping, double pitchFreqScale, double maxSpeedDeg, double maxAccelDeg, double tremorDeg, double trackGain, double lazyFloor) {
		this.freq = freq; this.damping = damping; this.pitchFreqScale = pitchFreqScale; this.maxSpeedDeg = maxSpeedDeg;
		this.maxAccelDeg = maxAccelDeg; this.tremorDeg = tremorDeg; this.trackGain = trackGain; this.lazyFloor = lazyFloor;
	}

	private void perception(double reactionMs, double reactionSdMs, double prediction, double aimHeight, double aimPointWander) {
		this.reactionMs = reactionMs; this.reactionSdMs = reactionSdMs; this.prediction = prediction; this.aimHeight = aimHeight; this.aimPointWander = aimPointWander;
	}

	private void keys(double keyDelayMs, double keyDelaySdMs) { this.keyDelayMs = keyDelayMs; this.keyDelaySdMs = keyDelaySdMs; }

	private void combat(double clickDelayMs, double clickDelaySdMs, double earlyClickChance, double critRate, double wtapChance, double strafe, double strafeSwitchMs, double spacing, double reach, double lowHealth, double aimDiscipline, double closeGap) {
		this.clickDelayMs = clickDelayMs; this.clickDelaySdMs = clickDelaySdMs; this.earlyClickChance = earlyClickChance; this.critRate = critRate;
		this.wtapChance = wtapChance; this.strafe = strafe; this.strafeSwitchMs = strafeSwitchMs; this.spacing = spacing; this.reach = reach;
		this.lowHealth = lowHealth; this.aimDiscipline = aimDiscipline; this.closeGap = closeGap;
	}
}
