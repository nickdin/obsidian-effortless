/**
 * Keeping a renamed collection's name true on frozen lines in every note that
 * carries it — the day's logs and any other note that is not itself a collection.
 *
 * ADR 0003's own consequences describe this as settled, and it is sharpened
 * 2026-09-04 by issue #30
 * M12: "the plugin does this itself, and does not lean on Obsidian" —
 * `FileManager.renameFile` rewrites ordinary links only "depending on the
 * user's preferences"
 * (`docs/adr/0003-a-heading-marks-a-collection-and-nothing-else-does.md:37-38`,
 * `node_modules/obsidian/obsidian.d.ts:2896-2902`), so a person who has that
 * setting off would otherwise be left with stale names. A build that finds
 * itself duplicating a rewrite Obsidian has already made should re-read that
 * line, not remove this module.
 *
 * Only a task line's link changes — a wikilink or a markdown link, whichever
 * shape the person's link setting made it, by name, by path or relative to the
 * log. GLOSSARY.md's *Forwarding* entry names
 * this the one edit a frozen line ever receives: nothing else on the line,
 * and no line that is not a task line, is ever touched.
 *
 * **Which notes to check costs no file read.** It is answered from
 * `NoteCaches.linkedFrom` — Obsidian's own `metadataCache.resolvedLinks`
 * (`node_modules/obsidian/obsidian.d.ts:4438`), the already-computed map of
 * who resolves a link to what. That index is not recomputed synchronously on
 * a rename any more than `MetadataCache`'s own `changed` event is
 * (`obsidian.d.ts:4449`, "This is not called when a file is renamed for
 * performance reasons"), so at the moment `rename` fires it still names the
 * notes that pointed at the old path — exactly the set this rewrite has to
 * visit, with nothing opened to find it. Driven on the test Obsidian, not
 * inferred: `docs/acceptance-shots/issue-803-rename-rewrite.txt` step 1 read
 * the old path in `resolvedLinks` at the moment `rename` fired, and the same
 * record's step 1 shows the file at the new path read as a collection. Its
 * step 2 is the exception the paragraph below handles.
 *
 * Whether the renamed note *was* a collection is answered the same way a
 * rename cannot change a note's content: the tasks heading it carries — or
 * does not — is the same heading before and after, so `collectionIn` is asked
 * about the file at its *new* path and that answer is also the old one.
 *
 * **A second rename before Obsidian re-resolves the log finds nothing through
 * `linkedFrom` alone.** `resolvedLinks` is not recomputed synchronously on a
 * rename, and the plugin's own edit does not make it recompute either — so a
 * rename that follows a rewrite closely enough finds `linkedFrom(oldPath)`
 * naming no log at all, even though the logs this plugin just rewrote still
 * carry a link under that path's name (issue
 * #815, driven on the
 * server's test Obsidian: `docs/acceptance-shots/issue-803-rename-rewrite.txt`
 * step 2). `watchCollectionRenames` remembers, by the note's path right after
 * each rewrite, which logs it targeted, and a rename landing on that path
 * finds them there instead.
 *
 * **A bare link is resolved before it is rewritten**. `rewriteCollectionLinks`
 * rewrites a task line's link when its path names the old path or one of its
 * tail segments — `Work/Ideas` and `Ideas` for an old path `Work/Ideas.md` —
 * but a bare tail also names any other note sharing that basename, wherever it
 * sits, so rewriting it on the name alone can retarget a link that opens a
 * different, still-existing note. The promise ADR 0003 sharpens is "a frozen
 * link keeps opening the note it opened", so a bare link is
 * asked, after the rename, where its name now opens from the log's own path —
 * `resolveBareLink` in {@link RenameWhere}, answered by
 * `metadataCache.getFirstLinkpathDest` the way `jump` and `undo` already ask it
 * (`grep -rn getFirstLinkpathDest src`). If it still opens a different existing
 * note, it is left exactly as it is; if it opens nothing, or the renamed note
 * itself, it is rewritten as before. The rewriter stays a pure function of text
 * plus this injected answer and never imports `obsidian`.
 *
 * **The new name can itself already belong to another note**. Renaming
 * `Ideas/Garden shed.md` to `Ideas/Tool shed.md` while `Projects/Tool shed.md`
 * exists would write a bare `[[Tool shed]]` that Obsidian may resolve to either
 * note. Told, through `nameIsShared` in {@link RenameWhere}, that a note other
 * than the renamed one already carries the new name, the keeper writes a
 * wikilink qualified to the renamed note's own vault path (`[[Ideas/Tool
 * shed]]`) instead of the bare name; a markdown or relative link keeps its own
 * shape and `%20` spelling and is qualified to that same full path — the
 * shortest unique qualifier is not required. Unshared, output is byte-for-byte
 * as before this ticket.
 *
 * **The other direction: a renamed ordinary note, and the link back on a
 * collection's copy**. Filing a task from any note gives the collection's copy a
 * link back to that note, the mirror of the frozen line's link. Renaming
 * that note with Obsidian's own link-updating off would leave the link opening
 * nothing, so the same rewrite keeps it true. The core still names no feature:
 * a link back is found by `markerLink.ts`'s `appendedLink` — the link a feature
 * appended, as that feature's own marker says so — so a person's own link to the
 * same note, on that line or any other, is never touched. It is written
 * in the shape the link had, the way the frozen side is. One question is
 * put to the app: `watchCollectionRenames` is handed the file manager, and asks
 * `FileManager.generateMarkdownLink` (`node_modules/obsidian/obsidian.d.ts:2931`)
 * whether the vault writes whole vault paths (`writesFullPaths`, #1007). If it
 * does, a link that named a folder is written to the note's whole new path; if
 * it does not, or no file manager was handed in, the link keeps the shape it had.
 * The rewriting itself stays a pure function of text and these answers.
 *
 * **What an ordinary note's rename now reads.** No log, and no note's text but
 * a collection's: the link index and the metadata cache are consulted, and only
 * the collections that `linkedFrom` names for its old path (plus the ones the
 * previous rewrite visited, for a second rename) have their text read, and of
 * those only the ones the collections index calls a collection now and that
 * are outside the excluded folders. Each such collection is read once, so a
 * copy Obsidian has already rewritten is left unwritten rather than written
 * with the same bytes. A rename of a note no collection links to reads no note
 * and writes nothing, which is what #803's third criterion protects.
 */

