package mimic;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import mimic.mixin.MouseHandlerAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.FluidTags;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Decides what to do each tick and does it only through the keys and the
 * mouse hand. It reads what the client already knows about the world (where
 * players are, how they move, when they swing) and never changes anything
 * about its own player directly: no reach, no velocity, no rotation set by
 * code, no packets. Vanilla does every hit, sprint reset and step.
 */
final class Brain {
	private static final class Click {
		final int at;
		final boolean early;
		int waited;

		Click(int at, boolean early) { this.at = at; this.early = early; }
	}

	private final Minecraft mc = Minecraft.getInstance();
	private final Rand rand = new Rand();
	Profile p;
	private Hand hand;
	private Perception perc;
	private Keys keys;

	private int tick;
	private boolean active;
	String duelTarget;
	private Player target;
	private final Map<Integer, Integer> attackers = new HashMap<>();
	private final Map<Integer, Integer> swings = new HashMap<>();
	private final Map<Integer, Boolean> wasSwinging = new HashMap<>();
	private int lastHurtTime;
	private String mode = "crit";
	private Click click;
	private int jumpRelease, critJumpTick = -1000, wtapUntil, strafeDir = 1, nextStrafeSwitch, retreatUntil, spacingCheckAt;
	private boolean strafing;
	private int lastHitTick = -1000, lastSwingTick = -1000, reactUntil, swapAt = -1;
	private double idleYaw, idlePitch;
	private int idleUntil;
	// camera bookkeeping, to notice rotations we didn't cause (teleports)
	private double expYaw, expPitch;
	private boolean haveCam;

	int hits, crits, sprintHits, misses, earlyHits;

	Brain(Profile p) { setProfile(p); }

	void setProfile(Profile p) {
		if (keys != null) keys.releaseAll();
		this.p = p;
		this.hand = new Hand(p, rand);
		this.perc = new Perception(p, rand);
		this.keys = new Keys(p, rand);
		this.haveCam = false;
	}

	String statLine() {
		int swings = hits + misses;
		return String.format("hits %d (crit %d, sprint %d, early %d) misses %d acc %d%%", hits, crits, sprintHits, earlyHits, misses, swings == 0 ? 0 : Math.round(100f * hits / swings));
	}

	void resetStats() { hits = crits = sprintHits = misses = earlyHits = 0; }

	void duel(String name) {
		resetFight();
		duelTarget = name;
	}

	void endDuel() {
		duelTarget = null;
		resetFight();
	}

	private void resetFight() {
		target = null;
		click = null;
		keys.releaseAll();
	}

	// ------------------------------------------------------------------ tick

	void tick(boolean enabled) {
		LocalPlayer me = mc.player;
		if (me == null || mc.level == null) { haveCam = false; return; }
		boolean can = enabled && mc.screen == null && mc.isWindowActive() && me.isAlive() && !me.isSpectator();
		if (!can) {
			if (active) { keys.releaseAll(); click = null; active = false; }
			owedX = owedY = paidX = paidY = 0;
			keys.update();
			haveCam = false;
			return;
		}
		active = true;
		tick++;
		syncCamera(me);

		List<Player> players = new ArrayList<>();
		for (Player pl : mc.level.players()) if (pl != me && pl.isAlive() && !pl.isSpectator()) players.add(pl);
		perc.record(players, tick);
		watchSwingsAndHurt(me, players);

		Player t = selectTarget(me, players);
		if (t != target) {
			target = t;
			click = null;
			perc.refreshReaction();
			reactUntil = tick + (int) Math.round(perc.reactionMs / 50);
			if (t != null) pickMode(me, t);
		}
		if (target != null) fight(me, target);
		else idle(me);
		keys.update();
		moveMouse(me);
	}

