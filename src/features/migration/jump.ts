/**
 * Going from a frozen `[>]` line to the task put in a collection.
 *
 * The line's own link — a wikilink or a markdown link, whichever the person's
 * link setting wrote — names the note and the hidden
 * `%% migration:<id> <hash> %%` names the line: the id is searched for in the
 * collection's text as it is read at that moment, so a line added above the
 * task since it was put there changes nothing. **Nothing is kept from the
 * moment of filing** — no path, no line number, no text.
 *
 * Finding the line and placing the cursor are the core's (`findMarkedLine`,
 * `placeOnMarkedLine`, `openNoteEditor` in `src/core/markedLine.ts`); what
 * this feature keeps is how it reads its own marker and what it says when
 * nothing is found. Every path that finds nothing says so in one `Notice`,
 * opens nothing, moves no cursor and writes nothing.
 */

import { Notice } from "obsidian";
import type { App, Editor, TFile } from "obsidian";
import { getLinkpath } from "obsidian";
import type { Collections } from "../../core/collections";
import { noteName } from "../../core/collections";
import type { FeatureHost } from "../../core/feature";
import { findMarkedLine, openNoteEditor, placeOnMarkedLine } from "../../core/markedLine";
import type { PlacingEditor } from "../../core/markedLine";
import type { FeatureProblems } from "../../core/problems";
import { reasonOf } from "../../core/reason";
import { parseTaskLine } from "../../core/taskLine";
import { collectionLinktextOf, hasMarkerId, readMarker } from "./marker";
import { FEATURE_ID } from "./types";

// The jump's callers and tests reach these through here.
export { collectionLinktextOf, readMarker };

/**
 * Whether a line, as raw text, is one a jump can start from: a `[>]` task line
 * carrying this feature's own marker. The collection's own copy carries the same
 * marker with an open checkbox, and a jump from it has nowhere to go. Where the
 * line is (a day's log, or any other note that is not a collection and not under an excluded folder, outside fenced text and the frontmatter) is `frozenLineAt`'s to say.
 */
export function canJumpFrom(raw: string): boolean {
	return parseTaskLine(raw)?.checkbox === ">" && readMarker(raw) !== null;
}

/** Everything a jump needs from Obsidian, behind one seam so the orchestration below stays a function of it. */
export interface JumpTarget {
	/** The vault path `linktext` resolves to from `sourcePath`, or null when it names no note. */
	resolveLink(linktext: string, sourcePath: string): string | null;
	/** Whether `path` is a collection right now. */
	isCollection(path: string): boolean;
	/** The note's text as it is read now, without opening it. */
	readText(path: string): Promise<string>;
	/** Opens the note at `path` and hands back its editor. */
	open(path: string): Promise<PlacingEditor>;
	/** One notice, said to the person. */
	notify(message: string): void;
}

/** What the person is told when the frozen line names no collection at all. */
export function namesNoCollectionMessage(): string {
	return "Effortless: this task names no collection, so there is nowhere to go. Nothing was changed.";
}

/** What the person is told when the note is gone or has stopped being a collection. */
export function collectionGoneMessage(linktext: string): string {
	return `Effortless: "${linktext}" is not a collection any more, so there is nowhere to go. Nothing was changed.`;
}

/** What the person is told when the collection holds no line put there from this one. */
export function taskGoneMessage(linktext: string): string {
	return `Effortless: no line in "${linktext}" is still the one put there from this task. Nothing was changed.`;
}

/**
 * The standing problem's key: one per filing, so the same broken filing
 * reported twice is one problem and two filings are two.
 */
function problemKey(id: string): string {
	return `collection-gone:${id}`;
}

/**
 * From `raw`, the frozen line the cursor is on in the note at `sourcePath`:
 * find the collection, find the task in it, open it, put the cursor there.
 *
 * The collection's text is read **before anything is opened**, so a task that
 * is not there opens nothing (spec decision 9, the ticket's choice; Task
 * consistency's jump behaves the same way). The text is read again from the
 * editor's own current text when the note is open, because what the person has
 * typed and not yet saved is newer than the disk; a task that vanished in that
 * gap is a `Notice` too.
 *
 * A collection that is gone is one standing problem through `problems`, keyed
 * by the filing, and never a line written into the day's log. Finding the
 * collection well again clears it.
 */
export async function jumpFromLine(target: JumpTarget, problems: FeatureProblems, sourcePath: string, raw: string): Promise<void> {
	const marker = readMarker(raw);
	if (marker === null) return;

	const linktext = collectionLinktextOf(raw);
	if (linktext === null) {
		target.notify(namesNoCollectionMessage());
		return;
	}

	// A notice names the collection by its note name, as the filing notice does, not by the path the link spells.
	const called = noteName(linktext);
	const key = problemKey(marker.id);
	const path = target.resolveLink(linktext, sourcePath);
	if (path === null || !target.isCollection(path)) {
		problems.report(key, `the task put in "${called}" cannot be reached: it is not a collection any more.`);
		target.notify(collectionGoneMessage(called));
		return;
	}
	problems.clear(key);

	const test = hasMarkerId(marker.id);

	try {
		const text = await target.readText(path);
		if (findMarkedLine(text, FEATURE_ID, test) === null) {
			target.notify(taskGoneMessage(called));
			return;
		}
		const editor = await target.open(path);
		if (placeOnMarkedLine(editor, FEATURE_ID, test) === "not-found") target.notify(taskGoneMessage(called));
	} catch (error) {
		target.notify(`Effortless could not open "${called}": ${reasonOf(error)}`);
	}
}

/** The real `JumpTarget`: which notes are collections, how a name resolves, how a note is read and opened. */
export function realJumpTarget(app: App, collections: Collections, readNote: (file: TFile) => Promise<string>): JumpTarget {
	return {
		resolveLink: (linktext, sourcePath) => app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), sourcePath)?.path ?? null,
		isCollection: (path) => collections.at(path) !== null,
		readText: async (path) => {
			const file = app.vault.getFileByPath(path);
			if (file === null) throw new Error(`"${path}" no longer exists`);
			return readNote(file);
		},
		open: (path) => openNoteEditor(app, path),
		notify: (message) => new Notice(message),
	};
}

/**
 * The one function the command and the right-click entry both run: the jump
 * from `lineIndex` in `file`, the cursor's line unless the caller names another,
 * as the right-click entry does.
 * The host is asked each time it runs.
 */
export function jumpFromCursor(host: Pick<FeatureHost, "app" | "collections" | "problems" | "notes">): (editor: Editor, file: TFile, lineIndex?: number) => void {
	return (editor, file, lineIndex = editor.getCursor().line) => {
		const target = realJumpTarget(host.app, host.collections, (note) => host.notes.read(note));
		void jumpFromLine(target, host.problems, file.path, editor.getLine(lineIndex));
	};
}
