# dsh-archive-keeper

> English | [中文](README.md)

Archiving a session in DSH only flips a flag — it never touches the disk. Over time,
`$DSH_HOME/sessions/` piles up with raw transcripts you will never open again.

This plugin **automatically condenses archived sessions into structured digests**, and adds an
"Archive Keeper" panel to the conversation header so you can decide, one by one, what to keep —
and **every deletion goes to a trash folder first, fully recoverable**.

> Ships with all runtime code included. Installs and runs standalone.

---

## Features

### 1. Auto-digest after archiving

Watches the archived-session list. As soon as a new session is archived, it runs the digest
pipeline and compresses the whole session into structured notes:

summary / decisions / facts / deliverables / open threads / obsolete items, plus a
"worth keeping" judgement.

### 2. You decide what stays

Inside the "Archive Keeper" panel, every archived session is an expandable card:

| Option | Meaning |
| --- | --- |
| **Keep original** | Deletes nothing |
| **Summary only** | Deletes the transcript, keeps the digest |
| **Delete entirely** | Moves both transcript and digest to trash |
| **Restore original** | Moves a previously trashed transcript back |

### 3. Grouped by time and label

Sessions are grouped in four levels — **year → date → part of day → label**:

- Year and date: newest first (oldest at the bottom)
- Part of day: **morning / afternoon / evening** (< 12:00 / 12:00–17:59 / ≥ 18:00)
- Label: defined by you in the gear panel; unlabeled sessions fall under "Uncategorized"

### 4. Customize what counts as "worth keeping"

Click the **⚙** button to open the personalization panel:

- **Labels** — a set of built-in common labels (Important / Environment fact / User preference /
  Lesson / Follow-up / Reusable / Project / Idea), plus your own. Label any session manually.
- **Admission rules** — combine conditions on **keywords / category / user-turn range**
  (multiple conditions are AND-ed). **Sessions matching a rule are admitted to "worth keeping"
  first**; only when nothing matches does it fall back to the default judgement.
- **Auto-labeling** — applies labels only, never changes admission.

### 5. Trash

Everything deleted (transcripts and digests) is moved to `trash/` first. The panel shows trash
usage, and you can restore individual items or empty it.

### 6. Live counters

Next to the "Archive Keeper" button in the conversation header you will see four numbers:

```
归档总数 19 · 已提炼 17 · 无法提炼 2 · 待提炼 0
(19 archived · 17 digested · 2 unprocessable · 0 pending)
```

They are always self-consistent (`archived = digested + unprocessable + pending`) and they track
**which archived sessions still exist right now**:

- Un-archive a session → the archived count drops immediately
- A digest file is deleted → the digested count drops and pending rises
- The source session file is gone from disk, or extraction definitively failed → counted as
  "unprocessable" and never retried automatically
- While a run is in progress, `· 提炼中…` (extracting) is appended

---

## Changelog

### v1.2.0

**Three bugs fixed, plus one hidden crash:**

1. **Already-processed sessions are no longer retried forever.**
   Some sessions can **never** be extracted — the source file was deleted from disk (`missing`), or
   extraction genuinely failed (`error`). The old rule was "anything that isn't `ok` is pending", so
   these dead entries were **re-selected on every run**, the pending count never reached zero, and
   the UI looked frozen. They are now marked **terminal** and skipped:

   - Their count is shown separately as "unprocessable", no longer mixed into "pending"
   - Every run states how many were skipped and why
   - To retry on purpose, pass `--retry-failed` (CLI); there is no automatic retry

2. **Extraction log is now written to disk.**
   `state/keeper.log` records each run, each session's outcome, skip reasons, and the tail of the
   output when the child process exits abnormally. No more reproducing by hand to debug.
   The log rotates automatically past 1 MB, keeping the last 2000 lines.

