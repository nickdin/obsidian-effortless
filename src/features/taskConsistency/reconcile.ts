/**
 * The central seam: given one task's two copies and the snapshot the marker
 * last recorded, say which side follows the other, or that neither may move.
 *
 * A pure decision over three strings — `parseTaskLine`'s own boundary, no
 * vault, no app, no clock. Every field it moves goes through `editTaskField`, one call
 * per differing field, never a rebuilt line; the marker it advances
 * goes through `writeMarker`, `setComment`'s own wrapper, the same way. What
 * travels is the five fields `applyFields` chooses — checkbox, scheduled,
 * due, priority, tags — carried by *value*, and the checkbox by *meaning*
 * rather than by its literal character. `editTaskField` knows a sixth, the
 * repeat rule, which `applyFields` leaves alone. Everything else on either
 * line — words, a Tasks-plugin done date, a repeat rule, another feature's own
 * comment, the log's collection-name breadcrumb, either line's indentation —
 * is never compared and never copied; only these five fields decide whether a
 * line moved at all, and `snapshotOf` (`./marker`) is sensitive to exactly
 * them and nothing else.
 *
 * **The checkbox's two exceptions.** `[>]` (forwarded) is written only by
 * this feature's own roll-over and date-change logic, and `[/]`
 * (copied) only by `copyIn`'s own marking — neither is ever a state a person
 * chose or the other copy moved to. So a line whose checkbox reads forwarded
 * or copied never has that meaning copied onto the other side — "changed"
 * for the checkbox means a change of meaning other than to forwarded or
 * copied (decision 8's own words, read together with #822).
 *
 * **A forwarded target is frozen**: once a line reads `[>]`,
 * `applyFields` writes nothing else onto it, whatever the other side changed
 * — it is no longer the live copy (roll-over and a date change from the log
 * both write `[>]` for exactly that reason, and either way a fresh copy now
 * carries the pairing forward). This function's own protection is total: the
 * one edit a frozen line ever receives — the collection's name, kept current
 * on rename — is a core rewrite outside `applyFields` entirely (ADR 0003,
 * `GLOSSARY.md`'s own *Forwarding* entry, issue #803), not a case stated here.
 * A **copied** target has no such freeze: the collection's own `/` is
 * ordinary bookkeeping on a still-live pairing, and a real field edit from
 * the log keeps reaching it exactly as before. A forwarded line is still an
 * ordinary *source*, though — its own other fields still travel out to the
 * collection when it is the side that changed, since freezing protects a
 * line from being rewritten, not from being read.
 *
 * **`lastSynced` null is "never paired"**, not "nothing to do": both lines are
 * read as if only the collection had changed, so the collection is the source
 * the first time a task is seen paired (decision 9's own words). Whether this
 * is ever asked for a task with no prior pairing at all is the run ticket's to
 * decide; this function answers the same way either time.
 *
 * **`logLine` null is "not yet copied"** — nothing this function does, since
 * composing the first copy is decision 10's job, owned elsewhere this wave.
 * `reconcilePair` answers "nothing to do" for it, exactly as it does when
 * both copies already agree.
 *
 * **Every line this function edits has its own marker's hash advanced**: the eid it already carries, read via `readMarker`, or a fresh one
 * from `newEid` the first time a pair is seen with no marker on either line
 * yet, and a hash of the line's own new content via `snapshotOf`. A line
 * returned `null` is not touched at all, marker included — there is nothing
 * for its hash to have moved past.
 */

import type { CheckboxMeaning, TaskLine } from "../../core/taskLine";
import { editTaskField, parseTaskLine } from "../../core/taskLine";
import type { SyncedSnapshot } from "./marker";
import { newEid, readMarker, snapshotOf, writeMarker } from "./marker";

/** What a reconcile decided: the edited line for each side that needs one, or null; and whether the two disagree. */
export interface ReconcileResult {
	/** The collection's line, edited to follow the log — or null if it needs no edit. */
	readonly collection: string | null;
	/** The log's line, edited to follow the collection — or null if it needs no edit. */
	readonly log: string | null;
	/** True when both copies changed since `lastSynced` and now disagree; neither side is edited. */
	readonly clash: boolean;
}

/**
 * The character `editTaskField(raw, "checkbox", …)` writes for a meaning that
 * may travel between copies. `forwarded` and `copied` are deliberately
 * absent: neither is ever the value written onto the other side, so there is
 * nothing here for either to map to.
 */
const CANONICAL_CHECKBOX: Readonly<Record<Exclude<CheckboxMeaning, "forwarded" | "copied">, string>> = {
	open: " ",
	done: "x",
	cancelled: "-",
};

/**
 * Whether `meaning` is this feature's own bookkeeping — `copied`, written
 * only by `copyIn`, or `forwarded`, written only by the roll-over logic —
 * rather than a state a person chose or the other copy moved to. Neither may
 * decide that a line changed, and neither is ever copied onto the other side.
 */
function isBookkeepingMeaning(meaning: CheckboxMeaning): meaning is "copied" | "forwarded" {
	return meaning === "copied" || meaning === "forwarded";
}

/** Parses `raw`, throwing rather than returning null — every caller of this module hands in a task line. */
function requireTaskLine(raw: string): TaskLine {
	const parsed = parseTaskLine(raw);
	if (parsed === null) throw new Error(`not a task line: ${JSON.stringify(raw)}`);
	return parsed;
}

