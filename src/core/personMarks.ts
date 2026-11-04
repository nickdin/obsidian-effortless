/**
 * The one place a line is asked which people it names: every *person mark* on it,
 * in order, each with where it sits. A person mark is the character `@` directly
 * followed by a wikilink, no space between — `@[[Mikael Åkerbacke]]` — and the
 * person is the link's path as written, without its alias or its heading. This is
 * what makes a task a *followed task*: spec
 * #1181, decided in ADR 0006
 * (`docs/adr/0006-a-followed-task-is-named-on-its-line-not-by-a-sixth-checkbox-symbol.md`)
 * and defined in `GLOSSARY.md` under *Followed task*.
 *
 * Nothing else is a mark: a bare `@name`, an email address, `@` before a markdown
 * link, `@ [[…]]` with a space, `@` before an embed (`@![[…]]`), or a mark inside a
 * `%% … %%` comment. The reader is built on `linksOnLine` rather than on a second
 * reading of the line, so a mark and a link can never be read two ways, and the
 * comment rule is that reader's: a mark is a wikilink it finds, whose `@` sits
 * right before it. That reader hides comments only on a task line, so on a line
 * that is not a task a mark inside a comment is still read; the followed-tasks
 * reader that #1185 will
 * build, and which does not exist yet, is to ask whether the line is a task first.
 * `start` and `end` are indices into the line as given, never into a
 * comment-stripped copy.
 *
 * What this does not decide: whether the line is a task, whether that task is
 * live (its checkbox open rather than done or cancelled), or whether the line sits
 * where the plugin reads tasks. Those will be the followed-tasks reader's business,
 * and it is to ask them before it asks this. It touches no vault, no app and no settings.
 */

import { linksOnLine } from "./linkReading";

/** One person mark found on a line. */
export interface PersonMark {
	/** The person: the wikilink's path as written, trimmed, without its `#heading` or `|alias`. */
	readonly person: string;
	/** The index of the `@` in the line. */
	readonly start: number;
	/** One past the closing `]]`. */
	readonly end: number;
}

/**
 * Every person mark on `line`, in order. On a task line, marks inside its `%% … %%`
 * comments are left out; on a line that is not a task nothing is masked, so a mark
 * inside a comment is still returned (the link reader's rule,
 * `src/core/linkReading.ts`). A comment that spans several lines is not masked
 * either, since the line is read alone.
 */
export function personMarksOnLine(line: string): PersonMark[] {
	const marks: PersonMark[] = [];
	for (const link of linksOnLine(line)) {
		if (link.kind !== "wikilink" || link.start === 0 || line[link.start - 1] !== "@") continue;
		marks.push({ person: link.path, start: link.start - 1, end: link.end });
	}
	return marks;
}
