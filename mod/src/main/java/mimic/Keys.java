package mimic;

import java.util.EnumMap;
import java.util.Map;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;

/**
 * The keyboard and mouse buttons. Keys go through the same calls the game's
 * own keyboard handler makes when a real key goes down or up, on whatever key
 * the player has bound, and each change happens a human motor delay after the
 * brain decides it.
 */
final class Keys {
	enum Key { FORWARD, BACK, LEFT, RIGHT, JUMP, SPRINT, SNEAK }

	private record Pending(boolean state, int at) {}

	private final Profile p;
	private final Rand rand;
	private final Map<Key, Boolean> wanted = new EnumMap<>(Key.class);
	private final Map<Key, Pending> pending = new EnumMap<>(Key.class);
	private final Map<Key, Boolean> held = new EnumMap<>(Key.class);
	private int tick;
	private int attackUpAt = -1;
	private KeyMapping tapped;
	private int tapUpAt = -1;

	Keys(Profile p, Rand rand) {
		this.p = p;
		this.rand = rand;
		for (Key k : Key.values()) { wanted.put(k, false); held.put(k, false); }
	}

	private static KeyMapping mapping(Key k) {
		var o = Minecraft.getInstance().options;
		return switch (k) {
			case FORWARD -> o.keyUp;
			case BACK -> o.keyDown;
			case LEFT -> o.keyLeft;
			case RIGHT -> o.keyRight;
			case JUMP -> o.keyJump;
			case SPRINT -> o.keySprint;
			case SNEAK -> o.keyShift;
		};
	}

	private static void press(KeyMapping m, boolean down) {
		InputConstants.Key key = KeyMappingHelper.getBoundKeyOf(m);
		KeyMapping.set(key, down);
		if (down) KeyMapping.click(key);
	}

	void want(Key k, boolean state) {
		Pending pd = pending.get(k);
		if (pd != null ? pd.state == state : wanted.get(k) == state) return;
		// Changed its mind before the finger moved: nothing to do.
		if (held.get(k) == state) { pending.remove(k); wanted.put(k, state); return; }
		pending.put(k, new Pending(state, tick + rand.ticks(p.keyDelayMs, p.keyDelaySdMs, 0)));
		wanted.put(k, state);
	}

	boolean held(Key k) { return held.get(k); }

	/** One left click: down now, up a finger's hold later. */
	void click() {
		press(Minecraft.getInstance().options.keyAttack, true);
		attackUpAt = tick + (rand.chance(0.6) ? 1 : 2);
	}

	/** Tap a hotbar number key. */
	void tapHotbar(int slot) {
		tapped = Minecraft.getInstance().options.keyHotbarSlots[slot];
		press(tapped, true);
		tapUpAt = tick + 1;
	}

	/** Called once per client tick, before the game reads its keys. */
	void update() {
		tick++;
		for (Key k : Key.values()) {
			Pending pd = pending.get(k);
			if (pd != null && pd.at <= tick) { held.put(k, pd.state); pending.remove(k); }
			// Re-assert every tick: opening a menu or a real key event may have changed it.
			KeyMapping m = mapping(k);
			if (m.isDown() != held.get(k)) press(m, held.get(k));
		}
		if (attackUpAt >= 0 && tick >= attackUpAt) { press(Minecraft.getInstance().options.keyAttack, false); attackUpAt = -1; }
		if (tapped != null && tick >= tapUpAt) { press(tapped, false); tapped = null; }
	}

	void releaseAll() {
		pending.clear();
		for (Key k : Key.values()) {
			wanted.put(k, false);
			if (held.get(k)) press(mapping(k), false);
			held.put(k, false);
		}
		if (attackUpAt >= 0) { press(Minecraft.getInstance().options.keyAttack, false); attackUpAt = -1; }
	}
}