3. **Truncated model output no longer wastes a whole run.**
   Model replies are occasionally cut off by the length limit — a missing `}`, half an array — and
   `JSON.parse` then fails, marking the session as `error`. Now the incomplete JSON is **repaired and
   re-parsed**: whatever fields can be recovered are kept (e.g. the summary and the key points listed
   so far), and only genuinely unrecoverable output fails.
   > Bailing out is deliberate in one case: if the truncation lands in the middle of a string value,
   > stitching it back together yields a half-sentence summary, which misleads more than having none —
   > so that case is always rejected.

4. **Fixed a hidden `ReferenceError` in `extract.cjs`.**
   When session metadata was missing it threw `file is not defined` (`file` is another function's
   parameter and not in that scope), guaranteeing failure for that session. Real sessions carry the
   id at the top level of the event, so the path was never hit in practice — the worst kind of bug:
   unavoidable when triggered, and very hard to trace. Fixed as well.

### v1.1.0

**Two bugs fixed:**

1. **Clicking "Re-extract" after a run finished could freeze the UI.**
   The host route reported "started" whether or not extraction had actually begun, so the client
   waited forever; and the button neither greyed out nor blocked repeat clicks during a run. Now:

   - During extraction the button reads "提炼中…" and is disabled; clicking it does nothing
   - The host truthfully reports whether a run actually started, and the client reports accordingly
   - Polling speeds up while a run is in progress and the button recovers as soon as it finishes

2. **The archived / digested counters only ever accumulated history.**
   Both numbers were derived from the all-time processed-session record, so they only grew and
   could disagree with the visible list. They are now **live counts** based on the current archive
   list, updating immediately when you un-archive a session or delete a digest.

### v1.0.0

First stable release.

---

## Install

Three options — pick any one.

### Option 1: install straight from GitHub (recommended)

```bash
npm i github:Isle-ux/dsh-archive-keeper-plugin
```

### Option 2: download the tarball from Releases

Grab `dsh-archive-keeper-<version>.tgz` from the
[Releases](https://github.com/Isle-ux/dsh-archive-keeper-plugin/releases) page, then install it
locally:

```bash
npm i ./dsh-archive-keeper-1.2.0.tgz
```

Each release also ships a `.sha256` checksum so you can confirm the download is intact:

```bash
sha256sum -c dsh-archive-keeper-1.2.0.tgz.sha256        # Linux / macOS
certutil -hashfile dsh-archive-keeper-1.2.0.tgz SHA256  # Windows
```

### Option 3: clone the source

```bash
git clone https://github.com/Isle-ux/dsh-archive-keeper-plugin.git
```

---

Then add the plugin to your profile's `dsh.profile.bundles` (or however your DSH version loads
plugins). This package **bundles all runtime code** — no extra dependencies to install.

### Compatibility

- **Developed and verified against DSH `0.2.0-rc.2`** (desktop / Windows 11). The plugin passes
  full verification on that version.
- **Desktop / web only.** The client half registers into the
  `conversation.session.header.utilities` slot, which only hosts with a conversation view
  declare. In headless, TUI and similar hosts the plugin simply does not activate.
- Requires Node.js ≥ 20.
- The digest step calls a model, so you need a working model route configured in DSH.

> ⚠️ This plugin was developed against DSH `0.2.0-rc.2`. If your DSH version has
> different requirements for plugin manifests (e.g. the `dsh.client` field format), you may need
> to adjust `package.json` for your version.

### Compatibility with other plugins

**Short answer: this plugin does not conflict with other plugins.** The reason is that DSH's slot
mechanism is built for coexistence — here are the exact boundaries, and the single case that
would actually break.

**① The slot is a *list*, designed for side-by-side entries**

`conversation.session.header.utilities` is a `kind: "list"` slot, meaning it accepts **multiple**
registrations and renders them in `priority` → `order` sequence. It is not an exclusive
"one-plugin-only" seat.

**The only way to conflict** is if another plugin registers into the **same slot with an identical
`id` *and* the same `priority`**. In that case DSH throws outright:

```
list slot "..." already has an entry with id "..." (registered by ...)
```

This plugin's ids are namespaced, so they will not collide with common plugins. In practice this
case does not arise.

**② You do not have to choose between this plugin and your other plugins**

