# Limit Note ⏳

When your Claude subscription reaches 99% of its 5-hour or weekly limit, Limit Note puts up a status text:

> Out of Claude limits, ping me at 3:40 pm PT

The time is when the limit resets, in Pacific time, with the weekday when it is not today ("ping me Tue at 9 am PT"). The text stays under 60 characters, so it fits an Instagram Note.

Turned on, it posts that text as your Instagram Note by itself, through instagram.com in a Chrome profile of its own, and a push to your phone says the Note is up. Left off, the push carries the text and tapping it opens Instagram's inbox.

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
| `/limit-note instagram-login` | Opens the Chrome profile the Instagram auto-post uses, for you to sign in once |
| `/limit-note test instagram` | Goes as far as the Note composer and stops before Share; `/limit-note test instagram live` posts for real |

## When it fires

- It fires when a 5-hour or weekly reading is at 99% or more. A burst of replies can jump straight from 98 to 100, so it never waits for exactly 99.
- The time in the text is the latest reset among the limits that are full.
- It skips a reading whose reset is less than 10 minutes away or already past. A session that sat idle while you used claude.ai can hold an old reading.
- If a full limit gave no reset time, the text is "Out of Claude limits, ping me later".
- It fires once per limit window across every open Claude Code session. Sessions share a lock folder and a record of what was sent under `~/.config/limit-note/`. When the weekly limit fills after the 5-hour one, you get a second push with the later time.
- A push that fails (no network, say) is not recorded, so the next reading tries again. A Note that went up counts as delivered even when its push was lost.

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
| `instagram` | `false` | Post the text as your Instagram Note by itself |
| `node` | `/opt/homebrew/bin/node` | The Node.js (18 or newer) that runs the Instagram script |
| `chrome` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | The Chrome it drives |

## Instagram auto-post

Instagram has no official way for an app to set a Note, so this drives instagram.com the way you would. It breaks Instagram's terms of use, Instagram may ask the account for a security check, and it stops working when Instagram changes the page. Every failure falls back to the push, which then carries the text and the reason.

1. Run `/limit-note instagram-login`. A Chrome window opens at Instagram in a profile kept for this alone, in `~/.config/limit-note/chrome-profile` (readable only by you). Sign in there yourself, then quit that Chrome with ⌘Q; closing the window alone leaves it running and holding the profile. Limit Note never types a password or answers a security check.
2. Set `"instagram": true` in the config.
3. Run `/limit-note test instagram`. It opens your inbox in a hidden Chrome, presses "Your note", types the text and stops before Share, then lists each step. Nothing is posted.
4. When you want to see a real post, run `/limit-note test instagram live`. It posts the test text as your Note; delete it in Instagram afterwards if you like.

The Note goes to Instagram's default audience, "followers you follow back"; Limit Note never changes it. On the web the composer sits in the inbox page itself: pressing the "Your note" bubble opens a "What's new..." box with a Share button.

At 99%, the post runs in a headless Chrome with no window, takes about 10 to 30 seconds, and closes when done. Chrome is driven over the DevTools protocol on a pipe, so no debugging port is opened, and the script needs no packages. If you are signed out or Instagram shows a security check, the push says so; run `/limit-note instagram-login` again and sign in.

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

The tests run the plugin against a fake machine (files, the lock folder, curl, gh and the Instagram script) in `tests/host.ts`. `scripts/instagram-note.mjs` is a plain Node script: `node scripts/instagram-note.mjs post --dry-run --chrome <path> --profile <dir> --text <note>` runs it on its own.