import { getLinkpath } from "obsidian";
import type { App, FileManager, TFile } from "obsidian";
import type { NoteCaches } from "./collections";
import { collectionIn, isExcluded, noteName } from "./collections";
import type { LineLink } from "./linkReading";
import { linksOnLine } from "./linkReading";
import { fencedLines, frontmatterEnd } from "./markdownSections";
import { appendedLink } from "./markerLink";
import type { NoteWriter } from "./noteWriter";
import type { FeatureProblems } from "./problems";
import { reasonOf } from "./reason";
import type { VaultLayout } from "./settings";
import { parseTaskLine } from "./taskLine";
import { isDailyLogPath } from "./vaultLayout";

/**
 * Builds the two answers `watchCollectionRenames` needs from a live app —
 * issue #895's
 * `resolveBareLink` and issue
 * #901's `nameIsShared` —
 * so `main.ts` and the end-to-end tests both wire the same resolvers instead
 * of each keeping its own copy by hand.
 *
 * `resolveBareLink` asks `metadataCache.getFirstLinkpathDest`, the way `jump`
 * and `undo` already ask it. `nameIsShared` compares names the way Obsidian's
 * own link resolution does, ignoring letter case — inferred from its
 * documented link behaviour rather than stated on `getFirstLinkpathDest`
 * itself (`node_modules/obsidian/obsidian.d.ts:4411`), so a twin differing
 * only in case still counts as shared.
 */
