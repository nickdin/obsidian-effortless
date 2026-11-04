# 0003 — A heading marks a collection, and nothing else does

- **Status**: accepted
- **Date**: 2026-09-04
- **Deciders**: the author
- **Ticket**: #29

## Context

A task lives in a collection (#27, ADR 0002), and the day's log holds no state of its own, so every task shown in a log must be findable in a collection. That makes "can the plugin find every collection, reliably" a correctness requirement rather than a performance one. Nothing had yet said which notes in a vault count.

The plugin being carried across answers with three parts at once. A *workspace* is a root folder, a required tag and a task-section heading (`src/types.ts:23-75`), and a note qualifies by sitting under the folder, carrying the tag, and holding an H2 whose text exactly equals the configured heading. Two things are wrong with that in practice. **The tag is never read** — the setting is written by the settings form and normalised on load and no runtime path consults it, so folder membership alone decides (`docs/research/effortless-code-audit.md` § 2.4, assumptions 5 and 7). And **finding collections costs a full scan**: leaving the daily note reads every Markdown file under every workspace root and runs a full sync computation against each, so a root holding 300 notes means 300 file reads on one click away (`effortless-code-audit.md` § 3.7, § 8).

So the shipped rule is three parts of which one runs, and the part that runs is the one that ties a note's meaning to where it is filed.

Two facts from Obsidian's public interface shaped the answer. Its **metadata cache already holds every note's headings and every list item's checkbox character and line number**, in memory, kept current by a `changed` event (`obsidian.d.ts:1402-1446`, `:3378-3388`, `:3746-3769`, `:4417-4453`) — so a whole-vault rule costs no file reading at all. And Obsidian **does not expose its own "Excluded files" setting** to plugins, which #10 forbids reaching for by undocumented means.

## Decision

**A note is a collection when it carries the configured tasks heading, and for no other reason.** No root folder, no required tag. The heading has to exist anyway, because it is where the tasks are written, so a collection declares itself by being written like one.

**The match is exact and whole-line, ignoring capitals, and ignoring the heading's level.** `## Uppgifter` counts and `## Uppgifter (2026)` does not; `#`, `##` and `###` all count, because different collections may want different heading sizes. This departs on purpose from #15 G14, where a day's log heading carries its level: there the level decides where a line goes, here it only decides whether a note counts.

**One heading name serves the whole vault**, shipped with an English default and changed in one place. It is not a first-run question — #15 G8's single question stays single.

**Only what sits under that heading, and under the completed-tasks heading, is read.** Every other checkbox in the note is invisible to the plugin, whatever marker it carries.

**A permissive rule is only safe when it is visible, so the settings screen lists every collection found**, each a link to the note, with its count of open tasks — and an excluded-folders list, shipped empty, keeps templates out.

## Consequences

- **The whole `workspaces` setting is deleted**, along with `requiredTag`, `generateWorkspaceId`, `normaliseWorkspace` and the workspace half of the settings form (`src/types.ts:23-75`, `:84-140`, `:190-197`; `src/settings.ts:45-47`, `:67-100`, `:366-484`, `:518-581`). One core setting replaces all of it. #14 ruled that workspaces are settings rather than a feature; they turn out not to be settings either.
- **The per-navigation vault scan is deleted.** Collections are found from the metadata cache, so the answer costs no file reading and one event keeps it current. That event does not fire on rename (`obsidian.d.ts:4449`), so the vault's own rename event must be hooked as well.
- **Old notes will surface as collections.** Any note in the vault already carrying that heading becomes one, and its open tasks would begin appearing in the day's log. The author accepted this as *"a cleaning job that needs done anyway"*, and the collections list is where it becomes visible rather than surprising.
- **A note's location stops meaning anything to the plugin.** Collections can be filed anywhere and reorganised freely, and the excluded-folders list is the only place a path still matters.
- **When a note stops being a collection, the plugin keeps both files exactly as they are and says so** — once per event, never once per task, and always outside the notes, since the log holds no state of its own. It **heals on its own** when the note matches again, because the pairing lives in the hidden marker inside both lines rather than in a note's name or place.
- **Renaming a collection rewrites its name in the day's logs that carry it.** Keeping a pointer true is copying rather than deciding, and it is what Obsidian already does to ordinary links. The cost is that it edits past pages of a log the author describes as written in ink; that cost was weighed and taken, because the name is a pointer and not a record of what happened.
  - **Sharpened 2026-09-04 by #30 M12: the plugin does this itself, and does not lean on Obsidian.** `FileManager.renameFile` already updates ordinary links, but only "depending on the user's preferences" (`node_modules/obsidian/obsidian.d.ts:2896-2902`) — so a person who has switched Obsidian's link-updating off would be left with stale names. The author chose the duplicate deliberately, against the recommendation. A build that finds itself rewriting a name Obsidian has already rewritten should re-read this, not remove it.
- **The plugin writes the completed-tasks heading and never the tasks heading.** Creating the tasks heading would make the plugin decide a note is a collection, which is this decision's whole point; refusing to finish a tick over a missing completed heading would be the plugin blocking on its own bookkeeping.
  - **Amended 2026-09-04 by #30 M8: *never* becomes *never unasked*.** Filing a task into a note that is not yet a collection asks in plain words, and a yes writes the tasks heading at the end of that note as `##`. The rule stands because it was about the plugin deciding, and a person pressing yes is not the plugin deciding. Nothing writes that heading without an explicit answer.

## Alternatives considered

- **A root folder**, as the old plugin actually runs. Familiar, and it bounds the search naturally. Rejected because it ties a note's meaning to where it is filed: move a collection and the plugin loses it, and the vault's shape becomes the plugin's business.
- **A tag**, for example `#samling`. Location-free like the heading, and explicit. Rejected because it is a second act of bookkeeping recording something the heading already says, and a tag can be dropped without any visible change to the note.
- **Folder and heading together.** The safest against stray notes, and the only one that would have kept old agent-written notes out on day one. Rejected because it makes the common case need two correct things instead of one, to prevent a problem that is a one-time cleanup.
- **Reading tasks anywhere in the note** rather than under the heading. Rejected: a packing list or a checklist inside a meeting note would become tasks, and any of them dated today would land in the day's log.
- **Inheriting Obsidian's own "Excluded files" list.** Would have cost no new setting. Not available — no such method exists in the public interface, and #10 forbids undocumented ones.
