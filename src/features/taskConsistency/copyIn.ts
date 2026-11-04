/**
 * The one thing task consistency does unasked: every open,
 * unpaired task under a collection's tasks heading whose scheduled or due
 * date is today or earlier is copied into today's log, under the overdue
 * heading if its date is before today and under the today heading otherwise.
 *
 * A pure function over text. No vault, no app, no clock read from the
 * global — `today` is handed in, the way {@link windowDates} in
 * `src/features/daysAhead/window.ts` takes it, and every date is compared as
 * a local calendar day (`YYYY-MM-DD`), never through `toISOString` (the
 * #618/#687 rule). Nothing here states the task-line format a second time:
 * every field read or written goes through `../../core/taskLine`, and the
 * fence-and-heading rule goes through `../../core/markdownSections` and
 * `../../core/vaultLayout`.
 *
 * **Which date wins when a task carries both.** The old plugin's own rule,
 * carried unchanged since nothing in spec #709 revisits it: scheduled wins
 * over due when both are present
 * (`docs/research/effortless-code-audit.md`, assumption 11, `computeSync.ts:140-146`).
 * It is the core's {@link relevantDate} in `../../core/taskLine`, imported here
 * and by roll-over rather than stated twice, because Review's followed-tasks
 * reader orders by it too and may not import from this feature.
 *
 * **The type the ticket calls `LocalDate`.** No such type exists in this
 * repository; `today` is typed `Date` and read the same way
 * `daysAhead/window.ts` and `daysAhead/desiredRows.ts` already read a local
 * day — local year, month and day, ignoring the clock time. Recorded here
 * rather than guessed at silently.
 *
 * **A collection's tasks heading carries no level, and is matched ignoring
 * one** (issue #29 C3: "different collections may use different heading
 * sizes"). `../../core/markdownSections`'s `headingRange` needs a level, so
 * {@link collectionHeadingRange} asks it once per level and takes whichever
 * one answers — never a second reading of the fence-and-heading rule itself,
 * only a second *call* to the one function that owns it.
 *
 * **A blank today or overdue heading is switched off, not redirected**
 * (issue #816: a blank
 * heading text "drops that section out of the frame"). A task whose date
 * would send it to a blank heading is left uncopied rather than sent to the
 * other section — nothing in spec #709 says a blanked-out section's tasks
 * spill into the section beside it, and doing that silently would be a
 * placement rule invented here rather than decided on the ticket.
 *
 * **A paired task with no live line in `logText` is copied again, keeping its
 * eid** (#809, ADR 0002:
 * the log holds no state of its own, so deleting a line does nothing to the
 * collection and the task simply reappears on the next relevant run). A
 * marker on the collection's own line no longer means "already live
 * somewhere" by itself — {@link category} also asks whether `logText`
 * currently carries a task with that same eid, via {@link collectLogEids},
 * and only excludes a paired task while it still does. A paired task whose
 * meaning is `done`, `cancelled` or already `forwarded` is never a
 * candidate either way: finishing a task is not the same event as losing its
 * log line, and a task this feature itself forwarded is not "missing", it is
 * frozen on purpose.
 *
 * **A line is "live" in `logText` while it reads anything other than
 * forwarded**: a `[>]` line —
 * whether roll-over, a reschedule from the log, or a hand-typed one — is
 * frozen and no longer the live copy (`reconcile.ts`'s own words), so
 * {@link collectLogEids} does not count it. Otherwise a rescheduled or
 * hand-forwarded task, once frozen, would keep its own paired collection line
 * excluded forever with no live line anywhere to show for it. A `[x]`/`[-]`
 * line is live by this same rule — {@link collectLogEids}'s own doc comment
 * says why, and what excluding it used to break.
 *
 * **A paired collection line reading `open` is re-copied the same as one
 * reading `copied`**:
 * `rollOver.ts`'s own `LIVE_MEANINGS` already treats the two the same way,
 * and the code itself can leave a paired line reading `open` —
 * `reconcile.ts`'s `applyFields` carries a genuine tick back through it, and
 * a person can untick a `[/]` that looks wrong by hand just as easily.
 * {@link copyTaskLine} is where the eid is reused rather than freshly
 * minted, and where the log's own copy is forced back to an open checkbox,
 * since a re-copy's source line may already read the collection's own
 * `copied` mark rather than the first copy's original `open` one.
 */

