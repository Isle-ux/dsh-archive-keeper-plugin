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

---

## Install

Install straight from GitHub:

```bash
npm i github:Isle-ux/dsh-archive-keeper-plugin
```

Or clone it and link the directory into your profile's `node_modules`:

```bash
git clone https://github.com/Isle-ux/dsh-archive-keeper-plugin.git
```

Then add the plugin to your profile's `dsh.profile.bundles` (or however your DSH version loads
plugins). This package **bundles all runtime code** — no extra dependencies to install.

### Compatibility

- **Desktop / web only.** The client half registers into the
  `conversation.session.header.utilities` slot, which only hosts with a conversation view
  declare. In headless, TUI and similar hosts the plugin simply does not activate.
- Requires Node.js ≥ 20.
- The digest step calls a model, so you need a working model route configured in DSH.

> ⚠️ This plugin was developed against the author's local DSH version. If your DSH version has
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
  slot name in the author's version (0.2.0-rc.2). If your DSH version does not declare that slot,
  the client half will **not error — it simply will not appear**. The host half (digesting, routes,
  trash) keeps working regardless.
- **This plugin has not been tested across all DSH versions.** It was verified only in the author's
  desktop environment (full 12-plugin stack, real browser, 0 errors). If you hit a problem, please
  open an Issue with your DSH version number.
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