export function collectionRenameResolvers(app: App): { resolveBareLink: ResolveBareLink; nameIsShared: NameIsShared } {
	return {
		resolveBareLink: (name, logPath) => app.metadataCache.getFirstLinkpathDest(getLinkpath(name), logPath)?.path ?? null,
		nameIsShared: (name, exceptPath) =>
			app.vault.getMarkdownFiles().some((file) => file.path !== exceptPath && noteName(file.path).toLowerCase() === name.toLowerCase()),
	};
}

/**
 * Subscribes to the vault's rename event through `notes`, the same
 * subscription the collections index shares — see `NoteCaches.onRename`. Call
 * once, beside where the collections index itself is built; nothing here
 * needs tearing down, since the subscription it rides on already is.
 */
export function watchCollectionRenames(
	notes: NoteCaches,
	layout: () => VaultLayout,
	writer: NoteWriter,
	problems: FeatureProblems,
	resolveBareLink: ResolveBareLink,
	nameIsShared: NameIsShared,
	fileManager?: LinkWriter,
): void {
	// Keyed by a collection's path right after this plugin last rewrote logs
	// for it, so the next rename — if it names that same path as its
	// `oldPath` — finds those logs even when `resolvedLinks` has not caught
	// up. See the doc comment above.
	const recentLogs = new Map<string, string[]>();
	// The same, for an ordinary note: keyed by its path right after the
	// rewrite, holding the collections whose link back was visited.
	const recentLinkBacks = new Map<string, string[]>();
	// How many link-back rewrites of a collection have started and not settled,
	// keyed by its path.
	const linkBackWork = new Map<string, number>();
	notes.onRename((file, oldPath) => {
		void rewriteRenamedCollection(notes, layout(), writer, problems, file, oldPath, recentLogs, recentLinkBacks, linkBackWork, resolveBareLink, nameIsShared, fileManager);
	});
}

async function rewriteRenamedCollection(
	notes: NoteCaches,
	layout: VaultLayout,
	writer: NoteWriter,
	problems: FeatureProblems,
	file: TFile,
	oldPath: string,
	recentLogs: Map<string, string[]>,
	recentLinkBacks: Map<string, string[]>,
	linkBackWork: Map<string, number>,
	resolveBareLink: ResolveBareLink,
	nameIsShared: NameIsShared,
	fileManager: LinkWriter | undefined,
): Promise<void> {
	// Not a collection, before or after: no log is read, which is what proves
	// the plugin costs a rename of an ordinary note nothing. The one thing such a rename may read is a collection the
	// link index says links to the old path, to keep its link back true — never a log, and never a note no collection links back to.
	const collection = collectionIn(file.path, notes.cache(file.path), layout);
	if (collection === null) {
		recentLogs.delete(oldPath);
		await rewriteLinkBacks(notes, layout, writer, problems, file, oldPath, recentLinkBacks, linkBackWork, resolveBareLink, nameIsShared, fileManager);
		return;
	}

	const oldName = noteName(oldPath);
	const newName = collection.name;

	// Every call `rewriteCollectionLinks` makes below asks `nameIsShared` the
	// same question — whether some other note already carries `newName`,
	// `file.path` excepted — so the vault-wide answer is asked once here
	// rather than once per bare link per log (wave 2's code review of
	// #909/#901, unfiled finding 9).
	let sharedAnswer: boolean | undefined;
	const cachedNameIsShared: NameIsShared = (name, exceptPath) => {
		sharedAnswer ??= nameIsShared(name, exceptPath);
		return sharedAnswer;
	};

	const remembered = recentLogs.get(oldPath) ?? [];
	recentLogs.delete(oldPath);
	// Every note that linked to the collection, whatever it is — a day's log, a
	// meeting note, any other — except a collection or a note under an excluded
	// folder. Both halves widen together:
	// `linkedFrom` is covered by "rewrites a frozen link in an ordinary note"
	// in `collectionRenameEveryNote.test.ts`, and `remembered` — what the
	// previous rewrite targeted, for when Obsidian's own link-updating has
	// already moved the links out from under `linkedFrom` — by "finds an
	// ordinary note through a second rename" in the same file. The test is
	// asked of each note now, from the collections index as it stands, and
	// never kept from an earlier read (CLAUDE.md).
	const targets = new Set(
		[...notes.linkedFrom(oldPath), ...remembered].filter((path) => mayBeRewritten(path, oldPath, notes, layout)),
	);

	const logs = [...targets].map((path) => notes.fileAt(path)).filter((found): found is TFile => found !== null);

	const writes = logs.map((log) =>
		writer
			.edit(log, (content) =>
				rewriteCollectionLinks(content, oldPath, newName, {
					newPath: file.path,
					logPath: log.path,
					resolveBareLink,
					nameIsShared: cachedNameIsShared,
					writesFullPaths: writesFullPaths(fileManager, file, log.path),
					frozenLinesOnly: !isDailyLogPath(log.path, layout),
				}),
			)
			.catch((error: unknown) => {
				// One log's failure never stops the others: `writes` below still
				// starts every edit before this rejects, and `Promise.all` waits
				// on this settled (not rejected) promise like every other one.
				problems.report(
					oldPath,
					`renaming "${oldName}" to "${newName}" could not update ${log.path}. ${reasonOf(error)}`,
				);
			}),
	);

	recentLogs.set(
		file.path,
		logs.map((log) => log.path),
	);

	await Promise.all(writes);
}

