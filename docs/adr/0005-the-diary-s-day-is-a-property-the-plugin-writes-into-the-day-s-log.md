# 0005 — The diary's day is a property the plugin writes into the day's log

- **Status**: accepted
- **Date**: 2026-10-09
- **Deciders**: the author
- **Ticket**: #1049

## Context

The chain has to tell a diary written on its day from one written later, and Obsidian records nothing about when a section of a note was written. A file's modification time moves with every later edit — a task ticked the next morning — so it cannot answer. The plugin has to record the day itself, the first time any device sees text under the diary heading.

Until now the plugin wrote nothing into a day's log unasked. The processed field is filled only by *Mark as processed*, a person's act; the fields meeting notes writes are written into a note the plugin itself created. ADR 0002 keeps the day's log a mirror that holds no state of its own.

## Decision

**The plugin writes the date into a property of that day's log, the diary-date field, named once for the whole vault, the first time it sees text under the diary heading, and never overwrites it.** A value typed by hand counts, and a wrong one is corrected by hand.

*Addendum 2026-10-13, #1136 and #1170:* "text under the diary heading" no longer means any text. The diary section the day's-log template itself made, which nobody wrote, does not count, so the plugin neither dates it nor stops reading the diary as empty; and a log for a day after today is never dated. The plugin still never judges what a person wrote. The rule is `dailyLogTemplateDiary` in the core, compared in `src/features/review/diaryDate.ts`.

*Addendum 2026-10-16, #1207:* "the diary section the template made" is read first from the log itself. A log the core builds from the template carries a second property, `effortless-built-diary`, holding a fingerprint of the diary section it was built with (`src/core/builtDiaryMark.ts`), so an untouched log reads as unwritten whatever the template says by then and whichever device sees it first. It is written into a note the plugin is creating, the way meeting notes' fields are, not into a log that already exists; a log without it is judged as before. The author accepted the extra line on every log built from a template in triage.

## Consequences

- One line at the top of the day, visible beside the processed field, synced with the note, surviving a reinstall of the plugin and readable by anything else in the vault.
- The day's log carries one fact about itself that no collection explains. ADR 0002's mirror rule is about tasks, and this is not a task; but it is the first unasked write into a day's log, and a reader finding it in the code should find this note.
- Whichever device sees the text first writes the date in that device's local day. A diary typed on a phone just after midnight is dated the new day on that phone, which is the truth of when it was written.

## Alternatives considered

- **A record in `data.json`**, like row memory. Invisible, so a wrong date cannot be seen or corrected, and lost with the plugin's settings. Rejected for that invisibility.
  *Added 2026-10-13, #1137:* Review now keeps the day a diary-date write was lost for in its own slice of `data.json` (`src/features/review/diaryDays.ts`), until the write lands. The property stays the record of the diary's day. The slice is a pending write only: it is dropped once the property holds the date, and nothing reads it as the day's record.
- **The file's modification time.** Needs no write at all. Rejected because any later edit to the day — ticking a task, roll-over's own `[>]` — moves it, so it cannot say when the diary was written.
