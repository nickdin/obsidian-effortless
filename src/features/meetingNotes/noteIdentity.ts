/**
 * What lets meeting notes recognise a note it did not record — the note a
 * click on a coming day created, or one a run made on the day.
 *
 * Meeting notes' memory of its notes is written only by the device that builds
 * the days, and a device keeps the copy of `data.json` it loaded, so a record
 * written at the click can be gone by the day. The note therefore carries its
 * meeting's identity itself, in a frontmatter property, and the run finds it
 * by that: wherever the note sits, and whatever day the meeting has since
 * moved to.
 *
 * A note made by a click carries it, and so does a note a run creates on the
 * day; a note the person made by hand has none, so
 * it is still adopted unread.
 */

import { frontmatterEnd } from "../../core/markdownSections";
import { fingerprintOf, isFingerprint } from "../../core/fingerprint";

/** The frontmatter property that holds the identity ({@link meetingIdentity}'s string). */
export const IDENTITY_FIELD = "effortless-meeting";

/** The frontmatter line that records `identity`, quoted so any calendar id is one scalar. */
export function identityLine(identity: string): string {
	return `${IDENTITY_FIELD}: ${JSON.stringify(identity)}`;
}

/**
 * The identity a note's frontmatter value names, or `null` when it names none
 * or names something unusable. `data.json` is not the only hand-editable
 * input: a note is too, so a value that is not non-blank text is read as no
 * identity, which leaves the note to be adopted as any note of the person's.
 */
export function readIdentity(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The identity written in the frontmatter of `text`, read from the text itself
 * rather than from Obsidian's index: for a note the index has not reached yet. `null` when the
 * text has no frontmatter block, no such property, or a value that is not
 * non-blank text. The value is read as {@link identityLine} writes it, JSON-quoted;
 * an unquoted value is taken as written, and a quoted one that is not valid JSON
 * is read as no identity, as {@link readIdentity} reads any value it cannot use.
 */
export function identityInText(text: string): string | null {
	const lines = text.split("\n");
	const end = frontmatterEnd(lines);
	if (end < 0) return null;
	const prefix = `${IDENTITY_FIELD}:`;
	for (const line of lines.slice(1, end).map(bare)) {
		if (!line.startsWith(prefix)) continue;
		const value = line.slice(prefix.length).trim();
		if (!value.startsWith('"')) return readIdentity(value);
		try {
			return readIdentity(JSON.parse(value));
		} catch {
			return null;
		}
	}
	return null;
}

/** `line` without the carriage return a Windows-endings note leaves on it. */
function bare(line: string): string {
	return line.replace(/\r$/, "");
}

/**
 * The frontmatter property that holds the names a click offered, beside the
 * identity.
 *
 * It is what a run-written note's memory entry calls `accounted`
 * (`notesMemory.ts`), carried by the note itself because the click's record
 * can be gone by the day (see the module comment). With it, a name the person
 * deleted by hand is known to have been offered and is not offered again.
 * A clicked note made before this property existed has none, which reads as
 * "unknown" and not as "nobody".
 */
export const OFFERED_FIELD = "effortless-offered";

/** The frontmatter line that records `names`, as one JSON array so any name is one scalar. */
export function offeredLine(names: readonly string[]): string {
	return `${OFFERED_FIELD}: ${JSON.stringify(names)}`;
}

/** One `- ` entry of a YAML block list, at any indent including none. */
const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/;

/** A YAML scalar as a text, or `null` when it is empty or a quoted one that does not close. */
function scalar(raw: string): string | null {
	const value = raw.trim();
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? parsed : null;
		} catch {
			return null;
		}
	}
	if (value.startsWith("'")) return value.length > 1 && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : null;
	return value === "" ? null : value;
}

/** The items of a one-line list in YAML's flow style, split on the commas outside quotes. */
function flowItems(inner: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < inner.length; i += 1) {
		const char = inner[i];
		if (quote !== null) {
			current += char;
			if (char === "\\" && quote === '"') current += inner[(i += 1)] ?? "";
			else if (char === quote) quote = null;
		} else if (char === '"' || char === "'") {
			quote = char;
			current += char;
		} else if (char === ",") {
			items.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	if (current.trim() !== "") items.push(current);
	return items;
}

/** Every item read as text, or `null` when one cannot be. */
function allScalars(items: readonly string[]): string[] | null {
	const names = items.map(scalar);
	return names.every((name): name is string => name !== null) ? names : null;
}

/** The names a one-line value holds: JSON as the click writes it, else YAML's flow style as Obsidian may rewrite it. */
function namesOfLine(value: string): string[] | null {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((name) => typeof name === "string") ? parsed : null;
	} catch {
		return value.startsWith("[") && value.endsWith("]") ? allScalars(flowItems(value.slice(1, -1))) : null;
	}
}

