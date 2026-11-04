/**
 * The day view's second write: Obsidian does not update a link inside a fenced
 * code block, so this feature does, for a `schema` block's own links.
 *
 * **The rewrite is carried, with one correction, from
 * `~/Devbox/schema-render/src/writeback.ts:303-359`**: `[[Old]]`,
 * `[[Old|alias]]`, `[[Old\|alias]]` and `[[folder/Old]]` inside a `schema`
 * block become a name that still resolves to the renamed note — a bare link
 * stays bare where the bare new name is safe, a folder-form link keeps the
 * folder it was written with where that still resolves to the renamed note
 * (never dropped merely because the bare name happens to be unique), and
 * otherwise the renamed file's own full vault path; the alias and
 * the table escape are kept as before. A link outside a block is never
 * touched. `renameRewrite` takes every pair renamed in one batch, rather than
 * the old function's one, because the batch itself is built here rather than
 * by a caller.
 *
 * **The scan is scoped** (ticket #23; absorbed old issue #23 of
 * `schema-render`, the vault-wide rescan). The old handler read every Markdown
 * note on every rename (`writeback.ts:207-232`). Here, only a note whose cached
 * sections hold a section of type `code` is read at all — a note Obsidian has
 * not indexed yet is read anyway, since nothing may be missed on a fresh vault
 * — and among those, only one whose text passes the old cheap check (a
 * `schema` fence, and a link to one of the renamed names) is rewritten. Every
 * rewrite goes through the core's queued writer, `host.notes.edit`, never
 * `vault.process` directly, so a rename waits behind whatever else is queued
 * for that file and never overwrites a note the person has open.
 *
 * **The case rule is asked of `Platform` at the rename, never of `process` at
 * load.** The old plugin decided filesystem case sensitivity once, from
 * `process.platform`, when its module loaded (`writeback.ts:13-34`) — a Node
 * global absent on mobile. A rename matches without regard to capitals on
 * Windows and macOS, the two case-insensitive filesystems the old plugin
 * matched; elsewhere, Linux and every phone alike, it does not. Whether
 * `Platform.isMacOS` also answers true on an iPhone is undocumented, so the
 * rule reads `isDesktopApp` together with `isWin` or `isMacOS`: a phone
 * answers *case matters* whatever the other two say, because `isDesktopApp` is
 * false there.
 *
 * **The batch.** A rename anywhere in the vault collects into one pending
 * list; each further rename within 250 ms of the last extends the window
 * rather than starting a second one, so a flurry of renames costs one pass
 * over the vault, not one per rename.
 */

import { Notice, Platform } from "obsidian";
import type { CachedMetadata, TAbstractFile, TFile } from "obsidian";
import { closesFence, openingFence } from "../../core/markdownSections";
import type { FeatureHost } from "../../core/feature";

/** One rename this batch carries: the note's path before and after. */
export interface RenamePair {
	readonly oldPath: string;
	readonly newPath: string;
}

/** How long a rename waits for a further one before the batch runs. */
const RENAME_BATCH_MS = 250;

/** A vault path's name, without its folder or its `.md`. */
function basenameWithoutExt(path: string): string {
	const slash = path.lastIndexOf("/");
	const base = slash === -1 ? path : path.slice(slash + 1);
	return base.replace(/\.md$/i, "");
}