/**
 * Keeps the link back on each collection's copy true after an ordinary note
 * was renamed: every collection that links to the old
 * path — from the link index, or from the previous rewrite's memory when the
 * index has not caught up — is read once, and written only when a link back
 * in it named the old note. One collection's failure never stops the others.
 */
async function rewriteLinkBacks(
	notes: NoteCaches,
	layout: VaultLayout,
	writer: NoteWriter,
	problems: FeatureProblems,
	file: TFile,
	oldPath: string,
	recentLinkBacks: Map<string, string[]>,
	linkBackWork: Map<string, number>,
	resolveBareLink: ResolveBareLink,
	nameIsShared: NameIsShared,
	fileManager: LinkWriter | undefined,
): Promise<void> {
	const remembered = recentLinkBacks.get(oldPath) ?? [];
	recentLinkBacks.delete(oldPath);
	const targets = new Set([...notes.linkedFrom(oldPath), ...remembered].filter((path) => mayHoldLinkBack(path, oldPath, notes, layout)));
	const collections = [...targets].map((path) => notes.fileAt(path)).filter((found): found is TFile => found !== null);
	if (collections.length === 0) return;
	recentLinkBacks.set(
		file.path,
		collections.map((collection) => collection.path),
	);

	const oldName = noteName(oldPath);
	const newName = noteName(file.path);
	let sharedAnswer: boolean | undefined;
	const cachedNameIsShared: NameIsShared = (name, exceptPath) => {
		sharedAnswer ??= nameIsShared(name, exceptPath);
		return sharedAnswer;
	};

	await Promise.all(
		collections.map(async (collection) => {
			const rewrite = (content: string): string =>
				rewriteLinkBackLinks(content, oldPath, newName, {
					newPath: file.path,
					logPath: collection.path,
					resolveBareLink,
					nameIsShared: cachedNameIsShared,
					writesFullPaths: writesFullPaths(fileManager, file, collection.path),
				});
			// Counted from before the read until the edit settles: while an
			// earlier rename's edit to this collection is held or queued, the text on
			// disk is not the text the edit will see, so a read-first check would
			// compare against the wrong text.
			const outstanding = linkBackWork.get(collection.path) ?? 0;
			linkBackWork.set(collection.path, outstanding + 1);
			try {
				// Read first, so a copy Obsidian already rewrote is not written again
				// with the same bytes — unless an earlier rename's edit to this
				// collection is still outstanding, when the edit alone is right: it
				// queues behind that one and hands the rewrite the text it left.
				if (outstanding === 0) {
					const before = await writer.read(collection);
					if (rewrite(before) === before) return;
				}
				await writer.edit(collection, rewrite);
			} catch (error) {
				problems.report(oldPath, `renaming "${oldName}" to "${newName}" could not update the link back in ${collection.path}. ${reasonOf(error)}`);
			} finally {
				const left = (linkBackWork.get(collection.path) ?? 1) - 1;
				if (left === 0) linkBackWork.delete(collection.path);
				else linkBackWork.set(collection.path, left);
			}
		}),
	);
}