/** Whether two tag sets hold the same tags, order and duplicates aside. */
function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	return sortedA.every((tag, index) => tag === sortedB[index]);
}

/**
 * Whether `collection` and `log` already agree on the five travelling fields —
 * the only fields a clash can be about. The checkbox is excluded from the
 * comparison entirely when either side reads as this feature's own
 * bookkeeping, the same exception `applyFields` makes: a hand-typed `[>]` or
 * a collection's own `[/]` is never a disagreement, because neither was ever
 * a candidate to travel.
 */
function fieldsAgree(collection: TaskLine, log: TaskLine): boolean {
	const checkboxAgrees =
		isBookkeepingMeaning(collection.meaning) ||
		isBookkeepingMeaning(log.meaning) ||
		collection.meaning === log.meaning;
	return (
		checkboxAgrees &&
		collection.scheduled === log.scheduled &&
		collection.due === log.due &&
		collection.priority === log.priority &&
		sameTagSet(collection.tags, log.tags)
	);
}

/**
 * Edits `targetRaw` field by field so `target` matches `source` on each of the
 * five travelling fields that differs, and returns the result — `targetRaw`
 * itself, unchanged, when none of them do. The checkbox is skipped entirely
 * when `source.meaning` is this feature's own bookkeeping — forwarded or
 * copied, decision 8's exception plus #822's own extension of it; every other
 * field travels by value whenever it differs.
 *
 * **A forwarded target is skipped whole**, before any field is looked at: once a line reads `[>]` it is frozen, and freezing is not one more
 * field-level exception the way the checkbox's own two meanings are.
 */
function applyFields(targetRaw: string, target: TaskLine, source: TaskLine): string {
	// A forwarded target is frozen: it is no longer the live copy, so
	// nothing here rewrites it, whatever changed on the other side.
	if (target.meaning === "forwarded") return targetRaw;

	let result = targetRaw;

	// A target already reading as bookkeeping (a collection's own `/`, a
	// log's own hand-typed `[>]`) is compared as `open`, the meaning it
	// annotates: a source that is genuinely still `open` is not a checkbox
	// change and must not overwrite the target's own mark. A source
	// that is `done` or `cancelled` — a real tick — still travels regardless.
	const targetMeaning = isBookkeepingMeaning(target.meaning) ? "open" : target.meaning;
	if (!isBookkeepingMeaning(source.meaning) && source.meaning !== targetMeaning) {
		result = editTaskField(result, "checkbox", CANONICAL_CHECKBOX[source.meaning]);
	}
	if (source.scheduled !== target.scheduled) {
		result = editTaskField(result, "scheduled", source.scheduled);
	}
	if (source.due !== target.due) {
		result = editTaskField(result, "due", source.due);
	}
	if (source.priority !== target.priority) {
		result = editTaskField(result, "priority", source.priority);
	}
	if (!sameTagSet(source.tags, target.tags)) {
		result = editTaskField(result, "tags", source.tags);
	}

	return result;
}

/**
 * `edited`, its own marker's hash advanced to `snapshotOf` its new content —
 * the eid `readMarker(original)` already found, or a fresh one from `newEid`
 * when `original` carries no marker yet (the pair's first reconcile). Called
 * only when `edited` differs from `original.raw`, so a line this function did
 * not otherwise touch never has its marker rewritten either.
 */
function withAdvancedMarker(edited: string, original: TaskLine): string {
	const eid = readMarker(original)?.eid ?? newEid();
	const hash = snapshotOf(requireTaskLine(edited)).hash;
	return writeMarker(edited, eid, hash);
}

/**
 * The central decision: given a task's collection line, its log line (or null
 * if it has never been copied there), and the snapshot the marker last
 * recorded (or null if the two have never been paired), says which side
 * follows the other.
 *
 * See the module comment for the named exceptions — the checkbox's forwarded
 * and copied cases, `lastSynced` null, and marker advancing.
 */
export function reconcilePair(
	collectionLine: string,
	logLine: string | null,
	lastSynced: SyncedSnapshot | null,
): ReconcileResult {
	const collection = requireTaskLine(collectionLine);

	if (logLine === null) {
		return { collection: null, log: null, clash: false };
	}
	const log = requireTaskLine(logLine);

	const collectionHash = snapshotOf(collection).hash;
	const logHash = snapshotOf(log).hash;

	const collectionChanged = lastSynced === null ? true : collectionHash !== lastSynced.hash;
	const logChanged = lastSynced === null ? false : logHash !== lastSynced.hash;

	if (!collectionChanged && !logChanged) {
		return { collection: null, log: null, clash: false };
	}

	if (collectionChanged && !logChanged) {
		const edited = applyFields(logLine, log, collection);
		if (edited === logLine) return { collection: null, log: null, clash: false };
		return { collection: null, log: withAdvancedMarker(edited, log), clash: false };
	}

	if (!collectionChanged && logChanged) {
		const edited = applyFields(collectionLine, collection, log);
		if (edited === collectionLine) return { collection: null, log: null, clash: false };
		return { collection: withAdvancedMarker(edited, collection), log: null, clash: false };
	}

	if (fieldsAgree(collection, log)) {
		return { collection: null, log: null, clash: false };
	}
	return { collection: null, log: null, clash: true };
}