/** Where the offered record sits among a note's lines, and the names it holds. */
interface OfferedRecord {
	/** The line the property starts on. */
	readonly start: number;
	/** One past the property's last line: a block list runs over several. */
	readonly stop: number;
	readonly names: string[] | null;
}

/**
 * The offered record in `lines`, within the frontmatter the core finds
 * ({@link frontmatterEnd}). Obsidian rewrites a list property as a block of `- `
 * lines whenever frontmatter is edited through the Properties panel or
 * `processFrontMatter`, so the record is read in that shape as well as the one
 * line the click writes.
 */
function offeredRecord(lines: readonly string[]): OfferedRecord | null {
	const end = frontmatterEnd(lines);
	if (end < 0) return null;
	const prefix = `${OFFERED_FIELD}:`;
	for (let start = 1; start < end; start += 1) {
		const line = bare(lines[start]);
		if (!line.startsWith(prefix)) continue;
		const value = line.slice(prefix.length).trim();
		if (value !== "") return { start, stop: start + 1, names: namesOfLine(value) };
		const items: string[] = [];
		let stop = start + 1;
		for (; stop < end; stop += 1) {
			const item = LIST_ITEM.exec(bare(lines[stop]));
			if (item === null) break;
			items.push(item[1]);
		}
		return { start, stop, names: items.length === 0 ? null : allScalars(items) };
	}
	return null;
}

/**
 * The names the note's frontmatter says a click offered, or `null` when it
 * says none: no frontmatter, no such property, or a value that is not a list
 * of text. A hand-edited value the code cannot use is read as no record
 * rather than guessed at, which leaves the note to be read as one made before
 * the property existed.
 */
export function offeredInText(text: string): string[] | null {
	return offeredRecord(text.split("\n"))?.names ?? null;
}

/**
 * `text` with `added` joined to the names its offered record holds, the record
 * written back as the click writes it. Used by the run that adds those names,
 * in the same write, so a name the run added and the person then removes is
 * known to have been offered, on a device whose notes memory has no entry. A note with no
 * readable record is returned as it is: there is nothing to keep up to date.
 * The line keeps the line ending the note has.
 */
export function withNamesOffered(text: string, added: readonly string[]): string {
	if (added.length === 0) return text;
	const lines = text.split("\n");
	const record = offeredRecord(lines);
	if (record === null || record.names === null) return text;
	const names = [...record.names];
	for (const name of added) if (!names.includes(name)) names.push(name);
	const carriageReturn = lines[record.start].endsWith("\r") ? "\r" : "";
	lines.splice(record.start, record.stop - record.start, offeredLine(names) + carriageReturn);
	return lines.join("\n");
}

/**
 * `text` with the offered-names line written straight after the identity line
 * `identity` made. `text` is a note `noteText` just built, so its lines end in
 * `\n` and the identity line is there; a text without it is returned as it is.
 */
export function withOfferedLine(text: string, identity: string, names: readonly string[]): string {
	const lines = text.split("\n");
	const at = lines.indexOf(identityLine(identity));
	if (at < 0) return text;
	lines.splice(at + 1, 0, offeredLine(names));
	return lines.join("\n");
}

/**
 * The frontmatter property that holds the fingerprint of the body a click
 * wrote, beside the identity.
 *
 * It lets the run tell a note nobody touched from one holding the person's
 * words without comparing against today's template and invitation text, which
 * change after the click. It is in the note rather than in the notes memory
 * because that memory is per device, and a click is made on another device than
 * the run that builds the days (see the module comment).
 */
export const WRITTEN_FIELD = "effortless-written";

/**
 * The text after `text`'s frontmatter, read the way a fingerprint is taken: Windows
 * line endings as `\n` and no trailing whitespace, so a note an editor re-saved
 * with other endings or another final line break holds the same words. `null`
 * when the text has no frontmatter block.
 */