import { headingRange, clampLevel } from "../../core/markdownSections";
import type { SectionRange } from "../../core/markdownSections";
import { withoutAppendedLink } from "../../core/markerLink";
import type { VaultLayout } from "../../core/settings";
import { editTaskField, parseTaskLine, relevantDate, setComment } from "../../core/taskLine";
import type { TaskLine } from "../../core/taskLine";
import { insertionLineForMissingSection, sectionRange } from "../../core/vaultLayout";
import { newEid, readMarker, snapshotOf, writeMarker } from "./marker";

/** What one call to {@link copyIn} produces. */
export interface CopyInResult {
	/** `collectionText` again, with every task copied out marked `/` and carrying the pairing marker. */
	readonly collection: string;
	/** `logText` again, with every copied task and any needed context bullet added under the right heading. */
	readonly log: string;
	/** How many tasks were copied — context bullets, which carry no marker, are not counted. */
	readonly copied: number;
}

/**
 * Copies every open, unpaired, due-or-overdue task under `layout.tasksHeading`
 * in `collectionText` into `logText`, and marks each one copied in
 * `collectionText`.
 *
 * Idempotent: a task copied on an earlier call now reads `/` (`copied`), not
 * `open`, so a second call over the same pair of texts finds nothing left to
 * copy and returns both strings unchanged.
 *
 * **`heldEids`**:
 * a paired task whose eid is in this set is never a candidate, whatever its
 * own date or meaning reads — `run.ts`'s own `reconcileAgainstOldLog` found it
 * clashing against an earlier day's log this same run, and a re-copy here
 * would put a fresh, open line into today's log for a task that pairing's own
 * report says is still unresolved. Empty by default, for every caller that is
 * not `run.ts`'s own `runOverCollection`.
 */
export function copyIn(
	collectionText: string,
	logText: string,
	today: Date,
	layout: VaultLayout,
	collectionName: string,
	heldEids: ReadonlySet<string> = new Set(),
): CopyInResult {
	const todayKey = localDateKey(today);
	const logEids = collectLogEids(logText);

	const tasksRange = collectionHeadingRange(collectionText, layout.tasksHeading);
	if (tasksRange === null) return { collection: collectionText, log: logText, copied: 0 };

	// A collection's own heading carries no level, so a
	// completed-tasks heading nested *deeper* than the tasks heading would
	// otherwise still sit inside the range `headingRange` found — deeper
	// headings stay inside a section by that rule's own design. Clipping to
	// whichever comes first is what keeps a completed task out regardless.
	//
	// Not `collectionHeadingRange`'s own "first level that matches" pick: a completed-tasks heading written shallower than, and above,
	// the tasks heading encloses it — `headingRange`'s own "runs to the next
	// heading of the same or a shallower level" rule never stops at a
	// *deeper* tasks heading below it — and trying every level from 1 up
	// would find that enclosing one first, leaving a second, legitimately
	// nested completed-tasks heading further down never looked at.
	// {@link nestedHeadingRange} only accepts a match that actually sits
	// inside `tasksRange`.
	const completedRange = nestedHeadingRange(collectionText, layout.completedTasksHeading, tasksRange);
	const tasksEnd = completedRange !== null ? completedRange.heading : tasksRange.end;

	const collectionLines = splitLines(collectionText);
	const roots = buildTree(collectionLines, tasksRange.start, tasksEnd);

	// One pass per root, not one per section: a node's own date decides
	// at most one section to anchor in, and everything under it — however each
	// descendant's own date reads — travels with it. Deciding this once, rather
	// than asking each node "do you belong under today" and "do you belong
	// under overdue" as two independent questions, is what stops a due node
	// from answering "no" to one and falling back to a context bullet there
	// while still answering "yes" to the other.
	const edits = new Map<number, string>();
	const perRoot = roots.map((root) => emitNode(root, todayKey, layout, collectionName, edits, logEids, heldEids));

	let log = logText;
	let copied = 0;

	for (const target of ["overdue", "today"] as const) {
		const sectionName = target === "overdue" ? "overdueHeading" : "todayHeading";
		const emitted = perRoot.map((result) => result[target]).filter((result): result is Emitted => result !== null);
		if (emitted.length === 0) continue;

		const lines: string[] = [];
		for (const result of emitted) lines.push(...result.lines);
		log = ensureHeadingWithBody(log, sectionName, layout, lines);
		copied += emitted.reduce((sum, result) => sum + result.copies, 0);
	}

	if (edits.size === 0) return { collection: collectionText, log, copied };

	const editedLines = [...collectionLines];
	for (const [index, value] of edits) editedLines[index] = value;
	return { collection: joinLines(editedLines), log, copied };
}

