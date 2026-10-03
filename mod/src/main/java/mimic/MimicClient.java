package mimic;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import org.lwjgl.glfw.GLFW;

/**
 * Mimic PvP: a sword PvP bot that plays this Minecraft client the way a
 * person does, through its keys and mouse. F8 turns it on and off.
 *
 * The arena server steers rounds with system messages starting "mimic:"
 * (only the server can send those; they're hidden from chat):
 *   mimic:duel <name> [casual|good|pro]   fight this player
 *   mimic:end                              stop and post hit stats in chat
 */
public class MimicClient implements ClientModInitializer {
	private static final KeyMapping.Category CATEGORY = KeyMapping.Category.register(Identifier.fromNamespaceAndPath("mimic", "mimic"));
	private static KeyMapping toggle;
	private static Brain brain;
	private static boolean enabled;

	@Override
	public void onInitializeClient() {
		toggle = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.mimic.toggle", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F8, CATEGORY));
		brain = new Brain(Profile.of("pro"));

		ClientTickEvents.START_CLIENT_TICK.register(mc -> {
			while (toggle.consumeClick()) {
				enabled = !enabled;
				say(enabled ? "on (" + brain.p.name + "). F8 turns it off." : "off.");
			}
			brain.tick(enabled);
		});

		ClientReceiveMessageEvents.ALLOW_GAME.register((message, overlay) -> {
			String text = message.getString();
			if (overlay || !text.startsWith("mimic:")) return true;
			order(text.substring(6).trim().split("\\s+"));
			return false;
		});
	}

	private static void order(String[] a) {
		switch (a[0]) {
			case "duel" -> {
				if (a.length > 2) {
					Profile p = Profile.of(a[2]);
					if (p != null && !p.name.equals(brain.p.name)) brain.setProfile(p);
				}
				brain.resetStats();
				brain.duel(a.length > 1 ? a[1] : null);
				if (!enabled) say("a duel started but Mimic is off. Press F8 in this window.");
			}
			case "end" -> {
				String line = brain.statLine();
				brain.endDuel();
				var player = Minecraft.getInstance().player;
				if (player != null) player.connection.sendChat("[Mimic " + brain.p.name + "] " + line);
			}
			default -> { }
		}
	}

	public static void onFrame(net.minecraft.client.MouseHandler mouse) {
		if (brain != null) brain.onFrame((mimic.mixin.MouseHandlerAccessor) mouse);
	}

	private static void say(String text) {
		Minecraft.getInstance().gui.getChat().addClientSystemMessage(Component.literal("[Mimic] " + text));
	}
}