/**
 * Whether a note that links to the renamed ordinary note may hold a link back
 * to it: a collection the index calls one now, outside the excluded folders,
 * asked of each note from the collections index as it stands, never kept from
 * an earlier read. Not the frozen side's test (`mayBeRewritten`), which accepts
 * logs and refuses collections, the reverse; the two share only the self-path
 * and excluded-folder checks.
 */
function mayHoldLinkBack(path: string, oldPath: string, notes: NoteCaches, layout: VaultLayout): boolean {
	if (path === oldPath || isExcluded(path, layout.excludedFolders)) return false;
	return collectionIn(path, notes.cache(path), layout) !== null;
}

/**
 * `content` with the link each line's feature marker claims — the link a
 * feature appended, `markerLink.ts`'s `appendedLink` — rewritten when it names
 * `oldPath`'s note, and nothing else changed: a person's own link to the same
 * note, on that line or another, stays byte for byte. Lines in the
 * frontmatter and in fenced text are left alone, as the frozen side leaves
 * them. Unchanged when the note kept its name and its folder.
 */
export function rewriteLinkBackLinks(content: string, oldPath: string, newName: string, where: RenameWhere): string {
	if (noteName(oldPath) === newName && stem(where.newPath) === stem(oldPath)) return content;
	const rename: Rename = { oldPath, newName, where };
	const lines = content.split("\n");
	const frontmatter = frontmatterEnd(lines);
	const fenced = fencedLines(lines, frontmatter + 1);
	return lines
		.map((line, at) => {
			if (at <= frontmatter || fenced[at]) return line;
			const link = appendedLink(line);
			if (link === null) return line;
			const written = rewrittenLink(link, line.slice(link.start, link.end), rename);
			return written === null ? line : line.slice(0, link.start) + written + line.slice(link.end);
		})
		.join("\n");
}

/**
 * Whether a note that links to the renamed collection has its frozen links
 * kept current: it is not the renamed note itself (whose cache under the old
 * path is empty, so it would otherwise read as "not a collection"), and it is
 * either a day's log — gathered whatever the excluded folders say, as it was
 * before #982 and as filing accepts one — or a note that is not a
 * collection (the collections index answers from what Obsidian has parsed
 * now) and not under an excluded folder. A note with nothing parsed yet is not
 * a collection and is kept. An excluded note that is not a day's log is left
 * alone because the feature that writes a frozen line refuses one there (spec
 * #980 decisions 1 and 3; a template's example line is not a record), so
 * there is nothing of the plugin's to keep current in it.
 */
function mayBeRewritten(path: string, oldPath: string, notes: NoteCaches, layout: VaultLayout): boolean {
	if (path === oldPath) return false;
	if (isDailyLogPath(path, layout)) return true;
	if (isExcluded(path, layout.excludedFolders)) return false;
	return collectionIn(path, notes.cache(path), layout) === null;
}

/**
 * Asked where a bare link's name now opens, from the log's own path that
 * carries it: the note path it opens, or `null` when it opens nothing. Answered
 * by `metadataCache.getFirstLinkpathDest`, the way `jump` and `undo` already ask
 * it.
 */
export type ResolveBareLink = (name: string, logPath: string) => string | null;

/**
 * Asked whether a note other than the one being renamed already carries a
 * given name — issue #901,
 * beside {@link ResolveBareLink} in the same {@link RenameWhere}. Answered
 * from the vault's own notes, `exceptPath` (the renamed note's own new path)
 * excluded, so a link written for the new name can tell whether it must be
 * qualified to stay unambiguous.
 */
export type NameIsShared = (name: string, exceptPath: string) => boolean;