function basenameEquals(a: string, b: string, caseInsensitive: boolean): boolean {
	return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Rewrites every wikilink inside a `schema` block that names one of `pairs`'s
 * old names, to its new one — alias and table escape kept, everything outside
 * a block left exactly as written. Pure, and carried unchanged in shape from
 * `schema-render`'s `replaceLinksInSchemaBlocks`; the pairs loop is what makes
 * one call cover a whole batch.
 *
 * `resolveLink` confirms a basename match against the vault rather than
 * trusting the text alone: a link is rewritten only when resolving
 * its old name finds nothing — not a different note sharing the basename,
 * and not the renamed file itself still answering to its old name (a
 * case-only rename, or a move that kept the basename, on a case-insensitive
 * vault).
 *
 * **Left out entirely, `resolveLink` means "no vault to ask"** — the old,
 * ambiguity-blind behavior this file's own direct tests lean on: every match
 * is trusted and every replacement is the bare new name, since there is
 * nothing to check either against. `rescanRenamedLinks` never leaves it out;
 * every one of its calls passes the real
 * `MetadataCache.getFirstLinkpathDest`, so a caller that does supply a
 * function always gets the checked behavior below — including a caller
 * whose function happens to answer `null` for everything, which is why the
 * matching-by-resolution tests above construct a real stand-in file
 * rather than reusing that shorthand.
 *
 * **The replacement is chosen from the link's own written shape and what the
 * vault says it resolves to, never from `MetadataCache.fileToLinktext`**: `fileToLinktext`
 * answers from the vault's "New link format" setting, which decides what a
 * *freshly inserted* link should look like, not what an *existing* link needs
 * to keep resolving correctly — under "Relative path to file" it can answer a
 * form the next rename's own text match does not recognise, and under
 * "Absolute path in vault" it folder-qualifies a bare link that never needed
 * it. Asking the vault to resolve the exact candidates this rewrite is about
 * to write, instead, answers correctly under every setting without needing
 * to know which one is active. See `rewriteOnePair` for the three candidates
 * and the order they are tried in, and its `onUnresolvedRename` parameter for
 * what happens when the renamed file cannot currently be found at all.
 */
export function renameRewrite(
	content: string,
	pairs: readonly RenamePair[],
	caseInsensitive: boolean,
	resolveLink?: (linktext: string) => TFile | null,
	onUnresolvedRename: (pair: RenamePair) => void = () => {},
): string {
	let updated = content;
	for (const pair of pairs) {
		updated = rewriteOnePair(updated, pair, caseInsensitive, resolveLink, onUnresolvedRename);
	}
	return updated;
}

// The target group excludes `\` so a table-escaped link `[[Old\|alias]]`
// parses correctly; the backslash before the pipe is captured separately and
// written back out, keeping the escape on the rewritten link.
const WIKILINK_RE = /\[\[([^\]|\\]+)(?:(\\?)\|([^\]]+))?\]\]/g;

/**
 * The body-line ranges of every fenced `schema` block: backtick or tilde,
 * by `markdownSections.ts`'s one fence rule, never a second copy of it here.
 *
 * Leading whitespace and `>` quote markers are stripped from each line
 * before the fence rule is asked, the same generosity `registry.ts`'s
 * `holdsBlockOf` uses for the same reason — a `schema` block drawn inside a
 * callout or blockquote is still a block Obsidian renders and rewrites
 * into. A list marker (`-`, `*`, a numbered item) is not stripped; a fence
 * opened on a list line is found only when the marker sits after the
 * whitespace `openingFence` already tolerates. `from`/`to` bracket the body
 * only, the fence lines themselves excluded, since neither ever holds a
 * wikilink.
 */
function schemaBlockRanges(lines: readonly string[]): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const fence = openingFence(lines[i].replace(/^[ \t>]*/, ""));
		if (fence === null) continue;

		let end = lines.length;
		for (let j = i + 1; j < lines.length; j++) {
			if (closesFence(lines[j].replace(/^[ \t>]*/, ""), fence)) {
				end = j;
				break;
			}
		}
		if (isSchemaInfo(fence.info)) ranges.push({ from: i + 1, to: end });
		i = end;
	}

	return ranges;
}

/** Whether a fence's info string names a `schema` block: its first word, capitals ignored. */
function isSchemaInfo(info: string): boolean {
	return (info.split(/\s+/)[0] ?? "").toLowerCase() === "schema";
}

/**
 * The replacement candidates, tried in order, for a link already confirmed to
 * name the renamed file and need rewriting:
 *
 * 1. The renamed file itself has to be findable at all — resolving its own
 *    new path, an exact vault path nothing else can answer to. When it is
 *    not, the note has moved again since this rewrite was queued: rather than
 *    guess, this reports the pair through `onUnresolvedRename` and leaves the
 *    link exactly as written — a stale link the person can still see and fix
 *    beats a fresh one silently pointing at the wrong note.
 * 2. A link written with a folder (`targetTrimmed` contains `/`) keeps that
 *    folder with the new basename, provided the combination still resolves
 *    to the renamed file — never dropped merely because the bare name would
 *    also have been unique.
 *    A bare link tries the bare new name on the same terms.
 * 3. Otherwise — the written folder no longer matches where the file lives,
 *    or a bare name resolves to a different note sharing it — the renamed
 *    file's own full vault path, which nothing else can answer to.
 *
 * `resolveLink(candidate)` is compared by `.path` rather than by reference:
 * the real `MetadataCache.getFirstLinkpathDest` answers with whatever `TFile`
 * it currently holds, not necessarily the same object two calls apart, and
 * comparing by path is what "the renamed file" actually means here.
 */
