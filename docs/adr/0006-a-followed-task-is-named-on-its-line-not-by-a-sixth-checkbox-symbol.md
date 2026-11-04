# 0006 — A followed task is named on its line, not by a sixth checkbox symbol

- **Status**: accepted
- **Date**: 2026-10-14
- **Deciders**: the author
- **Ticket**: #1179

## Context

A task someone else has in hand, that the author still wants to see through, had no place in the plugin. It is not done, not cancelled, not forwarded, and not the author's own to do; yet it has to turn up on the day it is to be chased and be visible somewhere as long as it is out with the other person. The vault already reached for this twice by hand before anything was built: a `#väntarpå` tag on one task in March 2026, and a colleague's name written into a task as `@[[…]]` in February 2026.

The checkbox was the obvious place, and the vault already uses the Minimal theme's extra symbols by hand (`[i]`, `[I]`, `[k]`, `[b]`, `[?]`). But the plugin fixes a meaning to five symbols only, and a collection line's symbol is already the plugin's own bookkeeping: once a task is copied into a day's log the collection line reads `[/]`, *copied* (`src/features/taskConsistency/copyIn.ts`). A task cannot read both *copied* and *followed* in one character.

## Decision

**A followed task is an ordinary open task whose line names the person: `@` directly followed by a link, anywhere on the line.** The plugin reads only that bracketed form, never a bare `@name` or an email address, and a line naming two people is followed under both. The follow-up date is the task's own scheduled date, so the existing copy-in puts it in that day's log and roll-over carries it on unchanged: what rolls over is the chase, and the chase is what is overdue. A followed task with no date is allowed; it is seen in Review's list of followed tasks, grouped by person, and nowhere else. It stops being followed when its checkbox reads done or cancelled, by the person's own hand.

Date entry gives way for it: a trigger directly followed by `[` never opens the date popup, whatever the trigger character, since `![[` is Obsidian's own embed syntax and should not open one either.

## Consequences

- Roll-over, task consistency, checkbox cycling and the task-line format change nothing. The mark is text, and the plugin never edits a line's text.
- Only Effortless can draw the list of what is out with others: the vault runs neither the Tasks plugin nor Dataview, so a query in the vault was never an option.
- Because the person is an ordinary link, Obsidian's backlinks on a person's note list every task they hold without anything built for it.
- Nothing on the line records when the task was handed over, so the list shows no age. An age would have to come from the day's log the note belongs to, a later ticket if wanted.

## Alternatives considered

- **A sixth checkbox symbol, such as `[w]`.** Rejected because the collection line's symbol already carries *copied*, and because a sixth meaning changes the core format every feature reads.
- **A tag, `#väntarpå`, as the vault once used.** Rejected in favour of the `@` form because the tag names the state but not the person, and the person is what the list groups by.
- **A collection of its own, "Väntar på".** Rejected because it pulls the task out of the subject it belongs to, and a collection is a subject, not a state (ADR 0003).
- **A different sign than `@`, to avoid the date-entry trigger.** Rejected: the clash is one rule in date entry, and `@` is the form the author already writes.