	/** The camera only moves from our mouse counts, unless the server turns us (teleport): then the hand starts from there. */
	private void syncCamera(LocalPlayer me) {
		double y = me.getYRot();
		double x = me.getXRot();
		// Where the camera should be: everything we sent, minus what the game hasn't applied yet.
		MouseHandlerAccessor mouse = (MouseHandlerAccessor) mc.mouseHandler;
		double step = Hand.degreesPerCount(mc.options.sensitivity().get());
		double nowYaw = expYaw - (mouse.mimic$getAccumulatedDX() + owedX - paidX) * step;
		double nowPitch = Rand.clamp(expPitch - (mouse.mimic$getAccumulatedDY() + owedY - paidY) * step, -90, 90);
		boolean outside = !haveCam || Math.abs(Hand.wrap(y - nowYaw)) > 1 || Math.abs(x - nowPitch) > 1;
		if (outside) hand.reset(y, x);
		haveCam = true;
	}

	// This tick's mouse counts, handed to the game a little each frame over
	// the tick (a real mouse moves between frames, not 20 times a second).
	private long owedX, owedY, paidX, paidY;
	private long tickStartNanos;

	private void moveMouse(LocalPlayer me) {
		MouseHandlerAccessor mouse = (MouseHandlerAccessor) mc.mouseHandler;
		pay(mouse, 1); // anything from last tick not handed over yet
		double step = Hand.degreesPerCount(mc.options.sensitivity().get());
		double camYaw = me.getYRot() + mouse.mimic$getAccumulatedDX() * step;
		double camPitch = me.getXRot() + mouse.mimic$getAccumulatedDY() * step;
		owedX = Math.round(Hand.wrap(hand.yaw - camYaw) / step);
		owedY = Math.round((Rand.clamp(hand.pitch, -90, 90) - camPitch) / step);
		paidX = paidY = 0;
		tickStartNanos = System.nanoTime();
		expYaw = camYaw + owedX * step;
		expPitch = Rand.clamp(camPitch + owedY * step, -90, 90);
	}

	/** Called every frame just before the game applies mouse movement. */
	void onFrame(MouseHandlerAccessor mouse) {
		if (!active) return;
		pay(mouse, Rand.clamp((System.nanoTime() - tickStartNanos) / 50e6, 0, 1));
	}

	private void pay(MouseHandlerAccessor mouse, double fraction) {
		long x = Math.round(owedX * fraction) - paidX;
		long y = Math.round(owedY * fraction) - paidY;
		if (x == 0 && y == 0) return;
		mouse.mimic$setAccumulatedDX(mouse.mimic$getAccumulatedDX() + x);
		mouse.mimic$setAccumulatedDY(mouse.mimic$getAccumulatedDY() + y);
		paidX += x;
		paidY += y;
	}

	private void watchSwingsAndHurt(LocalPlayer me, List<Player> players) {
		for (Player pl : players) {
			boolean was = wasSwinging.getOrDefault(pl.getId(), false);
			if (pl.swinging && !was) swings.put(pl.getId(), tick);
			wasSwinging.put(pl.getId(), pl.swinging);
		}
		if (me.hurtTime > lastHurtTime) {
			// Blame whoever swung at us just now.
			Player best = null;
			double bestD = 6;
			for (Player pl : players) {
				Integer s = swings.get(pl.getId());
				double d = pl.distanceTo(me);
				if (s != null && tick - s <= 3 && d < bestD) { best = pl; bestD = d; }
			}
			if (best != null) attackers.put(best.getId(), tick);
		}
		lastHurtTime = me.hurtTime;
	}

	// ------------------------------------------------------------------ targeting

	private Player selectTarget(LocalPlayer me, List<Player> players) {
		Player best = null;
		double bestScore = Double.NEGATIVE_INFINITY;
		for (Player pl : players) {
			if (duelTarget != null && !duelTarget.equals(pl.getScoreboardName())) continue;
			double d = pl.distanceTo(me);
			Integer hurt = attackers.get(pl.getId());
			boolean hurtUs = hurt != null && tick - hurt < 200;
			if (duelTarget == null && !hurtUs) continue; // outside a duel it only fights back
			if (d > 24 + (pl == target ? 6 : 0)) continue;
			double score = -d + (hurtUs ? 12 : 0) + (pl == target ? 5 : 0);
			if (score > bestScore) { best = pl; bestScore = score; }
		}
		return best;
	}

