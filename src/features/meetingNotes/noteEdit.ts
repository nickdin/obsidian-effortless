/**
 * The three lines of an existing meeting note this feature may rewrite, and
 * the rule that it rewrites none of them unless it recognises exactly what is
 * there.
 *
 * Carried from `~/Devbox/calendar-scaffold/src/note-edit.ts`'s `editNote`
 * (`:88`) and `readDeltagare` (`:128`, renamed here to
 * {@link readParticipants}), unchanged in logic, with its three literal keys
 * — `daglogg:`, the `# ` heading, `deltagare:` — replaced by
 * the vault layout's `dayLinkField`, the meeting's own title
 * heading, and `participantsField`.
 *
 * A meeting note that already exists is almost entirely the person's. This
 * feature owns three things in it and nothing else:
 *
 *  - the `# ` heading, which is the meeting's name and has to follow a rename;
 *  - the day-link field's value, which is the day the meeting sits on;
 *  - **additions** to the participants list — never a removal, never a
 *    rewrite.
 *
 * The effort field, the tag, the processed field, the agenda heading and
 * everything at or below the agenda heading are his, permanently (story 11).
 * So is any participant already in the file.
 *
 * **Every edit here is conditional on finding what it expects.** The heading
 * is rewritten only when the line reads exactly `# <the old title>`; the
 * day-link field only when it reads exactly `<dayLinkField>: "[[<the old
 * date>]]"`. Anything else is refused by name and the line is left
 * byte-identical — because a line that does not say what this feature last
 * wrote is a line the person has edited, and their version wins. A refusal is
 * reported on screen, never swallowed.
 *
 * Nothing here reaches for Obsidian or for a vault. It is one string in and
 * one string out, so every branch — including every refusal — is a test
 * against a literal.
 */

import { SHIPPED_FIELD_NAMES } from "../../core/vaultLayout";
import type { LayoutFieldNames } from "../../core/vaultLayout";
import type { MeetingNoteTemplate } from "./types";

/** What one run wants changed in one existing note. Every field is optional. */
export interface NoteEditPlan {
	/** Rewrite the `# ` heading, but only if it still reads `# ${from}`. */
	heading?: { from: string; to: string };
	/** Rewrite the day-link field, but only if it still reads `${dayLinkField}: "[[${from}]]"`. */
	dayLink?: { from: string; to: string };
	/** Names to append to the participants list. Already deduplicated by the caller. */
	addNames: string[];
}

export interface NoteEditResult {
	/** The note's text. Identical to the input when nothing was applied. */
	text: string;
	/** One phrase per edit made, for the run's report. */
	applied: string[];
	/**
	 * One sentence per edit **not** made, saying what was expected and what was
	 * found. The caller puts these on screen with the note's path: a refusal
	 * that only this feature knows about is a note quietly drifting out of
	 * step with the calendar.
	 */
	refused: string[];
	/**
	 * The names actually written into the participants list, which is **not**
	 * always the names that were asked for: {@link NoteEditPlan.addNames} is
	 * refused whole when the list cannot be found. The caller records only
	 * these as offered — remembering a name that was never written would mean
	 * it is never tried again, so fixing the note by hand afterwards would not
	 * bring it back.
	 */
	addedNames: string[];
}

const FRONTMATTER_FENCE = "---";
/**
 * One `- ` entry of a YAML block list.
 *
 * **The indent may be nothing at all.** A list under a key is legal YAML at
 * column 0 — a key followed by `- "[[Bo Bergman]]"` with no leading space
 * parses exactly as the two-space form the note is written with. Requiring an
 * indent here read such a list as *empty*, which had two consequences and
 * both were bad: the names already in it were invisible, so one could be
 * added a second time; and a new entry was spliced in **above** them at
 * two-space indent, producing frontmatter that no longer parses at all.
 * Found by `/code-review high` on `calendar-scaffold` Phase 5, 2026-08-22.
 */
const LIST_ITEM = /^([ \t]*)-\s+(.*)$/;
const LINKED_NAME = /^"?\[\[([^\]]*)\]\]"?$/;

/** The default indent for a new participant entry: the note template's two spaces. */
const LIST_INDENT = "  ";

