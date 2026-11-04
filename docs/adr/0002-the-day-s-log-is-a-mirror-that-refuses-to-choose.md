# 0002 — The day's log is a mirror, and a clash is never resolved by the plugin

- **Status**: accepted
- **Date**: 2026-09-04
- **Deciders**: the author
- **Ticket**: #27

## Context

A task exists twice: once in its collection, where it lives, and once in the day's log, where the day's work is read. Both copies are plain Markdown in an editor, so both are editable, and something has to say what happens when they disagree.

The plugin being carried across has an answer, and it is the reason this ADR exists. `computeSync` takes a `direction` flag, and **whichever file you navigated away from overwrites the other wholesale** — the same comparison, opposite winner, chosen by that flag (`docs/research/effortless-code-audit.md` § 3.3, from `computeSync.ts:889-898` and `:1075-1081`). There are no timestamps, no stored base version, no marker written into the file and no notice. An edit made in both files between two navigations is silently lost, and nothing records that it happened.

The obvious repair is to divide the fields so a clash is impossible — the log owns the checkbox, the collection owns the words. The author rejected it: the reason the day's log exists is not having to open every collection, so rewording a task from the log is a requirement, not a convenience.

That made the probability question load-bearing, and it is low. One person on one device cannot type in two files at once; a clash needs an edit sitting *uncopied* while the other copy is edited. The old plugin's window is "until you navigate away" and can be hours. #23 already keeps this feature off phones, so the only genuine exposure is two desktops sharing a vault through a file-sync service.

## Decision

**A task lives in its collection. The day's log is a mirror with no state of its own** — everything in a log is explained by what some collection says, so the plugin never remembers anything about a day that is not written in a file.

**Edits are accepted from both sides.** All six fields the plugin understands travel in both directions; anything it does not understand stays on the side it was typed.

**When both copies changed since the plugin last saw them, it keeps both and changes neither**, and writes one line in the log naming the task. It does not pick a winner. Picking one is deciding, and #25 reserves deciding for the person.

**Superseded 2026-09-22 by #810: a clash is reported through `host.problems`, never by a line written into the log.** Spec #32, closed 2026-09-15, built the standing-problem channel every feature now reports through, on an explicit, tested guarantee that nothing reaches a note through it (`src/core/problems.ts`'s own module comment). That channel did not exist when this decision was written; it does now, and it is later. The sentence above is kept rather than edited, because the reasoning around it — that the plugin never picks a winner — still holds; only the mechanism for saying so changed. Spec #709 decision 13 and `GLOSSARY.md`'s own *Clash* entry carry the corrected wording.

**Copying runs a second or two after typing stops, and never writes into the file currently open.** Anything owed to the open file waits until it is left. In normal use these do not conflict: you edit one side, and the file that changes is the other one.

## Consequences

- **The clash window shrinks from hours to seconds**, which is what makes two-way rewording affordable at all. The refusal to choose is the backstop for the seconds that remain, not the main defence.
- **Detecting a clash needs the last-copied text**, so the hidden comment the line already carries gains a short hash of it. This is the only new state, and it lives in the file rather than in the plugin.
- **A log line you delete comes back.** The log holds no record that you removed it, because holding one would be exactly the invisible per-day state this decision exists to avoid. The way to take a task off a day is to change its date, which leaves `[>]` behind.
- **Nothing is ever deleted, only cancelled or reworded** — the author's own framing, from a notebook written in ink. The plugin has no path that removes a task from a collection.
- **The collection's name on a log line becomes a link to that task's own line**, resolved by the plugin from the hidden marker rather than by Obsidian block ids, so no `^marker` clutter appears in any collection. A hotkey does the same for the keyboard. The rest of the line stays ordinary editable text, which is what made a click-to-jump on the text itself impossible.

## Alternatives considered

- **Field ownership** — the log owns the checkbox, the collection owns everything else. No clash is possible and no extra state is needed. Rejected because it makes fixing a typo mean leaving the page, which defeats the log.
- **Last edit wins**, as today. Cheapest, and it is the defect the audit found: an edit disappears with no notice and no record.
- **The log always wins**, or the collection always wins. Predictable, and each throws away real work in one of the two directions.
- **Obsidian block ids** for the jump. Works without the plugin and from anywhere in the vault, at the price of a visible `^a1b2c3` on every task line in every collection — clutter on lines the person never asked the plugin to touch.