	// ------------------------------------------------------------------ fight

	private void pickMode(LocalPlayer me, Player t) {
		// Open with a sprint hit (knockback starts the combo), crit while they
		// stand and trade, sprint-hit again when they run or we're low.
		boolean opening = tick - lastHitTick > 40;
		boolean fleeing = relativeSpeed(me, t) > 3;
		boolean low = me.getHealth() <= p.lowHealth;
		mode = !opening && !fleeing && !low && rand.chance(p.critRate) ? "crit" : "sprint";
	}

	private double relativeSpeed(LocalPlayer me, Player t) {
		Vec3 v = perc.velocity(t.getId(), tick);
		Vec3 away = new Vec3(t.getX() - me.getX(), 0, t.getZ() - me.getZ());
		double n = away.length();
		return n > 0 ? (v.x * away.x + v.z * away.z) / n : 0;
	}

	private static double[] angles(Vec3 from, Vec3 to) {
		Vec3 d = to.subtract(from);
		double yaw = Math.toDegrees(Math.atan2(-d.x, d.z));
		double pitch = -Math.toDegrees(Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z)));
		return new double[] {yaw, pitch};
	}

	private static double boxDistance(Vec3 p, AABB b) {
		double dx = Math.max(Math.max(b.minX - p.x, 0), p.x - b.maxX);
		double dy = Math.max(Math.max(b.minY - p.y, 0), p.y - b.maxY);
		double dz = Math.max(Math.max(b.minZ - p.z, 0), p.z - b.maxZ);
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	private void fight(LocalPlayer me, Player t) {
		double dt = 0.05;
		Vec3 eye = me.getEyePosition();

		// ---- aim, at where a person would perceive them
		Vec3 seen = perc.perceive(t, tick);
		double[] off = perc.aimOffset(t, dt);
		double fx = seen.x - me.getX();
		double fz = seen.z - me.getZ();
		double fd = Math.sqrt(fx * fx + fz * fz);
		Vec3 perp = fd > 1e-3 ? new Vec3(-fz / fd, 0, fx / fd) : Vec3.ZERO;
		Vec3 aimPt = seen.add(0, off[0], 0).add(perp.scale(off[1]));
		double[] want = angles(eye, aimPt);
		Vec3 vel = perc.velocity(t.getId(), tick - perc.reactionMs / 50);
		double[] ahead = angles(eye.add(me.getDeltaMovement()), aimPt.add(vel.scale(dt)));
		double rateYaw = Hand.wrap(ahead[0] - want[0]) / dt;
		double ratePitch = (ahead[1] - want[1]) / dt;
		if (tick < reactUntil) { // hasn't reacted to this target yet
			want = new double[] {hand.yaw, hand.pitch};
			rateYaw = ratePitch = 0;
		}
		double lazyR = Math.toDegrees(Math.atan2(t.getBbWidth() / 2, Math.max(0.5, eye.distanceTo(aimPt)))) * 0.8;
		hand.tick(dt, want[0], want[1], rateYaw, ratePitch, lazyR);

		// ---- facts about this tick
		boolean onTarget = mc.hitResult instanceof EntityHitResult ehr && ehr.getEntity() == t; // the crosshair is on them
		double reach = boxDistance(eye, t.getBoundingBox());
		double dist = Math.sqrt(Math.pow(t.getX() - me.getX(), 2) + Math.pow(t.getZ() - me.getZ(), 2));
		if (tick % 20 == 0) perc.refreshReaction();
		float period = me.getCurrentItemAttackStrengthDelay();
		float s = me.getAttackStrengthScale(0.5f);
		int ticksToFull = (int) Math.max(0, Math.ceil(period * 0.93 - s * period));
		Integer last = swings.get(t.getId());
		double opp = Rand.clamp((tick - (last == null ? -1000 : last)) / 12.5, 0, 1);
		holdSword(me);

		move(me, t, dist, ticksToFull, opp);
		attack(me, t, s, reach, onTarget);
	}

	private void move(LocalPlayer me, Player t, double dist, int ticksToFull, double opp) {
		boolean fwd = false, back = false, sprint = false, jump = false;
		if (dist > 3.4) {
			fwd = true;
			sprint = true;
			if (dist > 7 && me.onGround() && rand.chance(0.06)) jump = true; // sprint-jumping is faster
		} else {
			// Spacing: still on cooldown and they're ready? Step out of their reach.
			if (tick >= spacingCheckAt) {
				spacingCheckAt = tick + 4 + (int) rand.uniform(0, 4);
				if (ticksToFull > 4 && opp > 0.8 && dist < 3.1 && rand.chance(p.spacing)) retreatUntil = tick + Math.min(ticksToFull - 2, 6);
			}
			if (tick < retreatUntil) back = true;
			else if (dist < p.closeGap) back = dist < p.closeGap * 0.6; // don't walk into them, circle
			else { fwd = true; sprint = mode.equals("sprint") || dist > 3.0; }

			// Crit: jump so the hit lands on the way down, unsprinted.
			if (mode.equals("crit") && me.onGround() && ticksToFull <= 6 && dist < 3.6 && tick - critJumpTick > 12) {
				jump = true;
				critJumpTick = tick;
			}
			if (mode.equals("crit") && tick - critJumpTick < 14) sprint = false;
		}
		if (tick < wtapUntil) { fwd = false; sprint = false; }

		// Strafe around them, switching direction at irregular times.
		boolean left = false, right = false;
		if (dist < 5) {
			if (tick >= nextStrafeSwitch) {
				if (rand.chance(0.7)) strafeDir = -strafeDir;
				strafing = rand.chance(p.strafe);
				nextStrafeSwitch = tick + rand.ticks(p.strafeSwitchMs, p.strafeSwitchMs * 0.45, 4);
			}
			if (strafing) { if (strafeDir > 0) right = true; else left = true; }
		}
		if (me.horizontalCollision && me.onGround() && fwd) jump = true;

		// Don't walk off edges or into lava.
		double yaw = Math.toRadians(me.getYRot());
		Vec3 forward = new Vec3(-Math.sin(yaw), 0, Math.cos(yaw));
		Vec3 rightV = new Vec3(-Math.cos(yaw), 0, -Math.sin(yaw));
		if ((left || right) && !safe(me, rightV.scale(right ? 1 : -1))) { strafeDir = -strafeDir; left = right = false; }
		if (back && !safe(me, forward.scale(-1))) back = false;
		if (fwd && dist > 2 && !safe(me, forward)) fwd = false;

		keys.want(Keys.Key.FORWARD, fwd);
		keys.want(Keys.Key.BACK, back);
		keys.want(Keys.Key.LEFT, left);
		keys.want(Keys.Key.RIGHT, right);
		keys.want(Keys.Key.SPRINT, sprint);
		if (jump) { keys.want(Keys.Key.JUMP, true); jumpRelease = tick + 2; }
		else if (tick >= jumpRelease) keys.want(Keys.Key.JUMP, false);
	}

	private boolean safe(LocalPlayer me, Vec3 dir) {
		var level = mc.level;
		BlockPos at = BlockPos.containing(me.position().add(dir.scale(1.2)));
		for (int dy = 0; dy >= -1; dy--) {
			BlockState s = level.getBlockState(at.offset(0, dy, 0));
			if (s.getFluidState().is(FluidTags.LAVA) || s.is(Blocks.FIRE) || s.is(Blocks.CACTUS)) return false;
		}
		for (int dy = -1; dy >= -4; dy--) {
			BlockPos b = at.offset(0, dy, 0);
			BlockState s = level.getBlockState(b);
			if (!s.getCollisionShape(level, b).isEmpty() || s.getFluidState().is(FluidTags.WATER)) return true;
		}
		return false;
	}

	private void attack(LocalPlayer me, Player t, float s, double reach, boolean onTarget) {
		if (tick < reactUntil) { click = null; return; }

		if (click == null) {
			boolean falling = !me.onGround() && me.getDeltaMovement().y < -0.03;
			boolean sprinting = me.isSprinting();
			double perceivedReach = reach + rand.gaussian(0, 0.12);
			boolean inRange = perceivedReach <= Math.min(p.reach, 3.0);
			boolean want = false;
			boolean early = false;
			if (inRange && s >= 0.92) {
				if (mode.equals("crit")) {
					boolean stuckOnGround = me.onGround() && tick - critJumpTick > 14;
					want = (falling && !sprinting) || stuckOnGround;
				} else {
					want = true;
				}
			} else if (inRange && s >= 0.6 && s < 0.9 && rand.chance(p.earlyClickChance / 6)) {
				want = true; // impatient click
				early = true;
			}
			// Better players wait the extra moment until the crosshair is on them.
			if (want && !onTarget && rand.chance(p.aimDiscipline)) want = false;
			if (want) click = new Click(tick + rand.ticks(p.clickDelayMs, p.clickDelaySdMs, 0), early);
		}

		if (click == null || tick < click.at) return;
		Click c = click;
		click = null;
		if (reach > 3.8) return; // they were clearly gone; a person wouldn't click
		if (!onTarget && c.waited < 3 && rand.chance(p.aimDiscipline)) {
			// Hold the click a tick for the crosshair to get there.
			click = new Click(tick + 1, c.early);
			click.waited = c.waited + 1;
			return;
		}

		boolean crit = !me.onGround() && me.getDeltaMovement().y < 0 && !me.isSprinting() && s > 0.9;
		boolean sprintHit = me.isSprinting() && s > 0.9;
		keys.click(); // the game decides whether that hits: crosshair, reach, cooldown are all vanilla
		lastSwingTick = tick;
		if (!onTarget) { misses++; return; }
		lastHitTick = tick;
		hits++;
		if (crit) crits++;
		if (c.early) earlyHits++;
		if (sprintHit) {
			sprintHits++;
			if (rand.chance(p.wtapChance)) wtapUntil = tick + 1 + (int) rand.uniform(0, 3);
		}
		pickMode(me, t);
	}

	// If the sword isn't in hand, pick it from the hotbar after a human pause.
	private void holdSword(LocalPlayer me) {
		if (isWeapon(me.getMainHandItem())) { swapAt = -1; return; }
		var inv = me.getInventory();
		int slot = -1;
		for (int i = 0; i < 9; i++) if (isWeapon(inv.getItem(i))) { slot = i; break; }
		if (slot < 0 || slot == inv.getSelectedSlot()) { swapAt = -1; return; }
		if (swapAt < 0) swapAt = tick + rand.ticks(250, 80, 1);
		if (tick >= swapAt) { keys.tapHotbar(slot); swapAt = -1; }
	}

	private static boolean isWeapon(ItemStack it) {
		return !it.isEmpty() && (it.is(ItemTags.SWORDS) || it.is(ItemTags.AXES));
	}

	// ------------------------------------------------------------------ idle

	private void idle(LocalPlayer me) {
		for (Keys.Key k : Keys.Key.values()) keys.want(k, false);
		// Glance around now and then, like a waiting player moves the mouse.
		if (tick >= idleUntil) {
			idleYaw = hand.yaw + rand.gaussian(0, 35);
			idlePitch = Rand.clamp(rand.gaussian(3, 9), -35, 30);
			idleUntil = tick + rand.ticks(2500, 1200, 10);
		}
		hand.tick(0.05, idleYaw, idlePitch, 0, 0, 0);
		holdSword(me);
	}
}