/**
 * The one options object {@link rewriteCollectionLinks} takes beside the text:
 * where the rename put the note and which note is being rewritten (`newPath`,
 * `logPath` — a day's log, another note, or a collection whose link back is
 * being kept true; what a path-qualified or relative link needs to be written true
 * again), where a bare link's name resolves now (`resolveBareLink`, issue
 * #895), and whether the new name already belongs to another note
 * (`nameIsShared`, issue #901). **Named `RenameWhere` from before #895.** A
 * caller with nothing to say about a field it does not use leaves that field
 * out; old code that builds `{ newPath, logPath }` alone still compiles and
 * still runs, asking nothing new.
 */
export interface RenameWhere {
	readonly newPath: string;
	readonly logPath: string;
	readonly resolveBareLink?: ResolveBareLink;
	readonly nameIsShared?: NameIsShared;
	/**
	 * Whether the vault writes a link to the renamed note as its whole vault
	 * path from this log (`writesFullPaths`, issues #1007 and #1008) — the
	 * "absolute path in vault" setting. Set, a link that names a folder keeps
	 * naming one: it is written to the note's whole new path, so a name change
	 * does not cut it to the bare name and a move does not cut it to the last
	 * folders of the new path. Left out or false, a link is written as before.
	 */
	readonly writesFullPaths?: boolean;
	/**
	 * Set for a note that is not a day's log: only a frozen line
	 * outside fenced text and frontmatter is rewritten, so a task the person
	 * wrote there, or an example in a code block, is left byte for byte. Left
	 * out, every task line is rewritten — a day's log's own contract.
	 */
	readonly frozenLinesOnly?: boolean;
}

/**
 * Rewrites every task-line link naming `oldPath`'s note to name it where it is
 * now — or, given `where.frozenLinesOnly` (a note that is not a day's log,
 * issue #988), only the frozen lines outside frontmatter and fenced text. Every other byte of every line — task line or not — is left exactly as it
 * was, including a line already carrying the new name: nothing there matches, so
 * nothing there changes, which is what makes a second rewrite change nothing.
 *
 * A link matches when its path is `oldPath` itself, one of `oldPath`'s own tail
 * segments — `Work/Ideas` and `Ideas` for an old path `Work/Ideas.md`, never
 * `Home/Ideas`, a different note that only shares a basename — or,
 * given `where`, a path that reaches `oldPath` from the log's own folder
 * (`../Work/Ideas`).
 *
 * **A bare tail that changed name is resolved before it is rewritten**. Given `where.resolveBareLink`, a bare link whose name changed asks
 * where its name now opens from the log's own path; if the answer is a
 * different, still-existing note, the link is left exactly as it is — a
 * same-named twin the rename must not retarget. If the answer is nothing, or
 * the renamed note itself, it is rewritten as below. Without
 * `resolveBareLink` every bare link matching the old name is rewritten, as
 * before #895.
 *
 * **What it is rewritten to keeps its shape**. A rename that changed
 * the name writes the new name: a wikilink by name or path becomes `[[newName]]`
 * as it always did; a markdown link keeps how far it was qualified, its
 * `%20`s or `<…>` and its `.md`, and its text follows when the text was the old
 * name; a relative link stays relative. A move that kept the name is a rename for
 * every link that names a folder — the path in the link changes to the new
 * folder, as far qualified as it was — and for none that is a bare name, which
 * still opens the note alone. Without `where` a move has nothing to
 * rewrite, and a link is only ever a name.
 *
 * **Unless the new name is itself shared**. Given
 * `where.nameIsShared`, a name change that the answer says another note
 * already carries writes the link qualified to the renamed note's own full
 * vault path instead of the bare `newName` above — `[[Ideas/Tool shed]]`
 * rather than `[[Tool shed]]`, a markdown or relative link's own shape kept
 * but qualified the same way. Unshared, or with no `nameIsShared` at all,
 * output is exactly as described above.
 */
export function rewriteCollectionLinks(content: string, oldPath: string, newName: string, where?: RenameWhere): string {
	const moved = where !== undefined && stem(where.newPath) !== stem(oldPath);
	if (noteName(oldPath) === newName && !moved) return content;
	const rename: Rename = { oldPath, newName, where };
	const lines = content.split("\n");
	const mayRewrite = where?.frozenLinesOnly === true ? frozenLineTest(lines) : (line: string) => parseTaskLine(line) !== null;
	return lines.map((line, at) => (mayRewrite(line, at) ? rewriteLinksOnLine(line, rename) : line)).join("\n");
}

