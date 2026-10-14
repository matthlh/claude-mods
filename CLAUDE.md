# claude-mods

One marketplace (`matthlh`), three Claude Code plugins under `plugins/`: `pixel-cat` and `token-tycoon` are mods (function-hook plugins that draw above the prompt), `purple-dark` is a theme.

## Rules

- Never rename the marketplace (`matthlh`) or a plugin (`pixel-cat`, `token-tycoon`, `purple-dark`). Users' installs and saved data are keyed on `<plugin>@matthlh`.
- Move files with plain `git mv` commits, content edits in separate commits, so rename detection carries other branches across.
- Don't add a `CLAUDE.md` inside a plugin folder; the validator warns and it isn't loaded. This file is the only one.
- Plain commit messages, no attribution trailers.
- Bump `version` in a plugin's `plugin.json` with every change that should reach installs. The version pins the install: `claude plugin update` says "already at the latest version" and fetches nothing until it changes.

## Branches

`main` only moves by pull request. Each mod has a long-lived branch of its own, `pixel-cat`, `token-tycoon` and `purple-dark`, and work on a mod goes there:

```bash
git checkout pixel-cat && git merge --ff-only origin/main   # start level with main
# ...commit...
git push && gh pr create --base main --head pixel-cat
```

After the PR merges, fast-forward the mod branch to `main` again before the next change. A change that touches two mods at once (the ↻ switcher was one) gets a topic branch and one PR. Bump the plugin's `version` in the same PR.

## Check a change

Use the Claude Code binary bundled with the desktop app (the `claude` on PATH may be too old for mods):

```bash
CLAUDE="$HOME/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude"
"$CLAUDE" plugin validate .                        # the marketplace
"$CLAUDE" plugin validate plugins/pixel-cat        # one plugin
"$CLAUDE" plugin test plugins/pixel-cat            # its tests
npx -p typescript tsc -p plugins/pixel-cat         # type-check (needs .claude-plugin/types/, written when Claude Code loads the mod)
```

Try a plugin in a session with `claude --plugin-dir plugins/<name>` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. A headless check: `claude -p ok --plugin-dir plugins/<name> --debug-file /tmp/d.log`, then grep the log for `hooks module <name>@inline loaded`.

## Layout

- `.claude-plugin/marketplace.json`: the catalog, sources `./plugins/<name>`.
- `plugins/<name>/.claude-plugin/plugin.json`: the plugin manifest. `.claude-plugin/types/` is generated and ignored.
- `plugins/pixel-cat/hooks/engine/` is the lane machinery, `hooks/packs/<pack>/` is one character each (cat, adventurer). See its README for how to add a pack.
- `plugins/purple-dark/themes/purple-dark.json` is the theme; plugin themes are read-only, shown in `/theme` under the file's `name`.

## How the mods talk to each other

Plugins can read each other's `$.state` but never write it, so the mods coordinate through slash commands run with `$.command.run` (a plugin's call goes through every other plugin's `command.run` hooks):

- `pixel-cat` owns the ↻ switcher (`/mods`, `prefs.mode`: `hero`, `tycoon` or `off`). It finds Token Tycoon by looking for a registered `tycoon` command, and drives it with `/tycoon on` or `/tycoon off`.
- `token-tycoon` answers `/tycoon` (remembered in `prefs.shown`) and its own ↻ runs `/mods off` when a `mods` command exists, else just hides itself.

Keep those two command names and their `on`/`off` arguments stable; each mod must also work with the other absent. In tests, a catch-all `command.run` hook is skipped for calls made from inside a run it is part of, so match the hook to the command you want to observe.
