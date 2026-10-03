# Mimic PvP

A Minecraft Java sword PvP bot. It fights in diamond armor with a sword, plays only within what a vanilla client can do, and moves its mouse and keys like a person, so it holds up against anticheats like Grim.

Built on [mineflayer](https://github.com/PrismarineJS/mineflayer) for Minecraft **26.1**. Use it on your own server or servers that allow bots.

## Fight it yourself (arena)

The arena runs on your computer: a Paper 26.1 server with the Grim anticheat, a glass-walled flat arena, and the bot.

Needs: Node 20+, Java (21 or newer; Paper tells you if 26.1 needs newer), a Minecraft Java 26.1 client.

```bash
npm install
npm run arena:setup                      # downloads Paper + Grim, asks you to accept the Minecraft EULA
npm run arena:play -- --owner YourName   # starts the server and the bot
```

Join `localhost` from Minecraft and type in chat:

| Chat | What happens |
|---|---|
| `!duel` | Both get a fresh diamond kit and full health, you're placed on opposite sides, 3-2-1, fight |
| `!duel good` | Same, against a different skill profile (`casual`, `good`, `pro`) |
| `!stop` | Ends the round |
| `!score` | Rounds won |

After each round the arena prints the winner, the bot's hits, crits and accuracy, and every Grim flag raised on either of you. Any Grim flag on the bot is something to fix, so send those lines over.

The server listens on localhost only and runs in offline mode, so the bot can join without a Microsoft account. `npm run arena:setup -- --lan` opens it to your LAN instead; don't expose it to the internet.

## Real-client mode: the bot plays a real Minecraft window

Here the bot isn't a fake client at all. It plays a normal Minecraft window on a Windows PC, logged into its own account, and presses the keys and moves the mouse through Windows input (`SendInput`), just like a keyboard and mouse would. The game does all the movement, aiming and hitting, so everything the server sees comes from a real client.

To know where people are, a spectator connection (`MimicEyes`) watches the arena from above. Nothing in the game is modded.

```bash
npm run arena:setup -- --lan                        # lets your other computer join
npm run arena:play -- --owner YourName --client     # bot = whoever else joins first (or --client TheirName)
```

1. On the Windows PC, start Minecraft 26.1.x with your second account, join `localhost`, click into the window and press **F8**. That hands this one window to the bot; it never touches any other window. F8 again pauses it, and switching to another window lets go of every key.
2. On your other computer, join `<the PC's address>:25565` as `YourName` and type `!duel`.

It reads the keys and mouse sensitivity from that game's own `options.txt`. Use Hold (not Toggle) for sprint and sneak, keep Raw Input on, and turn off Pause on Lost Focus (F3+P).

Before each round the arena teleports the bot facing a known direction, so the bot knows exactly where its camera points and then counts every mouse step it sends from there. If the game ever drops mouse input (a menu was open), it re-syncs from the server's view of its head.

## Run it on another server

```bash
node src/index.js --host your.server --port 25565 --username Mimic --profile pro --owner YourName
```

Or copy `config.example.json` to `config.json` and run `npm start`.

| Flag | Meaning |
|---|---|
| `--profile casual\|good\|pro` | Skill level (see below) |
| `--owner Name` | Player allowed to give chat commands; never attacked outside a duel |
| `--target Name` | Fight only this player |
| `--auth microsoft` | For online-mode servers (default `offline`) |
| `--version` | Defaults to `26.1`. 26.2 servers need ViaBackwards until mineflayer supports 26.2 |

Chat commands from the owner: `!fight <name>`, `!stop`, `!auto on|off`, `!stats`. Without auto-targeting it still fights back against whoever hits it.

## How it plays

Sword and diamond armor only: no shield, no healing.

- **Full-charge hits**: it clicks a human delay after the 0.625 s sword cooldown fills, never spam-clicks, and switching items resets its charge.
- **Opener**: a sprint hit for knockback starts each exchange.
- **Crits**: while the opponent stands and trades, it jumps, stops sprinting, and hits on the way down for 1.5x damage.
- **Sprint hits + W-tap**: when the opponent runs or it's low, it sprint-hits again and taps W to keep them out of reach.
- **Spacing**: it reads the opponent's swing timing, steps out of reach while its own cooldown refills, and circles instead of walking into them.
- **Strafing**: irregular direction changes.
- **Hit selection**: it holds a click a tick or two until the crosshair is on them, since a whiff costs a full cooldown.
- **Armor**: equips the best armor when idle, only while standing still.

## What keeps it legit

- **Reach**: it only attacks when a ray from its eyes along its *actual* look direction hits the target's hitbox within 3.0 blocks with nothing in between. The rotation the server already has must agree too.
- **Mouse**: every rotation change is a whole number of mouse steps for a random realistic sensitivity. Aim is a spring-damper "wrist" with speed and acceleration caps, slight overshoot, tremor, and an aim point that wanders over the body.
- **Reaction**: it sees the target ~175–260 ms late and predicts their motion like a person, so it briefly loses a target who switches strafe direction.
- **Movement**: real physics only. Keys go through motor delay. It sends the same `player_input` packet a 26.x client sends. Sprint follows vanilla rules (forward held, food > 6). After a sprint hit it drops sprint and slows to 60% like the vanilla client.
- **No packet tricks**: no extra reach, keep-sprint, velocity cancel, timer or multi-hits.

## Profiles

| | casual | good | pro |
|---|---|---|---|
| Reaction | 260 ms | 210 ms | 175 ms |
| Peak flick speed | 600°/s | 900°/s | 1200°/s |
| Click delay after full charge | ~140 ms | ~85 ms | ~55 ms |
| Crit attempts | 35% | 60% | 80% |
| Waits for crosshair before clicking | 40% | 75% | 92% |

All values live in `src/config.js`. Override any in `config.json`, e.g. `{ "profile": "pro", "combat": { "critRate": 0.9 } }`.

## Tests

```bash
npm test                          # aim model check + arena RCON/log-parsing tests (no Minecraft needed)
npm run botfight -- 45 pro good   # bot vs bot on a local flying-squid server with a referee
```

The bot-vs-bot referee checks every hit server-side: reach, whether the last sent rotation points at the hitbox, time between hits, and mouse-step grid violations. flying-squid only speaks up to 1.21.x and has simplified combat, so it checks behavior and legality, not exact vanilla balance. Grim on the arena is the real anticheat test.

## Layout

```
src/index.js            entry point / CLI
src/config.js           profiles and defaults
src/human/aim.js        mouse model (spring-damper, caps, tremor, sensitivity grid)
src/human/perception.js reaction delay, motion prediction, aim-point wander
src/human/keys.js       key timing, sprint rules, player_input packet
src/combat/brain.js     targeting, movement, crits, sprint hits, spacing, duels
src/combat/items.js     weapon cooldowns and damage, armor ranking
src/combat/geometry.js  hitboxes, ray tests, angles
src/body/               real-client mode: Windows input, options.txt keys, the stand-in "bot"
arena/setup.js          downloads Paper + Grim, writes server config
arena/run.js            runs server + bot, !duel rounds, Grim flag report
arena/rcon.js           RCON client
arena/logparse.js       chat, death and Grim alert parsing
test/                   aim sim, arena unit tests, bot-vs-bot
```

## Known limits

- **Not run against Paper or Grim yet.** The build environment can't download Minecraft servers, so the first arena session is the first real-server test.
- **Physics drift**: mineflayer's physics may differ slightly from vanilla 26.1 in edge cases. Grim's movement simulation would flag that, and the arena will show it.
- **Hitbox timing**: in bot-vs-bot, about 1 in 10 hits fell just outside the target's hitbox from the server's point of view, because the target moved between ticks. Grim allows for this movement, but it's the first thing to watch in the flag report.
- **Terrain**: chasing is straight-line with jump-over-obstacles, not pathfinding. Fine for arenas.
