# Claude Code mods by matthlh

Three mods for [Claude Code](https://claude.com/claude-code), served from one plugin marketplace: a pixel cat and an idle game that live above the prompt, and a purple theme.

| Plugin | What it is |
| --- | --- |
| [`pixel-cat`](plugins/pixel-cat) | A little pixel cat that wanders above the prompt, watches your usage limits and announces when work finishes. Not a cat person? Switch packs and an adventurer mines, chops trees and fights zombies there instead |
| [`token-tycoon`](plugins/token-tycoon) | A Claude-themed idle game: prompt to earn tokens, hire agents, upgrade models and infra, and earn from your real Claude Code usage |
| [`purple-dark`](plugins/purple-dark) | A purple dark colour theme |

## Install

You need a Claude Code version that supports mods (October 2026 or later). The same steps work on macOS, Linux and Windows, in the terminal and in the desktop app. At the Claude Code prompt, add the marketplace once, then install what you want:

```
/plugin marketplace add matthlh/claude-mods
/plugin install pixel-cat@matthlh
/plugin install token-tycoon@matthlh
/plugin install purple-dark@matthlh
```

Or from a shell:

```bash
claude plugin marketplace add matthlh/claude-mods
claude plugin install pixel-cat@matthlh
```

Two things to know:

- **Mods need function hooks.** They're still rolling out, so if nothing shows up above the prompt, add `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` to the `env` block of `~/.claude/settings.json`:

  ```json
  {
    "env": {
      "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
    }
  }
  ```

- **Restart after changing settings.** Sessions already open pick up a new plugin or env change only after a restart. In the desktop app, quit it fully (⌘Q), not just the window.

The theme needs no env flag: after installing `purple-dark`, pick **Purple Dark** in `/theme`.

Update a mod with `claude plugin update <name>@matthlh`, remove it with `claude plugin uninstall <name>@matthlh`.

## Switching between them

You don't have to remember any commands. The cat's band has a **↻** button that walks a loop: **Cat → Adventurer → Token Tycoon → Off → Cat**, and the label always says where the next press goes. On Token Tycoon's turn the cat steps aside and the game's band gets a **↻ Off** of its own; on Off, all that's left is a one-line **↻ Cat** strip to come back from. The stop is remembered, so a new session opens where you left it.

The same loop as commands, for when you'd rather type: `/mods` moves to the next stop, `/mods cat`, `/mods adventurer`, `/mods tycoon` or `/mods off` picks one. `/cat` and `/tycoon` show or hide one mod for this session without touching the loop, and `/idle` opens the Token Tycoon shop.

The theme isn't part of the loop: pick **Purple Dark** in `/theme` once and it stays.

## The mods

### Pixel Cat 🐱

![Claude cat poses: walk, walk 2, sit, happy, sleep](plugins/pixel-cat/docs/preview.svg)

Wanders back and forth above the prompt, works alongside Claude with a prop for each tool, announces when a turn finishes, tracks your 5-hour, 7-day and context limits, plays when you're idle and goes to bed on its perch when you're away. Coats, scenes, hats to unlock, and `/cat` to toggle it.

Everything the hero is and does comes from a **pack**, switched from ⚙ → Pack. The **Adventurer** pack swaps the cat for a Terraria-style hero who mines ore, chops trees, builds walls and staircases, crafts at a workbench and fights zombies and slimes, in a world that goes dark at night:

![The adventurer mining, chopping, building, crafting, fighting a zombie and a slime, working and asleep](plugins/pixel-cat/docs/adventurer-preview.svg)

The Adventurer pack is fan-made and inspired by Terraria. It is not affiliated with or endorsed by Re-Logic, and Terraria is a trademark of Re-Logic. All of its pixel art is original.

[Read more](plugins/pixel-cat/README.md), including how to make your own pack.

### Token Tycoon 🤖

![The coder and the token: idle, a prompt landing, a crit, a frenzy](plugins/token-tycoon/docs/preview.svg)

Cookie Clicker, but the cookie is a token. Prompt ⚡ to earn, hire agents that earn per second, upgrade models and infra, and let your real Claude Code work count: every tool call is a free prompt and every finished turn starts a frenzy. `/idle` opens the shop. [Read more](plugins/token-tycoon/README.md).

### Purple Dark 💜

![Purple Dark: the prompt box, a user message and Claude's label in the theme colours](plugins/purple-dark/docs/preview.svg)

A purple take on the dark theme: lavender accent, violet borders, deep purple message backgrounds. [Read more](plugins/purple-dark/README.md).

## Run from a clone

To change a mod, run your own copy instead of the marketplace install:

```bash
git clone https://github.com/matthlh/claude-mods ~/.claude/mods/claude-mods
claude --plugin-dir ~/.claude/mods/claude-mods/plugins/pixel-cat
```

To load it in every session, including the desktop app, put the plugin folder's full path in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/.claude/mods/claude-mods/plugins/pixel-cat",
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

| OS | Path | Separator for several folders |
| --- | --- | --- |
| macOS | `/Users/<you>/.claude/mods/claude-mods/plugins/pixel-cat` | `:` |
| Linux | `/home/<you>/.claude/mods/claude-mods/plugins/pixel-cat` | `:` |
| Windows | `C:\\Users\\<you>\\.claude\\mods\\claude-mods\\plugins\\pixel-cat` (JSON needs the doubled `\\`) | `;` |

Write the full path. Older versions don't expand `~` here, so a `~` path silently loads nothing. Don't run a clone and the marketplace install of the same mod at once.

## Develop

Each mod is a plugin of function hooks under `plugins/<name>/`, with its tests beside it. Check a change with:

```bash
claude plugin validate .                       # the marketplace
claude plugin validate plugins/pixel-cat       # one plugin
claude plugin test plugins/pixel-cat           # its tests
```

In an interactive session that loads the clone, saving a hooks file hot-reloads the mod.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per plugin
plugins/pixel-cat/                hooks (engine + packs), tests, types, docs, README
plugins/token-tycoon/             hooks, tests, types, docs, README
plugins/purple-dark/              themes/purple-dark.json, docs, README
```

## License

MIT