function bodyForWrittenFingerprint(text: string): string | null {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const end = frontmatterEnd(lines);
	if (end < 0) return null;
	return lines.slice(end + 1).join("\n").replace(/\s+$/, "");
}

/**
 * The fingerprint of the body of `text`, or `null` for a text with no
 * frontmatter. What the click records ({@link withWrittenLine}) and what
 * {@link unchangedSinceWritten} compares against.
 */
export function bodyFingerprintWritten(text: string): string | null {
	const body = bodyForWrittenFingerprint(text);
	return body === null ? null : fingerprintOf(body);
}

/** The frontmatter line that records `fingerprint`, quoted so it is one scalar. */
export function writtenLine(fingerprint: string): string {
	return `${WRITTEN_FIELD}: ${JSON.stringify(fingerprint)}`;
}

/**
 * The fingerprint the frontmatter of `text` records, or `null` when it records
 * none: no frontmatter, no such property, or a value that is not a fingerprint
 * (blank, a number, a list, hand-edited text). `data.json` is not the only
 * hand-editable input; a value the code cannot use is read as absent, which
 * leaves the note to the rule for a note made before the property existed — the
 * side that keeps the note. Nothing is replaced, so no notice is needed.
 */
export function writtenInText(text: string): string | null {
	const lines = text.split("\n");
	const end = frontmatterEnd(lines);
	if (end < 0) return null;
	const prefix = `${WRITTEN_FIELD}:`;
	for (const line of lines.slice(1, end).map(bare)) {
		if (!line.startsWith(prefix)) continue;
		const value = line.slice(prefix.length).trim();
		if (!value.startsWith('"')) return null;
		try {
			const parsed: unknown = JSON.parse(value);
			return isFingerprint(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Whether the body of `text` is the body its own fingerprint line recorded, or
 * `null` when it carries no usable fingerprint and cannot be judged this way.
 */
export function unchangedSinceWritten(text: string): boolean | null {
	const recorded = writtenInText(text);
	return recorded === null ? null : bodyFingerprintWritten(text) === recorded;
}

/**
 * `text` with the written line straight after the offered-names line, or after
 * the identity line `identity` made when there is no offered line. `text` is a
 * note `noteText` just built; a text without the identity line is returned as it is.
 */
export function withWrittenLine(text: string, identity: string): string {
	const fingerprint = bodyFingerprintWritten(text);
	const lines = text.split("\n");
	const at = lines.indexOf(identityLine(identity));
	if (fingerprint === null || at < 0) return text;
	const offered = offeredRecord(lines);
	lines.splice(offered === null ? at + 1 : offered.stop, 0, writtenLine(fingerprint));
	return lines.join("\n");
}

/**
 * `text` with the written line as its frontmatter's last line: for a note that
 * names no meeting, so has no identity line to sit beside — the unplanned
 * meeting's. The
 * fingerprint is of the body alone, so where in the frontmatter the line sits
 * changes nothing a reader sees. A text with no frontmatter is returned as it is.
 */
export function withWrittenLineLast(text: string): string {
	const fingerprint = bodyFingerprintWritten(text);
	const lines = text.split("\n");
	const end = frontmatterEnd(lines);
	if (fingerprint === null || end < 0) return text;
	lines.splice(end, 0, writtenLine(fingerprint));
	return lines.join("\n");
}

/**
 * `after`, the text of an edit the run made to `before`, with the written line
 * made to fingerprint the edited body when `before` still held exactly the body
 * its line recorded.
 * The run's own edit — a retitled heading, an added name — is not the person's
 * words, so a note nobody touched stays untouched after it. A note whose body
 * was already something else, or that carries no usable line, is returned as
 * `after`, line as it was: the person's words are never fingerprinted as written.
 * The line keeps the line ending the note has.
 */
export function withWrittenLineRefreshed(before: string, after: string): string {
	if (unchangedSinceWritten(before) !== true) return after;
	const fingerprint = bodyFingerprintWritten(after);
	const lines = after.split("\n");
	const end = frontmatterEnd(lines);
	if (fingerprint === null || end < 0) return after;
	const at = lines.findIndex((line, index) => index > 0 && index < end && bare(line).startsWith(`${WRITTEN_FIELD}:`));
	if (at < 0) return after;
	lines[at] = writtenLine(fingerprint) + (lines[at].endsWith("\r") ? "\r" : "");
	return lines.join("\n");
}