/**
 * The line ending a note's text is written with: `\r\n` when every line
 * break in it is one — a note edited on Windows, or rewritten by sync — and
 * `\n` otherwise. Splitting on the one ending the note uses keeps every line
 * exactly as it reads, so the fences and the fields are found and the lines
 * written back carry the ending the rest of the note has; a note that mixes
 * the two is read as `\n`, which leaves its `\r` on the lines that have one
 * and refuses what it cannot then find, as before.
 */
function lineEnding(text: string): "\n" | "\r\n" {
	return text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r\n" : "\n";
}

/**
 * Applies a plan to a note's text.
 *
 * The three edits are independent: one being refused never stops the others.
 * A rename that lands the heading but cannot find the day link is a better
 * outcome than one that does neither, and the refusal says which.
 */
export function editNote(
	text: string,
	plan: NoteEditPlan,
	template: MeetingNoteTemplate,
	fields: LayoutFieldNames = SHIPPED_FIELD_NAMES,
): NoteEditResult {
	const { participantsField, agendaHeading } = template;
	const { dayLinkField } = fields;
	const ending = lineEnding(text);
	const lines = text.split(ending);
	const applied: string[] = [];
	const refused: string[] = [];
	const addedNames: string[] = [];

	const frontmatter = locateFrontmatter(lines);

	if (plan.heading !== undefined && plan.heading.from !== plan.heading.to) {
		applyHeading(lines, frontmatter, agendaHeading, plan.heading, applied, refused);
	}

	if (frontmatter === null) {
		if (plan.dayLink !== undefined || plan.addNames.length > 0) {
			refused.push(
				`it has no frontmatter block, so its \`${dayLinkField}\` link and its ` +
					`\`${participantsField}\` list could not be found`,
			);
		}
		return { text: lines.join(ending), applied, refused, addedNames };
	}

	if (plan.dayLink !== undefined && plan.dayLink.from !== plan.dayLink.to) {
		applyDayLink(lines, frontmatter, dayLinkField, plan.dayLink, applied, refused);
	}

	if (plan.addNames.length > 0) {
		applyNames(lines, frontmatter, participantsField, plan.addNames, applied, refused, addedNames);
	}

	return { text: lines.join(ending), applied, refused, addedNames };
}

/**
 * The names already listed under the participants field, link syntax
 * removed.
 *
 * Returns null when there is no such block to read, which the caller treats
 * as "add nothing" rather than as "the list is empty" — an unreadable list is
 * not an invitation to write into it.
 */
export function readParticipants(text: string, participantsField: string): string[] | null {
	const lines = text.split(lineEnding(text));
	const frontmatter = locateFrontmatter(lines);
	if (frontmatter === null) return null;

	const block = locateParticipants(lines, frontmatter, participantsField);
	if (block === null) return null;

	return lines
		.slice(block.firstItem, block.firstItem + block.itemCount)
		.map((line) => {
			const item = LIST_ITEM.exec(line);
			const value = item === null ? line.trim() : item[2].trim();
			const linked = LINKED_NAME.exec(value);
			return linked === null ? unquote(value) : linked[1].trim();
		})
		.filter((name) => name.length > 0);
}

// ---------------------------------------------------------------------------
// The three edits
// ---------------------------------------------------------------------------

function applyHeading(
	lines: string[],
	frontmatter: Frontmatter | null,
	agendaHeading: string,
	heading: { from: string; to: string },
	applied: string[],
	refused: string[],
): void {
	// The note's own title heading is the first `# ` line after the
	// frontmatter and before the agenda heading. A later `# ` line — the notes
	// heading, or anything the person has typed into the body — is theirs,
	// permanently (story 11), so the scan is bounded at the agenda heading and
	// never reaches past it. When the agenda heading itself cannot be found,
	// there is nothing to bound the scan against, so the edit refuses rather
	// than falling back to searching the rest of the file the way #770 found
	// it doing.
	const start = frontmatter === null ? 0 : frontmatter.end + 1;
	const agendaAt = lines.findIndex((line, at) => at >= start && line === agendaHeading);
	const end = agendaAt === -1 ? start : agendaAt;
	const index = lines.findIndex((line, at) => at >= start && at < end && line.startsWith("# "));

	if (index === -1) {
		refused.push(`it has no \`# \` heading, so the meeting's name was left as it is`);
		return;
	}
	if (lines[index] !== `# ${heading.from}`) {
		refused.push(
			`its heading reads "${lines[index]}" rather than "# ${heading.from}", so it ` +
				`was left as it is — the calendar now calls this meeting "${heading.to}"`,
		);
		return;
	}

	lines[index] = `# ${heading.to}`;
	applied.push("heading");
}

