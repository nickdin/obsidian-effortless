/**
 * The one place a link on a task line is read: the wikilink `[[path#heading|alias]]`
 * and the markdown link `[label](destination "title")` a person's link setting may
 * make Obsidian write. Migration reads the
 * frozen line's collection through it and the rename keeper finds the links to
 * rewrite through it, and the jump command's reading of the frozen line's link
 * imports `linksOnLine` from here too, so none of the
 * three can read one line two ways.
 *
 * Text inside the line's `%% … %%` comments is never a link. A markdown link whose
 * destination is a web address (`https:`, `mailto:` and the like) names no note and
 * is left out, so a link the person typed to a web page never stands for a
 * collection.
 */

import { parseTaskLine } from "./taskLine";

/** One link found on a line. */
export interface LineLink {
	readonly kind: "wikilink" | "markdown";
	/** Where the whole link starts in the line, and one past where it ends. */
	readonly start: number;
	readonly end: number;
	/**
	 * The note path as `getLinkpath` and `getFirstLinkpathDest` take it: a markdown
	 * destination with its `<…>` taken off and its `%20`s read back, and no
	 * `#heading` in either kind. Trimmed.
	 */
	readonly path: string;
	/** The `#heading` (or `#^block`) after the path, as written, or an empty string. */
	readonly subpath: string;
	/** The alias of a wikilink or the text of a markdown link, without its `|` or brackets; empty when there is none. */
	readonly label: string;
	/** A markdown link's destination exactly as written between `(` and `)`, title included; empty for a wikilink. */
	readonly written: string;
}

const WIKILINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/uy;
const WEB_ADDRESS = /^[a-z][a-z0-9+.-]*:/iu;

/** Every note link on `line`, in order, outside the line's comments. */
export function linksOnLine(line: string): LineLink[] {
	const text = maskComments(line);
	const found: LineLink[] = [];
	let at = 0;
	while (at < text.length) {
		if (text[at] !== "[") {
			at += 1;
			continue;
		}
		const link = text.startsWith("[[", at) ? readWikilink(text, at) : readMarkdownLink(text, at);
		if (link === null) {
			at += 1;
			continue;
		}
		if (link.path !== "" && !WEB_ADDRESS.test(link.path)) found.push(link);
		at = link.end;
	}
	return found;
}

/** The last link on `line`, outside its comments: the one a filing appends after the words the person wrote. */
export function lastLinkOnLine(line: string): LineLink | null {
	const links = linksOnLine(line);
	return links.length === 0 ? null : links[links.length - 1];
}

/** `line` with the text of each of its comments replaced by spaces, so no index moves. */
function maskComments(line: string): string {
	const task = parseTaskLine(line);
	if (task === null) return line;
	let text = line;
	for (const comment of task.comments) text = text.replace(comment, " ".repeat(comment.length));
	return text;
}

function readWikilink(text: string, at: number): LineLink | null {
	WIKILINK.lastIndex = at;
	const match = WIKILINK.exec(text);
	if (match === null) return null;
	return {
		kind: "wikilink",
		start: at,
		end: at + match[0].length,
		path: match[1].trim(),
		subpath: match[2] ?? "",
		label: match[3] ?? "",
		written: "",
	};
}

/** `[label](destination "title")`: the label may hold balanced brackets, the destination balanced parentheses or `<…>`. */
function readMarkdownLink(text: string, at: number): LineLink | null {
	const labelEnd = closing(text, at, "[", "]");
	if (labelEnd === null || text[labelEnd + 1] !== "(") return null;
	const inside = destinationEnd(text, labelEnd + 2);
	if (inside === null) return null;
	const written = text.slice(labelEnd + 2, inside.close);
	const { path, subpath } = splitSubpath(inside.destination);
	return {
		kind: "markdown",
		start: at,
		end: inside.close + 1,
		path: path.trim(),
		subpath,
		label: text.slice(at + 1, labelEnd),
		written,
	};
}

/** The index of the bracket closing the one at `from`, counting nested pairs; null when it never closes on this line. */
function closing(text: string, from: number, open: string, close: string): number | null {
	let depth = 0;
	for (let i = from; i < text.length; i += 1) {
		if (text[i] === "\\") {
			i += 1;
		} else if (text[i] === open) {
			depth += 1;
		} else if (text[i] === close) {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return null;
}

/**
 * From `from`, just after `(`: the destination as written (with `<…>` off) and the index of the
 * `)` that ends the link. A `<…>` destination runs to its `>`; a bare one stops at a space or at
 * the parenthesis that is not paired; a title after a space is skipped.
 */
function destinationEnd(text: string, from: number): { destination: string; close: number } | null {
	let i = from;
	while (text[i] === " ") i += 1;
	let destination: string;
	if (text[i] === "<") {
		const end = text.indexOf(">", i);
		if (end === -1) return null;
		destination = text.slice(i + 1, end);
		i = end + 1;
	} else {
		let depth = 0;
		const start = i;
		for (; i < text.length; i += 1) {
			if (text[i] === "\\") {
				i += 1;
			} else if (text[i] === "(") {
				depth += 1;
			} else if (text[i] === ")") {
				if (depth === 0) break;
				depth -= 1;
			} else if (text[i] === " ") {
				break;
			}
		}
		destination = text.slice(start, i);
	}
	while (text[i] === " ") i += 1;
	if (text[i] === '"' || text[i] === "'") {
		const end = text.indexOf(text[i], i + 1);
		if (end === -1) return null;
		i = end + 1;
		while (text[i] === " ") i += 1;
	}
	return text[i] === ")" ? { destination, close: i } : null;
}

function decoded(destination: string): string {
	try {
		return decodeURIComponent(destination);
	} catch {
		return destination;
	}
}

/** A markdown destination's path, read back, and its `#…` as written: the split comes before the reading, so an encoded `%23` stays part of the name. */
function splitSubpath(destination: string): { path: string; subpath: string } {
	const at = destination.indexOf("#");
	const path = at === -1 ? destination : destination.slice(0, at);
	return { path: decoded(path), subpath: at === -1 ? "" : destination.slice(at) };
}