/**
 * Which lines of a note that is not a day's log may have their link rewritten:
 * a frozen line — the forwarded checkbox `[>]` with a hidden bookkeeping
 * comment, the shape `markerLink.ts` describes — outside the frontmatter and
 * outside fenced text, which are the two places filing refuses a task from.
 * Made once per note, because both are read from the top.
 *
 * A comment is asked by `parseTaskLine`'s own reading, not by the marker's
 * eight-hex-character hash: the core names no feature, and a hand-written line
 * whose comment is shorter is still this rename's to keep current.
 */
function frozenLineTest(lines: readonly string[]): (line: string, lineIndex: number) => boolean {
	const frontmatter = frontmatterEnd(lines);
	const fenced = fencedLines(lines, frontmatter + 1);
	return (line, lineIndex) => {
		if (lineIndex <= frontmatter || fenced[lineIndex]) return false;
		const task = parseTaskLine(line);
		return task !== null && task.checkbox === ">" && task.comments.length > 0;
	};
}

interface Rename {
	readonly oldPath: string;
	readonly newName: string;
	readonly where: RenameWhere | undefined;
}

const stem = (path: string): string => path.replace(/\.md$/iu, "");

/** `oldPath`'s tail segments, longest first: `Work/Ideas.md` gives `["Work/Ideas", "Ideas"]`. */
function oldPathTails(oldPath: string): string[] {
	const segments = stem(oldPath).split("/");
	return segments.map((_, index) => segments.slice(index).join("/"));
}

function rewriteLinksOnLine(line: string, rename: Rename): string {
	let text = line;
	// From the last link to the first, so an earlier link's position is still where it was found.
	for (const link of linksOnLine(line).reverse()) {
		const written = rewrittenLink(link, line.slice(link.start, link.end), rename);
		if (written !== null) text = text.slice(0, link.start) + written + text.slice(link.end);
	}
	return text;
}

/** The link's new text, or null when it names another note or has nothing to change. */
function rewrittenLink(link: LineLink, whole: string, rename: Rename): string | null {
	const { oldPath, newName, where } = rename;
	const path = stem(link.path);
	const relative = path.startsWith("./") || path.startsWith("../");
	const namesOld = oldPathTails(oldPath).includes(path) || (where !== undefined && resolvedFrom(where.logPath, path) === stem(oldPath));
	if (!namesOld) return null;

	const nameChanged = noteName(oldPath) !== newName;
	const bare = !path.includes("/");
	if (!nameChanged && bare) return null;

	// Issue #895: a bare name also names any other note sharing it, wherever it
	// sits, so it is asked where it opens now before being retargeted. Left
	// alone only when that is a different note that still exists — nothing, or
	// the renamed note itself, still means "rewrite as before".
	if (bare && where?.resolveBareLink !== undefined) {
		const opensAt = where.resolveBareLink(path, where.logPath);
		if (opensAt !== null && stem(opensAt) !== stem(where.newPath)) return null;
	}

	// The path the link is to name, without its extension.
	const newStem = where === undefined ? null : stem(where.newPath);

	// Issue #901: a name change into a name another note already carries would
	// leave a bare or under-qualified link open to the same ambiguity #895
	// resolves for the old name — so it is written to the renamed note's own
	// full vault path instead. Only a name change raises the question: a move
	// that kept the name is qualified exactly as before.
	const shared =
		nameChanged && where !== undefined && newStem !== null && where.nameIsShared !== undefined && where.nameIsShared(newName, where.newPath);

	let target: string;
	if (relative && where !== undefined && newStem !== null) target = relativeFrom(where.logPath, newStem);
	else if (where?.writesFullPaths === true && !bare && newStem !== null) target = newStem;
	else if (link.kind === "markdown" && !bare && newStem !== null) target = shared ? newStem : qualifiedTo(newStem, path.split("/").length);
	else if (nameChanged) target = shared && newStem !== null ? newStem : newName;
	else if (newStem !== null) target = qualifiedTo(newStem, path.split("/").length);
	else return null;

	return link.kind === "wikilink" ? wikilinkTo(whole, link, target) : markdownLinkTo(link, target, rename);
}

