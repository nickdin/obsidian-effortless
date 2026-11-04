/**
 * The pairing marker: the hidden comment that ties a task's two copies
 * together, and the snapshot hash it carries.
 *
 * This is the feature's only state (#709
 * decision 7, ADR 0002): nothing about a pairing is held in the plugin, only
 * in the marker each copy carries in its own line —
 * `%% task-consistency:<eid> <hash> %%`, written and read through
 * `setComment`/`isBookkeepingComment`'s own shape so the core sees only the
 * id prefix and never what is inside.
 *
 * Pure functions, no vault, no app, no clock injected — `newEid` reads
 * `Date.now()` and `Math.random()` directly, the same globals the old
 * plugin's own generator read, carried across unchanged
 * (`docs/research/effortless-code-audit.md`, `eid.ts:43-45`).
 *
 * The feature id is the one `./types` declares for the feature class, so the
 * marker's namespace and the settings slice cannot drift apart.
 */

import type { CheckboxMeaning, TaskLine } from "../../core/taskLine";
import { setComment } from "../../core/taskLine";
import { FEATURE_ID } from "./types";

/** How many random base-36 characters follow the time in a fresh eid. */
const EID_RANDOM_LENGTH = 4;

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A hash is always this many lowercase hex characters; anything else is malformed. */
const HASH_PATTERN = /^[0-9a-f]{8}$/u;

/**
 * A short, stable hash of the five fields that travel between a task's two
 * copies — decision 9's own list, and `reconcile.ts`'s `applyFields` — as
 * `snapshotOf` reads them the moment it last copied a task. `readMarker`
 * decodes the same shape back out of a line's own marker. Neither the
 * description nor the hidden marker's own text is part of this: words never
 * travel, and a marker cannot hash itself.
 */
export interface SyncedSnapshot {
	readonly hash: string;
}

/**
 * A private id with no format promise to anyone but this feature: the old
 * plugin's own scheme, twelve-ish characters, no separator
 * (`docs/research/effortless-code-audit.md`, `eid.ts:43-45`). Generated once,
 * when a task first pairs, and carried unchanged by every later edit.
 */
export function newEid(): string {
	let random = "";
	for (let at = 0; at < EID_RANDOM_LENGTH; at += 1) {
		random += BASE36[Math.floor(Math.random() * BASE36.length)];
	}
	return Date.now().toString(36) + random;
}

/**
 * The checkbox meaning as the hash sees it. `copied` and `forwarded` are this
 * feature's own bookkeeping — written by `copyIn`'s own marking and by the
 * roll-over logic, never a state a person or the other copy moved to — so
 * neither may make a line read as "changed" on its own. Both collapse to
 * `open`, the meaning they annotate; `done` and `cancelled` are untouched.
 */
function travelledMeaning(meaning: CheckboxMeaning): CheckboxMeaning {
	return meaning === "copied" || meaning === "forwarded" ? "open" : meaning;
}

/** `djb2`, the same short-hash shape `icsOccurrences.ts`'s `fingerprintOf` already uses, as fixed-length hex. */
function shortHash(text: string): string {
	let hash = 5381;
	for (let at = 0; at < text.length; at += 1) hash = (hash * 33) ^ text.charCodeAt(at);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The snapshot `line` hashes to right now: checkbox meaning (as
 * {@link travelledMeaning} sees it), scheduled, due, priority, and tags
 * sorted — exactly the five fields `reconcile.ts`'s `applyFields` copies, and
 * nothing else. `line.meaning` is otherwise read as-is, with no second
 * reading of the checkbox character here: whether an upper-case `X` means
 * `done` is the core's `CHECKBOX_MEANINGS` (`src/core/taskLine.ts:43-49`) to
 * say, not this feature's. The description and every comment — this
 * feature's own marker, the collection-name breadcrumb, another feature's
 * bookkeeping — never reach the hash at all: words are never compared and
 * never copied, so a hash sensitive to them would report a
 * change this feature will never act on. Stable across two calls on the same
 * line, and equal for a log line and a collection line that differ only in
 * the marker, the breadcrumb, or their words.
 */
export function snapshotOf(line: TaskLine): SyncedSnapshot {
	const canonical = JSON.stringify([
		travelledMeaning(line.meaning),
		line.scheduled,
		line.due,
		line.priority,
		[...line.tags].sort(),
	]);
	return { hash: shortHash(canonical) };
}

/** What `readMarker` finds: the eid pairing this line to its copy, and the snapshot it last agreed on. */
export interface Marker {
	readonly eid: string;
	readonly hash: string;
}

/**
 * Reads this feature's own marker off `line`, or null if there is none or it
 * does not parse. Two markers sharing this feature's id: the first is the one
 * read, matching `setComment`'s own first-wins rule — never repaired here,
 * only reported as unparseable if it is the first one that is malformed.
 */
export function readMarker(line: TaskLine): Marker | null {
	const prefix = `${FEATURE_ID}:`;
	const own = line.comments.find((comment) => comment.slice(2, -2).trim().startsWith(prefix));
	if (own === undefined) return null;

	const content = own.slice(2, -2).trim().slice(prefix.length);
	const spaceAt = content.indexOf(" ");
	if (spaceAt === -1) return null;

	const eid = content.slice(0, spaceAt);
	const hash = content.slice(spaceAt + 1).trim();
	if (eid.length === 0 || !HASH_PATTERN.test(hash)) return null;

	return { eid, hash };
}

/**
 * Writes this feature's marker onto `raw`, over `setComment` — never by
 * string-building the comment. Adding, replacing and removing are exactly
 * `setComment`'s own rules; there is no case here that is not already one of
 * those.
 */
export function writeMarker(raw: string, eid: string, hash: string): string {
	return setComment(raw, FEATURE_ID, `${eid} ${hash}`);
}