If your DSH also has other plugins that add buttons to the conversation header (usage stats, model
switchers, and so on), they render **alongside** Archive Keeper rather than replacing it. The
author's machine runs 12 plugins at once (several with client-side UI), and there is no
registration conflict on this plugin's slot.

**③ One known slot conflict, unrelated to this plugin (for reference)**

On the author's machine, `@ychris12138/dsh-usage-stats` and `@changfenhuang/dsh-genui` both
register into `panel.badge`. That is between those two plugins and has nothing to do with Archive
Keeper — it is mentioned only as an example of what a slot conflict looks like.

**④ What I cannot guarantee (stated honestly)**

- **Slot names may differ across DSH versions.** `conversation.session.header.utilities` is the
  slot name in DSH `0.2.0-rc.2`. If your DSH version does not declare that slot,
  the client half will **not error — it simply will not appear**. The host half (digesting, routes,
  trash) keeps working regardless.
- **This plugin has not been tested across all DSH versions.** It was verified only on DSH
  `0.2.0-rc.2` (Windows 11 desktop) — full 12-plugin stack, real browser, 0 errors. If you hit a
  problem, please open an Issue with your DSH version number.
- **No version constraint is declared.** I could not find official DSH plugin-spec documentation,
  so `package.json` carries no `dsh` version range. If loading fails on your version, it is most
  likely a manifest field difference — adjust it for your version.

---

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `root` | `<home>\Documents\deepseek-harness\archive-keeper` | User data root (digests, choices, trash) |
| `pollMs` | `30000` | Archive list polling interval in milliseconds |

> `root` points at **your data directory**, independent of where the plugin is installed.
> Upgrading or reinstalling the plugin will not touch existing data.

---

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/archive-keeper/list` | All digests + your choices + whether the transcript still exists |
| POST | `/archive-keeper/decide` | Record keep / summary-only / restore |
| POST | `/archive-keeper/run` | Run an incremental digest pass now |
| GET | `/archive-keeper/customize` | Read labels and rules |
| POST | `/archive-keeper/tag` | Add/remove labels, label sessions manually |
| POST | `/archive-keeper/rule` | Add/update/remove admission and auto-label rules |

---

## Safety boundaries (important)

- **This plugin never deletes anything automatically.** Deletion only happens after you click it
  explicitly and confirm a second time.
- Deletion is a **move** to `trash/<session-id>__<timestamp>/`, not an erase. You can move it back.
- Every cleanup is logged to `state/purge-log.json` (original path, destination, byte size).
- **Emptying the trash is the only irreversible action**, and it double-confirms before removing
  digests along with transcripts.

---

## Layout

### Plugin package

```
dsh-archive-keeper/
  lib/index.js       Host half: archive watcher + HTTP routes
  lib/client.js      Browser half: the "Archive Keeper" panel
  lib/state.cjs      State machine / exclusive lock / digest I/O
  lib/keeper.cjs     Main flow: scan -> extract -> model digest -> persist
  lib/extract.cjs    Session file parsing (multi-frame zstd + thread extraction)
  lib/decisions.cjs  Keep/delete choices, trash, permanent delete
  lib/tags.cjs       Labels and custom value rules
  cordis.patch.yml   Bundle patch (inserts only its own row)
```

### User data directory (where `root` points)

```
archive-keeper/
  digests/<session-id>.json   Structured digest per archived session
  state/state.json            Processed-session record
  state/decisions.json        Your choices
  state/tags.json             Labels and rules (created on first customization)
  state/latest.json           Report from the most recent run
  state/purge-log.json        Cleanup log
  trash/<session-id>__<ts>/   Trashed transcripts (recoverable)
```

---

## CLI (without the UI)

```bash
node lib/keeper.cjs            # incremental digest of new archives
node lib/keeper.cjs --all      # re-run everything
node lib/keeper.cjs --no-llm   # extract only, no model call (offline self-check)
node lib/decisions.cjs list    # show current choices
```

---

## Model used for digests

Defaults to the `headless` profile. To use a different route, set the environment variable
`ARCHIVE_KEEPER_PROFILE=<profile-name>`.

---

## License

MIT