function applyDayLink(
	lines: string[],
	frontmatter: Frontmatter,
	dayLinkField: string,
	dayLink: { from: string; to: string },
	applied: string[],
	refused: string[],
): void {
	const expected = `${dayLinkField}: "[[${dayLink.from}]]"`;
	const index = lines.findIndex(
		(line, at) => at > frontmatter.start && at < frontmatter.end && line === expected,
	);

	if (index === -1) {
		refused.push(
			`its frontmatter has no line reading \`${expected}\`, so its day link was ` +
				`left as it is — the calendar now puts this meeting on ${dayLink.to}`,
		);
		return;
	}

	lines[index] = `${dayLinkField}: "[[${dayLink.to}]]"`;
	applied.push("day link");
}

function applyNames(
	lines: string[],
	frontmatter: Frontmatter,
	participantsField: string,
	names: string[],
	applied: string[],
	refused: string[],
	addedNames: string[],
): void {
	const block = locateParticipants(lines, frontmatter, participantsField);
	if (block === null) {
		refused.push(
			`its frontmatter has no \`${participantsField}:\` list of its own, so ` +
				`${names.length} newly invited participant(s) were not added: ` +
				names.map((name) => `"${name}"`).join(", "),
		);
		return;
	}

	// After the last existing entry, so every line already there keeps its
	// exact text and its exact position. Appending is the only insertion that
	// cannot disturb a list the person has ordered by hand.
	const at = block.firstItem + block.itemCount;
	lines.splice(at, 0, ...names.map((name) => `${block.indent}- "[[${name}]]"`));
	applied.push(`${names.length} participant(s)`);
	addedNames.push(...names);
}

// ---------------------------------------------------------------------------
// Finding the regions
// ---------------------------------------------------------------------------

interface Frontmatter {
	/** Index of the opening `---`. */
	start: number;
	/** Index of the closing `---`. */
	end: number;
}

/**
 * The frontmatter block, or null when the file does not open with one.
 *
 * Inferred, not checked against a drive: the fence has to be the very first
 * line for Obsidian to read it as frontmatter. A `---` further down is a
 * horizontal rule in the body, and reading it as frontmatter would put this
 * feature's edits into the person's prose.
 */
function locateFrontmatter(lines: string[]): Frontmatter | null {
	if (lines[0] !== FRONTMATTER_FENCE) return null;
	const end = lines.findIndex((line, at) => at > 0 && line === FRONTMATTER_FENCE);
	return end === -1 ? null : { start: 0, end };
}

interface ParticipantsBlock {
	/** Index of the first `- ` entry — one past the key line when there are none. */
	firstItem: number;
	itemCount: number;
	/** The indent the existing entries use, so a new one matches them. */
	indent: string;
}

/**
 * The participants list inside the frontmatter.
 *
 * Returns null when the key is missing, or when it carries a value on its own
 * line — `participants: []`, or a name written inline. Both are shapes this
 * feature did not write and does not know how to extend without rewriting the
 * line, and rewriting it could drop what is on it.
 */
function locateParticipants(
	lines: string[],
	frontmatter: Frontmatter,
	participantsField: string,
): ParticipantsBlock | null {
	const keyPattern = new RegExp(`^${escapeRegExp(participantsField)}:(.*)$`);

	let key = -1;
	for (let index = frontmatter.start + 1; index < frontmatter.end; index++) {
		const match = keyPattern.exec(lines[index]);
		if (match === null) continue;
		if (match[1].trim().length > 0) return null;
		key = index;
		break;
	}
	if (key === -1) return null;

	let itemCount = 0;
	let indent = LIST_INDENT;
	for (let index = key + 1; index < frontmatter.end; index++) {
		const item = LIST_ITEM.exec(lines[index]);
		if (item === null) break;
		if (itemCount === 0) indent = item[1];
		itemCount++;
	}

	return { firstItem: key + 1, itemCount, indent };
}

/** Drops the double quotes YAML wraps a scalar in, when both are there. */
function unquote(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** Escapes `value` so it can be spliced into a `RegExp` as a literal string. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