/** `date`, read from its local year, month and day — the same rule `daysAhead/desiredRows.ts`'s own `localDateKey` follows, carried rather than imported: a feature may not reference another. */
function localDateKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Every eid `logText` currently carries a *live* task line for — what
 * {@link category} asks to tell "still live somewhere in the log" apart from
 * "paired, but the log line is gone or frozen" (#809, ADR 0002). A line that
 * fails to parse or carries no marker of this feature's own contributes
 * nothing.
 *
 * **A `[>]` (forwarded) line is not live**: once a line is
 * frozen it is no longer the live copy (`reconcile.ts`'s own words), whoever
 * wrote the `[>]` — this feature's own roll-over or reschedule logic, or a
 * person typing it by hand. Counting it anyway would keep the paired
 * collection line excluded for good, with no live line anywhere in the log
 * to show for it. Exported for `rollOver.ts`'s own use: the same "is
 * it live in the log" question decides whether a roll-over candidate needs a
 * fresh copy at all.
 *
 * **A `[x]`/`[-]` line is live**: a task ticked or cancelled directly
 * in the log is finished, not missing, and excluding it here — treating it
 * the same as a genuinely deleted or frozen line — is what let `copyIn`
 * re-copy a fresh, open duplicate ahead of the tick before `reconcileAll`
 * ever saw it.
 */
export function collectLogEids(logText: string): ReadonlySet<string> {
	const eids = new Set<string>();
	for (const line of splitLines(logText)) {
		const parsed = parseTaskLine(line);
		if (parsed === null) continue;
		if (parsed.meaning === "forwarded") continue;
		const marker = readMarker(parsed);
		if (marker !== null) eids.add(marker.eid);
	}
	return eids;
}

/**
 * Which section `line`'s own date would send it to, or `null` when it is not
 * a candidate at all — read on its own, with no regard for whether that
 * section's heading is actually switched on.
 *
 * An unpaired line is a candidate exactly as before: open, and due. A paired
 * line is a candidate only when its own eid is missing from `logEids` — its
 * earlier log line was deleted, rescheduled and frozen, or forwarded by hand — and only while its own meaning still reads `open` or
 * `copied` (#843, matching `rollOver.ts`'s own `LIVE_MEANINGS`): `done`,
 * `cancelled` or already `forwarded` are finished or frozen, not a task whose
 * log line needs recreating. A paired line whose eid is in `heldEids` is
 * never a candidate either, whatever `logEids` or its own meaning read
 * (#961, see {@link copyIn}'s own doc comment).
 */
function category(line: TaskLine, todayKey: string, logEids: ReadonlySet<string>, heldEids: ReadonlySet<string>): "today" | "overdue" | null {
	const marker = readMarker(line);
	if (marker === null) {
		if (line.meaning !== "open") return null;
	} else {
		if (heldEids.has(marker.eid)) return null;
		if (logEids.has(marker.eid)) return null;
		if (line.meaning !== "copied" && line.meaning !== "open") return null;
	}
	const date = relevantDate(line);
	if (date === null || date > todayKey) return null;
	return date < todayKey ? "overdue" : "today";
}

/**
 * Which section `line` may anchor a family in — its own {@link category}, or
 * `null` when that section's heading is blank (issue #816: a blank heading
 * "drops that section out of the frame", and a task whose date would send it
 * there is left uncopied rather than redirected). Only an anchor's own
 * section has to be switched on: a due descendant nested under one travels
 * with it regardless of what its own date would have said on its own — see
 * {@link collectDueFamily}.
 */
function dueTarget(
	line: TaskLine,
	todayKey: string,
	layout: VaultLayout,
	logEids: ReadonlySet<string>,
	heldEids: ReadonlySet<string>,
): "today" | "overdue" | null {
	const own = category(line, todayKey, logEids, heldEids);
	if (own === null) return null;
	const sectionName = own === "overdue" ? "overdueHeading" : "todayHeading";
	return layout[sectionName].text.trim() ? own : null;
}

/** One task line under the tasks heading, and the task lines nested under it by indentation. */
interface TaskNode {
	readonly line: TaskLine;
	/** Its index into the line array the collection was split into, for the one edit `emit` may make there. */
	readonly lineIndex: number;
	readonly children: TaskNode[];
}

/**
 * Every task line in `lines[start, end)`, nested by indentation depth. A line
 * that is not a task line — a blank line, a note under the heading, prose —
 * is skipped for the purpose of the tree and never appears in it, but does
 * not reset which task is the current parent.
 */
function buildTree(lines: readonly string[], start: number, end: number): TaskNode[] {
	const roots: TaskNode[] = [];
	const stack: TaskNode[] = [];

	for (let index = start; index < end; index += 1) {
		const parsed = parseTaskLine(lines[index]);
		if (parsed === null) continue;

		const node: TaskNode = { line: parsed, lineIndex: index, children: [] };
		while (stack.length > 0 && stack[stack.length - 1].line.indent.length >= parsed.indent.length) {
			stack.pop();
		}
		(stack.length === 0 ? roots : stack[stack.length - 1].children).push(node);
		stack.push(node);
	}

	return roots;
}

/** What one node contributes to one category's block: the lines to write, and how many are real copies. */
interface Emitted {
	readonly lines: readonly string[];
	readonly copies: number;
}

/** `node`'s contribution to each of the two sections — at most one is non-null, since a node anchors at most one family (see {@link emitNode}). */
interface NodeResult {
	readonly today: Emitted | null;
	readonly overdue: Emitted | null;
}

/**
 * `node`'s contribution to the log: which section it anchors a family in, if
 * any, or which sections its not-due bullet reaches through its children.
 *
 * A node whose own date anchors a section ({@link dueTarget}) is copied whole
 * into that one section — its collection line marked `/` and given the
 * pairing marker, its log line the same raw text plus the marker and the
 * collection-name breadcrumb (decision 8) — and every due descendant,
 * whatever *its own* date says, is gathered under it there by
 * {@link collectDueFamily}. Ticket #833: spec #709 decision 10 says "a due
 * subtask under a due parent is copied indented under the parent's copy"
 * without saying which section wins when the two disagree, and the parent's
 * own date is the one already chosen to open a section at all, so the family
 * follows it rather than splitting by each member's own date.
 *
 * A node that is not itself due (or whose own date would send it to a
 * switched-off heading) contributes no family of its own; each child is
 * asked the same question, and a plain context bullet carrying this node's
 * own words is added to a section only where at least one child reached it —
 * spec #709 decision 10, and #27 D8's "three due children of one not-due
 * parent share one context bullet" and "one bullet per parent per section".
 * A node with no due descendants in either section is left out of the log
 * entirely — it stays in the collection, untouched.
 */
function emitNode(
	node: TaskNode,
	todayKey: string,
	layout: VaultLayout,
	collectionName: string,
	edits: Map<number, string>,
	logEids: ReadonlySet<string>,
	heldEids: ReadonlySet<string>,
): NodeResult {
	const anchor = dueTarget(node.line, todayKey, layout, logEids, heldEids);
	if (anchor !== null) {
		const family = collectDueFamily(node.children, todayKey, collectionName, edits, logEids, heldEids);
		const result: Emitted = { lines: [copyTaskLine(node, collectionName, edits), ...family.lines], copies: 1 + family.copies };
		return anchor === "overdue" ? { today: null, overdue: result } : { today: result, overdue: null };
	}

	const childResults = node.children.map((child) => emitNode(child, todayKey, layout, collectionName, edits, logEids, heldEids));
	return {
		today: bulletFor(node.line, childResults.map((result) => result.today)),
		overdue: bulletFor(node.line, childResults.map((result) => result.overdue)),
	};
}

/** One section's contribution from a not-due node: its context bullet over whichever of `childContributions` are non-null, or `null` when none are. */
function bulletFor(line: TaskLine, childContributions: readonly (Emitted | null)[]): Emitted | null {
	const present = childContributions.filter((contribution): contribution is Emitted => contribution !== null);
	if (present.length === 0) return null;

	const lines: string[] = [];
	for (const contribution of present) lines.push(...contribution.lines);
	return { lines: [contextBulletLine(line), ...lines], copies: present.reduce((sum, contribution) => sum + contribution.copies, 0) };
}

/**
 * Every due descendant of `nodes`, nested by depth, for {@link emitNode} to
 * hang under a family's own anchor. Unlike `emitNode`'s own top-level
 * question, a member here is included by {@link category} alone — whether it
 * is due at all, ignoring which section its own date would name — because it
 * is not being placed on its own; it is travelling with an ancestor already
 * anchored in a section that is switched on (#833's own decision, see
 * {@link emitNode}). A not-due node with a due descendant still gets its own
 * context bullet nested in here, the same rule read one level further down
 * rather than a second one.
 */
function collectDueFamily(
	nodes: readonly TaskNode[],
	todayKey: string,
	collectionName: string,
	edits: Map<number, string>,
	logEids: ReadonlySet<string>,
	heldEids: ReadonlySet<string>,
): Emitted {
	const lines: string[] = [];
	let copies = 0;
	for (const node of nodes) {
		const childResult = collectDueFamily(node.children, todayKey, collectionName, edits, logEids, heldEids);
		if (category(node.line, todayKey, logEids, heldEids) !== null) {
			lines.push(copyTaskLine(node, collectionName, edits), ...childResult.lines);
			copies += 1 + childResult.copies;
		} else if (childResult.lines.length > 0) {
			lines.push(contextBulletLine(node.line), ...childResult.lines);
			copies += childResult.copies;
		}
	}
	return { lines, copies };
}

/**
 * `node`'s own copy: marks its collection line `/` and gives it a pairing
 * marker (`edits`), and returns the log line — the same raw text plus that
 * marker and the collection-name breadcrumb (decision 8).
 *
 * **The eid is reused, not freshly minted, when `node.line` already carries
 * one**: a task whose earlier log line was deleted is recreated as the
 * same pairing, not a new one, so the marker `readMarker` already finds is
 * kept and only its hash refreshed. A task never paired before gets
 * {@link newEid}'s fresh one, exactly as before.
 *
 * **The log's own copy always starts open**, whatever `node.line`'s own
 * checkbox currently reads. For a first copy that is already true — the
 * source is `open` by {@link category}'s own rule — but a re-copy's source
 * reads the collection's `copied` mark (`/`), and that bookkeeping character
 * is this feature's own, never a person's or the log's, so it must not
 * become the fresh line's checkbox either.
 *
 * **The link Migration appends back to the day's log it filed from does not
 * travel** (#906, decision
 * settled on the ticket: a copy Task consistency makes links to the
 * collection, never to the day the task was originally filed from). Told
 * apart from a link the person typed by `src/core/markerLink.ts`'s own rule
 * rather than re-derived here: a feature never references another, so this reads
 * the shape of the line, not Migration's own marker — {@link liveCopyBase}.
 * The collection's own line, marked `/` below, keeps the link back — only the
 * log's fresh copy drops it.
 */
function copyTaskLine(node: TaskNode, collectionName: string, edits: Map<number, string>): string {
	const eid = readMarker(node.line)?.eid ?? newEid();

	const collectionRaw = editTaskField(node.line.raw, "checkbox", "/");
	const collectionParsed = parseTaskLine(collectionRaw);
	if (collectionParsed === null) {
		throw new Error(`marking a task copied left it unparseable: ${JSON.stringify(collectionRaw)}`);
	}
	// The hash recorded is the collection's own, "as copied" — the state
	// its own line reads the moment this feature marks it `/`, per spec
	// #709 decision 10's own words. The log line is handed the same
	// eid and hash rather than one of its own: decision 10 writes "the
	// same marker" onto both.
	const hash = snapshotOf(collectionParsed).hash;
	edits.set(node.lineIndex, writeMarker(collectionRaw, eid, hash));

	const openRaw = liveCopyBase(node.line.raw);
	const logWithBreadcrumb = insertVisibleText(openRaw, `[[${collectionName}]]`);
	return writeMarker(logWithBreadcrumb, eid, hash);
}

/**
 * The text a live copy starts from, given the collection's own current line:
 * any link Migration appended before its own marker dropped, and the
 * checkbox reset to open. **The one place both copy paths ask** — this
 * feature's first copy, above, and roll-over's fresh copy — so a third copy
 * path added later cannot miss the rule a second time by re-deriving it.
 */
export function liveCopyBase(collectionRaw: string): string {
	return editTaskField(withoutAppendedLink(collectionRaw), "checkbox", " ");
}

/**
 * The one plain bullet a not-due parent of a due task gets: its own words,
 * no checkbox, no marker. `line.description` (`taskLine.ts`) is everything
 * after the checkbox with only separating whitespace dropped, comments
 * included — so a parent that was itself paired earlier carries its own
 * `%% task-consistency:… %%` comment there, and every comment is stripped
 * before the bullet is built: the bullet is the parent's words, never
 * a second copy of its bookkeeping.
 *
 * Exported for `rollOver.ts`'s own use: a rolled subtask whose parent
 * is not itself live gets the same context bullet a first copy would have
 * given it, rather than a second copy of this rule.
 */
export function contextBulletLine(line: TaskLine): string {
	let description = line.description;
	for (const comment of line.comments) description = description.split(comment).join("");
	return `${line.indent}${line.marker} ${description.replace(/\s+$/u, "")}`;
}

const INSERTION_PROBE_ID = "copy-in-insertion-probe";

/**
 * `raw` with `text` inserted as visible words: after what the task says,
 * before any trailing `%% … %%` comment and before any trailing whitespace —
 * `taskLine.ts`'s own `insertionPoint`, private to that module and asked for
 * rather than restated here.
 *
 * The collection-name breadcrumb is visible text and not one of the five
 * fields `reconcilePair` copies (#709 decision 8; decision 8's own table also
 * lists the hidden marker, but that marker's own row says it is "never
 * copied as text" — it travels by eid, not by value, so it is not counted
 * here), so there is no field editor in the core to
 * ask for it directly. Found instead by asking `setComment` to add a
 * throwaway comment of this feature's own and reading back where it landed:
 * `addField` always inserts at that same point, so the point it chose for the
 * probe is the point `raw` itself would use.
 *
 * Exported for `rollOver.ts`'s own use:
 * the roll-over move writes the collection-name breadcrumb onto a freshly
 * built log line exactly the way a first copy does, and this is the one
 * place that rule is stated.
 */
export function insertVisibleText(raw: string, text: string): string {
	const probed = setComment(raw, INSERTION_PROBE_ID, "x");
	const probe = ` %% ${INSERTION_PROBE_ID}:x %%`;
	const at = probed.indexOf(probe);
	if (at === -1) {
		throw new Error(`could not find where a field is added on: ${JSON.stringify(raw)}`);
	}
	return `${raw.slice(0, at)} ${text}${raw.slice(at)}`;
}

/**
 * Where `headingText` opens a section in `content`, matched at whichever
 * level it is actually written at — a collection's own heading carries no
 * level and different collections may use different sizes, so every
 * level from 1 to 6 is tried and the first match wins. Calls
 * `../../core/markdownSections`'s `headingRange` for the match itself, never
 * a second statement of the heading or fence rule.
 */
function collectionHeadingRange(content: string, headingText: string): SectionRange | null {
	const text = headingText.trim();
	if (!text) return null;
	for (let level = 1; level <= 6; level += 1) {
		const found = headingRange(content, text, level);
		if (found !== null) return found;
	}
	return null;
}

/**
 * Where `headingText` opens a heading nested inside `range` — every level
 * from 1 to 6 tried, the same as {@link collectionHeadingRange}, but the
 * match accepted is the one whose own heading line actually falls inside
 * `range`'s bounds, not the first one found scanning from level 1.
 *
 * A second, unrelated occurrence of the same heading text written shallower
 * and *before* `range` — enclosing it, since `headingRange`'s own "runs to
 * the next heading of the same or a shallower level" rule never stops at a
 * deeper heading below it — must never be preferred over one legitimately
 * nested inside `range`: the first-level-that-matches rule
 * `collectionHeadingRange` uses would return that enclosing one and never
 * look further.
 */
function nestedHeadingRange(content: string, headingText: string, range: SectionRange): SectionRange | null {
	const text = headingText.trim();
	if (!text) return null;
	for (let level = 1; level <= 6; level += 1) {
		const found = headingRange(content, text, level);
		if (found !== null && found.heading > range.heading && found.heading < range.end) return found;
	}
	return null;
}

function splitLines(text: string): string[] {
	return text === "" ? [] : text.split("\n");
}

function joinLines(lines: readonly string[]): string {
	return lines.join("\n");
}

/**
 * `log` with `body` written under `sectionName`'s heading, adding the heading
 * itself — directly above the next day's-task section that already exists,
 * or at the end of the note when none does — if `log` does not carry it yet.
 *
 * Never touches `notesHeading`, `calendarHeading` or `diaryHeading`: this
 * feature adds only the two headings it writes under, exactly as the ticket
 * asks, and the order among all five comes from `daySections()` rather than
 * being decided here a second time.
 *
 * Exported for `rollOver.ts`'s own use:
 * a roll-over lands its fresh copy under the overdue heading the same way a
 * first copy does, and this is the one place that insertion rule is stated.
 */
export function ensureHeadingWithBody(
	log: string,
	sectionName: "todayHeading" | "overdueHeading",
	layout: VaultLayout,
	body: readonly string[],
): string {
	const existing = sectionRange(log, sectionName, layout);
	const lines = splitLines(log);

	if (existing !== null) {
		lines.splice(existing.start, 0, ...body);
		return joinLines(lines);
	}

	const heading = layout[sectionName];
	const headingLine = `${"#".repeat(clampLevel(heading.level))} ${heading.text.trim()}`;
	const insertAt = insertionLineForMissingSection(log, sectionName, layout);
	const needsLeadingBlank = insertAt === lines.length && insertAt > 0 && lines[insertAt - 1] !== "";
	const block = [...(needsLeadingBlank ? [""] : []), headingLine, "", ...body, ""];
	lines.splice(insertAt, 0, ...block);
	return joinLines(lines);
}