function chooseReplacement(
	targetTrimmed: string,
	newBasename: string,
	newPathWithoutExt: string,
	resolveLink: (linktext: string) => TFile | null,
	pair: RenamePair,
	onUnresolvedRename: (pair: RenamePair) => void,
): string | null {
	const renamedFile = resolveLink(newPathWithoutExt);
	if (renamedFile === null) {
		onUnresolvedRename(pair);
		return null;
	}
	const folderSlash = targetTrimmed.lastIndexOf("/");
	const writtenFolder = folderSlash === -1 ? null : targetTrimmed.slice(0, folderSlash);
	const candidate = writtenFolder === null ? newBasename : `${writtenFolder}/${newBasename}`;
	const candidateResolves = resolveLink(candidate)?.path === renamedFile.path;
	return candidateResolves ? candidate : newPathWithoutExt;
}

function rewriteOnePair(
	content: string,
	pair: RenamePair,
	caseInsensitive: boolean,
	resolveLink: ((linktext: string) => TFile | null) | undefined,
	onUnresolvedRename: (pair: RenamePair) => void,
): string {
	const oldBasename = basenameWithoutExt(pair.oldPath);
	const oldPathWithoutExt = pair.oldPath.replace(/\.md$/i, "");
	const newPathWithoutExt = pair.newPath.replace(/\.md$/i, "");
	const newBasename = basenameWithoutExt(pair.newPath);

	const lines = content.split("\n");
	for (const range of schemaBlockRanges(lines)) {
		for (let i = range.from; i < range.to; i++) {
			lines[i] = lines[i].replace(WIKILINK_RE, (fullMatch, target: string, pipeEscape: string | undefined, alias: string | undefined) => {
				const targetTrimmed = target.trim();
				const targetBasename = basenameWithoutExt(targetTrimmed);
				const looksLikeOldName =
					basenameEquals(targetBasename, oldBasename, caseInsensitive) ||
					basenameEquals(targetTrimmed, oldPathWithoutExt, caseInsensitive);
				if (!looksLikeOldName) return fullMatch;
				// The text alone is ambiguous — B/Old.md matches Old.md's basename
				// too. Resolving the link against the vault, the way Obsidian
				// itself would, tells them apart: a link that still resolves points
				// at a note that answers to the old name right now — a different
				// note sharing the basename, or the renamed file itself still
				// answering to it (a case-only rename, or a move that kept the
				// basename) — and either way is left as it is. Left out entirely,
				// `resolveLink` means no vault to ask, so nothing can be ambiguous.
				if (resolveLink !== undefined && resolveLink(targetTrimmed) !== null) return fullMatch;
				const replacement =
					resolveLink === undefined
						? newBasename
						: chooseReplacement(targetTrimmed, newBasename, newPathWithoutExt, resolveLink, pair, onUnresolvedRename);
				if (replacement === null) return fullMatch;
				return alias !== undefined ? `[[${replacement}${pipeEscape ?? ""}|${alias}]]` : `[[${replacement}]]`;
			});
		}
	}
	return lines.join("\n");
}

/**
 * Whether a rename matches without regard to capitals here: Windows and macOS
 * desktop do, Linux desktop and every phone do not. Read inside this function,
 * never while a module loads — `Platform` answers for the running device, and
 * a module-load read would be the Node-global mistake this replaces.
 */
export function isCaseInsensitiveRename(): boolean {
	return Platform.isDesktopApp && (Platform.isWin || Platform.isMacOS);
}

/**
 * A root-level section type under which a fenced `schema` block could sit,
 * whether the block itself is that root section or nested inside it.
 */
const SCHEMA_CONTAINER_TYPES = new Set(["code", "callout", "blockquote", "list"]);

