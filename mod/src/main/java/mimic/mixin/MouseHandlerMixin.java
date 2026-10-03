package mimic.mixin;

import mimic.MimicClient;
import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Each frame, before the game turns the camera, the bot's hand adds the mouse counts due by now. */
@Mixin(MouseHandler.class)
public abstract class MouseHandlerMixin {
	@Inject(method = "handleAccumulatedMovement", at = @At("HEAD"))
	private void mimic$frame(CallbackInfo ci) {
		MimicClient.onFrame((MouseHandler) (Object) this);
	}
}
