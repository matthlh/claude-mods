# Limit Note ⏳

When your Claude subscription reaches 99% of its 5-hour or weekly limit, Limit Note sends a push to your phone with a status text ready to paste:

> Out of Claude limits, ping me at 3:40 pm PT

The time is when the limit resets, in Pacific time, with the weekday when it is not today ("ping me Tue at 9 am PT"). Tapping the push opens Instagram's inbox, where you set it as your Note. The text stays under 60 characters, so it fits a Note.

It spends no tokens. Claude Code already measures your limits after every reply, and Limit Note only reads those numbers; it never calls the model.

## Set up

1. Install it: `/plugin install limit-note@matthlh` (the marketplace and the function-hooks flag are in the [main README](../../README.md#install)).
2. Run `/limit-note setup`. It writes `~/.config/limit-note/config.json` (readable only by you) with a long random [ntfy](https://ntfy.sh) topic and prints the topic.
3. Install the ntfy app on your phone and subscribe to that topic on `ntfy.sh`.
4. Run `/limit-note test`. A test push should arrive within a few seconds. It uses a made-up 99% reading, so it does not touch your real limits or hold back a real alert.

Anyone who knows the topic can read or send to it, so keep it out of anything public.

## Commands

| Command | What it does |
| --- | --- |
| `/limit-note` or `/limit-note status` | Shows the topic, your live limit readings, and which alerts were already sent |
| `/limit-note setup` | Writes the config with a fresh topic, unless one exists |
| `/limit-note test` | Sends a test push; `/limit-note test github` also sets a GitHub status that clears in 2 minutes |

## When it fires

- It fires when a 5-hour or weekly reading is at 99% or more. A burst of replies can jump straight from 98 to 100, so it never waits for exactly 99.
- The time in the text is the latest reset among the limits that are full.
- It skips a reading whose reset is less than 10 minutes away or already past. A session that sat idle while you used claude.ai can hold an old reading.
- If a full limit gave no reset time, the text is "Out of Claude limits, ping me later".
- It fires once per limit window across every open Claude Code session. Sessions share a lock folder and a record of what was sent under `~/.config/limit-note/`. When the weekly limit fills after the 5-hour one, you get a second push with the later time.
- A push that fails (no network, say) is not recorded, so the next reading tries again.

## Config

`~/.config/limit-note/config.json`:

| Field | Default | Meaning |
| --- | --- | --- |
| `topic` | random | The ntfy topic the push goes to |
| `server` | `https://ntfy.sh` | Your own ntfy server, if you run one |
| `click` | `instagram://direct-inbox` | What tapping the push opens |
| `threshold` | `99` | The percentage that sets it off |
| `github` | `false` | Also set the text as your GitHub status |
| `gh` | `/opt/homebrew/bin/gh` | Where the GitHub CLI is; Claude Code's PATH may not include Homebrew |

## GitHub status

Set `"github": true` to also set the text as your GitHub status, through `gh api graphql`. The status expires when the limit resets, so it clears itself. The GitHub CLI needs the `user` scope for this, which a default login does not have. Run this once yourself:

```bash
gh auth refresh -s user
```

Then check it with `/limit-note test github`.

## Develop

```bash
claude plugin validate plugins/limit-note
claude plugin test plugins/limit-note
```

The tests run the plugin against a fake machine (files, the lock folder, curl and gh) in `tests/host.ts`.