/**
 * Whether `cache` says the note might hold a fenced code block worth reading —
 * a fast path only, over-inclusive on purpose. `looksRenamable` below is the
 * real gate: a `schema` block's own root section reads `code`, and one nested
 * inside a callout, blockquote or list reads as that container's type instead
 * (`SectionCache.type`'s union includes them, `node_modules/obsidian/obsidian.d.ts:5679`),
 * so a cache holding any of those is worth reading.
 */
function mayHoldSchemaLink(cache: CachedMetadata | null): boolean {
	if (cache === null) return true;
	return (cache.sections ?? []).some((section) => SCHEMA_CONTAINER_TYPES.has(section.type));
}

/**
 * The real gate: a fenced `schema` block by `markdownSections.ts`'s one fence
 * rule — backtick or tilde, any case, leading whitespace and `>` quote
 * markers stripped first — and a link to one of `pairs`'s old names anywhere
 * in the note. The link
 * check does not confine itself to the block's own lines: it is a cheap
 * over-inclusive filter, and `renameRewrite`'s block ranges are what actually
 * decide what gets rewritten.
 */
function looksRenamable(content: string, pairs: readonly RenamePair[], caseInsensitive: boolean): boolean {
	if (!hasSchemaFence(content)) return false;
	return pairs.some((pair) => containsLinkToOldName(content, pair, caseInsensitive));
}

function hasSchemaFence(content: string): boolean {
	return content.split("\n").some((line) => {
		const fence = openingFence(line.replace(/^[ \t>]*/, ""));
		return fence !== null && isSchemaInfo(fence.info);
	});
}

function containsLinkToOldName(content: string, pair: RenamePair, caseInsensitive: boolean): boolean {
	const oldBasename = basenameWithoutExt(pair.oldPath);
	const oldPathWithoutExt = pair.oldPath.replace(/\.md$/i, "");
	const candidates = oldPathWithoutExt === oldBasename ? [oldBasename] : [oldBasename, oldPathWithoutExt];

	const haystack = caseInsensitive ? content.toLowerCase() : content;
	return candidates.some((candidate) => {
		const needle = caseInsensitive ? candidate.toLowerCase() : candidate;
		return haystack.includes(`[[${needle}]]`) || haystack.includes(`[[${needle}|`) || haystack.includes(`[[${needle}\\|`);
	});
}

/**
 * Runs one batch: scopes the scan to notes that may hold a `schema` block,
 * reads each with the vault's cache rather than the writer, and hands only a
 * note that actually names one of `pairs` to the core's note writer.
 *
 * Every candidate's read-then-edit runs concurrently, each started without
 * waiting for another to finish. The writer already queues per file and holds
 * a write to the note the person has open until they leave it
 * (`NoteWriter.edit`); starting every edit up front, rather than one at a
 * time, means one held note no longer stalls the rest of the batch behind it.
 *
 * `inFlightEdits` orders a file against an earlier, still-unsettled batch —
 * #683. A candidate whose
 * path is already in the map waits for that earlier edit to land before doing
 * its own `cachedRead`, so its decision reads what that edit leaves behind
 * rather than a stale snapshot from before it landed — the ordering
 * #672 needs. A candidate
 * with no entry carries nothing to wait for, so an unrelated file a previous
 * batch is still holding open never delays it. `createRenameListener` keeps
 * one map for the whole listener's life and passes it to every batch; a
 * direct call, this file's own tests included, gets a fresh one and behaves
 * exactly as before.
 *
 * One file's failure — `NoteWriter.teardown` rejecting a held write on
 * unload, say — is caught where it happens rather than stopping the batch:
 * every other candidate still runs, and a `Notice` names whichever notes were
 * not updated. The returned promise never rejects, so a caller can await it.
 *
 * A pair whose renamed file cannot be resolved at rewrite time gets its own
 * `Notice`, naming the note by its old and new path and every file a link to
 * it was left in:
 * `chooseReplacement` never guesses a bare name for it, so this is the only
 * place the person learns a link was left stale. One `Notice` per pair, not
 * per link or per file, since several links across several files can all
 * report the same unresolved pair.
 */
