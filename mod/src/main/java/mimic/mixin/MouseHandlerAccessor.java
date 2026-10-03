package mimic.mixin;

import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** The mouse movement the game has collected since the last frame; the bot's hand adds to it like a real mouse does. */
@Mixin(MouseHandler.class)
public interface MouseHandlerAccessor {
	@Accessor("accumulatedDX")
	double mimic$getAccumulatedDX();

	@Accessor("accumulatedDX")
	void mimic$setAccumulatedDX(double dx);

	@Accessor("accumulatedDY")
	double mimic$getAccumulatedDY();

	@Accessor("accumulatedDY")
	void mimic$setAccumulatedDY(double dy);
}