/**
 * The one thing the rename asks Obsidian's file manager: how a link to a note
 * is written. `FileManager.generateMarkdownLink`
 * (`node_modules/obsidian/obsidian.d.ts:2931`), given as a narrow type so a
 * test can hand in a stub.
 */
export type LinkWriter = Pick<FileManager, "generateMarkdownLink">;

/**
 * Whether the vault's own link setting writes a link from `sourcePath` to
 * `file` as its whole vault path: asked of the file manager rather than of the
 * setting, so it answers for "absolute path in vault" and for a relative vault
 * whose note sits at the root, and for nothing else. A note at the vault root
 * has no folder to keep and answers false. Nothing handed in answers false, so
 * a caller with no file manager writes links as before.
 */
function writesFullPaths(fileManager: LinkWriter | undefined, file: TFile, sourcePath: string): boolean {
	if (fileManager === undefined || !file.path.includes("/")) return false;
	const written = linksOnLine(fileManager.generateMarkdownLink(file, sourcePath))[0];
	return written !== undefined && stem(written.path) === stem(file.path);
}

/** The last `depth` segments of `newStem`, or all of it when it has fewer. */
function qualifiedTo(newStem: string, depth: number): string {
	return newStem.split("/").slice(-depth).join("/");
}

/** The path `path` reaches from the folder of `logPath`, without `.` and `..`; null when it climbs out of the vault. */
function resolvedFrom(logPath: string, path: string): string | null {
	const segments = logPath.split("/").slice(0, -1);
	for (const part of path.split("/")) {
		if (part === "..") {
			if (segments.length === 0) return null;
			segments.pop();
		} else if (part !== ".") {
			segments.push(part);
		}
	}
	return segments.join("/");
}

/** The path from the folder of `logPath` to `targetStem`: `../Ideas/Garden shed` from `Journal/…` to `Ideas/Garden shed`. */
function relativeFrom(logPath: string, targetStem: string): string {
	const from = logPath.split("/").slice(0, -1);
	const to = targetStem.split("/");
	let shared = 0;
	while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
	return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
}

/** `[[old…]]` with only its path replaced: heading, alias and every other byte stay. */
function wikilinkTo(whole: string, link: LineLink, target: string): string {
	const rest = whole.slice(2).replace(/^[^\]|#]+/u, "");
	const extension = /\.md$/iu.test(link.path) ? ".md" : "";
	return `[[${target}${extension}${rest}`;
}

/**
 * `[text](destination "title")` with the destination's path replaced: written
 * the way it was, `%20` or `<…>`, with its heading and title kept. The text is
 * replaced only when it was the old name.
 */
function markdownLinkTo(link: LineLink, target: string, rename: Rename): string {
	const inside = link.written;
	const lead = /^\s*/u.exec(inside)?.[0] ?? "";
	const angled = inside.startsWith("<", lead.length);
	const start = lead.length + (angled ? 1 : 0);
	const stop = angled ? inside.indexOf(">", start) : inside.slice(start).search(/[#\s]|$/u) + start;
	const pathEnd = angled ? Math.min(stop, indexOrEnd(inside.slice(start, stop), "#") + start) : stop;
	const extension = /\.md$/iu.test(link.path) ? ".md" : "";
	const spelled = angled ? `${target}${extension}` : `${target}${extension}`.split("/").map(encodeURIComponent).join("/");
	const written = `${inside.slice(0, start)}${spelled}${inside.slice(pathEnd)}`;
	const text = link.label === noteName(rename.oldPath) ? rename.newName : link.label;
	return `[${text}](${written})`;
}

function indexOrEnd(text: string, char: string): number {
	const at = text.indexOf(char);
	return at === -1 ? text.length : at;
}
