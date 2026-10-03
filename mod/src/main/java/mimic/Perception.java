package mimic;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;

/**
 * What a person "sees": the target where it was one reaction time ago, pushed
 * forward by an imperfect guess of its motion. The point on the body they aim
 * at wanders slowly instead of locking onto one pixel.
 */
final class Perception {
	private record Sample(int tick, Vec3 pos) {}

	private final Profile p;
	private final Rand rand;
	private final Map<Integer, ArrayDeque<Sample>> history = new HashMap<>();
	private final Rand.OU offY;
	private final Rand.OU offX;
	double reactionMs;

	Perception(Profile p, Rand rand) {
		this.p = p;
		this.rand = rand;
		this.offY = rand.new OU(1.5, p.aimPointWander);
		this.offX = rand.new OU(1.5, p.aimPointWander);
		this.reactionMs = p.reactionMs;
	}

	void record(Iterable<? extends Entity> entities, int tick) {
		for (Entity e : entities) {
			ArrayDeque<Sample> h = history.computeIfAbsent(e.getId(), k -> new ArrayDeque<>());
			h.addLast(new Sample(tick, e.position()));
			while (h.size() > 40) h.removeFirst();
		}
		for (Iterator<ArrayDeque<Sample>> it = history.values().iterator(); it.hasNext(); ) {
			ArrayDeque<Sample> h = it.next();
			if (h.isEmpty() || tick - h.peekLast().tick > 100) it.remove();
		}
	}

	/** A fresh reaction time each time attention moves to something new. */
	void refreshReaction() {
		reactionMs = Rand.clamp(rand.lognormal(p.reactionMs, p.reactionSdMs), p.reactionMs * 0.6, p.reactionMs * 2.5);
	}

	private Vec3 at(int id, double tick) {
		ArrayDeque<Sample> h = history.get(id);
		if (h == null || h.isEmpty()) return null;
		Sample prev = null;
		for (Sample s : h) {
			if (s.tick >= tick) {
				if (prev == null) return s.pos;
				double f = (tick - prev.tick) / Math.max(1, s.tick - prev.tick);
				return prev.pos.lerp(s.pos, f);
			}
			prev = s;
		}
		return h.peekLast().pos;
	}

	/** Blocks per second, over the last few ticks before {@code tick}. */
	Vec3 velocity(int id, double tick) {
		Vec3 a = at(id, tick - 3);
		Vec3 b = at(id, tick);
		return a == null || b == null ? Vec3.ZERO : b.subtract(a).scale(20.0 / 3);
	}

	/** Perceived feet position now: seen a reaction time ago, partly extrapolated. */
	Vec3 perceive(Entity e, int tick) {
		double seenAt = tick - reactionMs / 50;
		Vec3 pos = at(e.getId(), seenAt);
		if (pos == null) pos = e.position();
		Vec3 vel = velocity(e.getId(), seenAt);
		double lead = reactionMs / 1000 * p.prediction;
		return pos.add(vel.x * lead, 0, vel.z * lead);
	}

	/** Where on the body to aim: height fraction and sideways offset that drift over time. */
	double[] aimOffset(Entity e, double dt) {
		double y = Rand.clamp(p.aimHeight + offY.step(dt), 0.15, 0.95) * e.getBbHeight();
		double side = Rand.clamp(offX.step(dt), -0.8, 0.8) * e.getBbWidth() / 2;
		return new double[] {y, side};
	}
}
