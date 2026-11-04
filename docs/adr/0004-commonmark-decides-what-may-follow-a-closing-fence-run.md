# 0004 — CommonMark decides what may follow a closing fence run

- **Status**: accepted
- **Date**: 2026-09-09
- **Deciders**: Triage (`/issue-triage`, #505)
- **Ticket**: #505

## Context

`src/core/markdownSections.ts` states its own contract as CommonMark's, in its doc comment and in the name of every rule inside it. #412 moved the fence rules there from `src/core/calendarTable.ts`, and its own out-of-scope line said the move must change no fence answer: *"Changing what any fence answer is. This is a move, and every answer must survive it."*

One answer changed anyway. The calendar reader's private copy read a closing line with `` /^ {0,3}(`+|~+)\s*$/ `` — CommonMark's opening rule, then any whitespace after the run. The core's `closesFence` reads it with `` /^ {0,3}(`{3,}|~{3,})[ \t]*$/ `` — a space or a tab, and nothing wider. JavaScript's `\s` covers more than a space and a tab: the non-breaking space `U+00A0`, the ideographic space `U+3000`, the byte-order mark `U+FEFF`, the form feed, the vertical tab, and `U+2000`–`U+200A`. A closing run followed by one of those closed a block under the old private rule and does not under the core's.

The narrowing was found after #412 closed, not while it was open: seven of its ten acceptance boxes pinned the fence answers, and none covered what may follow a closing run. It matters because `schemaBlocks` (`src/core/calendarTable.ts`) runs a fence it cannot find a close for to the foot of the note, and the calendar reader looks for a table anywhere inside that body — so the day the calendar reader is wired up, a closing run the core no longer accepts leaves every ordinary table below it reachable as that day's calendar.

## Decision

**Keep the narrowing.** `closesFence` accepts only a space or a tab after a closing run; it does not widen back to `\s*`.

CommonMark allows only spaces and tabs after a closing fence run — the rule the module already states as its contract. Widening back to `\s*` would restore an answer that contract never allowed: it would close a block that a CommonMark renderer leaves open, and the plugin would then edit inside a region the person does not see as a block on screen. Keeping the narrower rule disagrees with the *pre-#412* private copy; widening back would disagree with CommonMark and with what the renderer shows. The second disagreement is the worse one.

Obsidian's own renderer was measured against both readings on 2026-09-09, in the server's test Obsidian, recorded in `docs/acceptance-shots/issue-505-fence-render.txt`: a closing run followed by an ordinary space or tab closes the block on screen; followed by a non-breaking space, an ideographic space, a byte-order mark, a form feed or a vertical tab, it does not, and the text below reads as part of the fenced block.

So #412's "every answer must survive it" line is recorded here as knowingly broken, by this one character class, in favour of the contract the module already claimed.

## Consequences

- The refusals — non-breaking space, ideographic space, byte-order mark, form feed, vertical tab, and the `U+2000`–`U+200A` run — are pinned as a set in `src/__tests__/markdownSections.test.ts`, so the class cannot drift again in either direction.
- Whoever wires the calendar reader up still has to bound how far an unclosed schema block may run, or refuse a table the person never marked as one. This decision does not do that; it is recorded on #505 for whoever does.

## Alternatives considered

- **Widen `closesFence` back to `\s*`**, restoring #412's original promise that no fence answer changes. Rejected: it would trade a disagreement with one retired private copy for a disagreement with CommonMark and with what Obsidian's renderer actually shows — the plugin editing inside what the person sees as a closed block.