export async function rescanRenamedLinks(
	host: FeatureHost,
	pairs: readonly RenamePair[],
	inFlightEdits: Map<string, Promise<void>> = new Map(),
): Promise<void> {
	if (pairs.length === 0) return;

	const caseInsensitive = isCaseInsensitiveRename();
	const { vault, metadataCache } = host.app;
	const candidates: TFile[] = vault
		.getMarkdownFiles()
		.filter((file) => mayHoldSchemaLink(metadataCache.getCache(file.path)));

	const failed: TFile[] = [];
	const unresolved = new Map<string, { pair: RenamePair; files: Set<string> }>();
	await Promise.all(
		candidates.map(async (file) => {
			await (inFlightEdits.get(file.path) ?? Promise.resolve());
			try {
				const cached = await vault.cachedRead(file);
				if (!looksRenamable(cached, pairs, caseInsensitive)) return;
				const editPromise = host.notes.edit(file, (content) =>
					renameRewrite(
						content,
						pairs,
						caseInsensitive,
						(linktext) => metadataCache.getFirstLinkpathDest(linktext, file.path),
						(pair) => {
							const key = `${pair.oldPath} ${pair.newPath}`;
							const entry = unresolved.get(key) ?? { pair, files: new Set<string>() };
							entry.files.add(file.path);
							unresolved.set(key, entry);
						},
					),
				);
				const settled = editPromise.then(
					() => undefined,
					() => undefined,
				);
				inFlightEdits.set(file.path, settled);
				try {
					await editPromise;
				} finally {
					if (inFlightEdits.get(file.path) === settled) inFlightEdits.delete(file.path);
				}
			} catch {
				failed.push(file);
			}
		}),
	);

	if (failed.length > 0) {
		new Notice(
			`Effortless could not update ${failed.length === 1 ? "this note" : "these notes"} after the rename: ${failed
				.map((file) => file.path)
				.join(", ")}`,
		);
	}

	for (const { pair, files } of unresolved.values()) {
		new Notice(
			`Effortless could not find the renamed note (was ${pair.oldPath}, now ${pair.newPath}) to update ${files.size === 1 ? "a link to it" : "the links to it"} in: ${[...files].join(", ")}`,
		);
	}
}

/**
 * The vault's `rename` handler, with a `cancel` the feature calls from its own
 * unload: the
 * batch timer is a bare `setTimeout`, outside anything `registerEvent` alone
 * detaches, so switching Day view off would otherwise leave a pending batch
 * to run — and write — after the feature is gone.
 */
export interface RenameListener {
	(file: TAbstractFile, oldPath: string): void;
	/** Drops a pending batch whose 250 ms timer has not fired yet. A batch already handed to `rescanRenamedLinks` keeps running; `cancel` does not reach it. */
	cancel(): void;
}

/**
 * Builds the vault's `rename` handler: collects renames into one pending list
 * and runs {@link rescanRenamedLinks} once, 250 ms after the last one in the
 * batch. Register the result with `this.registerEvent(host.app.vault.on(...))`
 * from the feature's `onload`, so it detaches with the rest on the switch, and
 * call its `cancel` from that same `onload`'s `this.register` so a batch that
 * outlives the switch never runs.
 *
 * **Every batch shares one `inFlightEdits` map for the listener's whole
 * life**: a batch decides
 * whether a note needs rewriting from a `vault.cachedRead` taken at scan
 * time, so a batch that reads a file an earlier batch is still writing could
 * read stale text and skip a link the earlier batch was about to leave
 * pointing at a name that no longer exists — a rename and a quick rename
 * back, say. `rescanRenamedLinks` orders that one file against the earlier
 * batch's edit through the shared map, without making the rest of this
 * batch wait for it: a batch is handed to `rescanRenamedLinks` the moment
 * its own 250 ms window closes, never delayed by an earlier batch still
 * running.
 */
export function createRenameListener(host: FeatureHost): RenameListener {
	let pending: RenamePair[] = [];
	let timer: number | null = null;
	let cancelled = false;
	const inFlightEdits = new Map<string, Promise<void>>();

	const listener = ((file, oldPath) => {
		// A folder, or any file that is not a note, names nothing a schema link
		// can point at, so it never becomes a rename pair.
		if ("children" in file || !file.path.endsWith(".md")) return;
		pending.push({ oldPath, newPath: file.path });
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			const pairs = pending;
			pending = [];
			if (!cancelled) void rescanRenamedLinks(host, pairs, inFlightEdits);
		}, RENAME_BATCH_MS);
	}) as RenameListener;

	listener.cancel = () => {
		cancelled = true;
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
		pending = [];
	};

	return listener;
}
