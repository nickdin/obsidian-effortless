/**
 * Where a heading's section begins and ends inside a note, and what a fenced
 * block and a heading are.
 *
 * This module reads Markdown and nothing else: it is given the note's text and
 * the heading to look for, so it knows nothing about vaults, layouts or
 * settings and can be exercised on a plain string. `vaultLayout.ts` is what
 * turns a day's-log section setting into the heading and level passed here.
 *
 * **The heading rule and CommonMark's fence rules are stated here and nowhere
 * else in the source that ships.** The first feature written needed both facts
 * and copied them, and two copies of a rule drift with nothing failing when they do; that copy is gone.
 * `src/core/calendarTable.ts` held a third copy of the fence rules until
 * #412, and asks a wider
 * question with them — which fenced blocks carry a `schema` info string, and
 * where the outermost of those blocks end — which `fencedLines` does not answer.
 * So the fence rule itself is exported twice over: `openingFence` reports what
 * an opening line said, `closesFence` says whether a later line ends it, and a
 * caller that wants only one boolean per line asks `fencedLines`. What a caller
 * does with an info string is its own business; this module reads the string and
 * decides nothing about it. The heading scanner underneath stays private, so no
 * caller can reassemble the heading rule slightly differently. A guard in
 * `src/__tests__/markdownSections.test.ts` pins the list of shipped files that
 * write the fence pattern — this module alone — so a copy fails it. Its reach is
 * everything under `src/` except `src/__tests__/`, `src/main.ts` included: a
 * test may quote the fence pattern as a fixture, and a pattern quoted in a test
 * cannot drift into the plugin.
 */

/** Which lines of a note a section covers. Indices into `content.split("\n")`. */
export interface SectionRange {
	/** The heading line itself. */
	heading: number;
	/** The first line below the heading, and where an inserted line would go. */
	start: number;
	/** One past the section's last line, so the body is `slice(start, end)`. */
	end: number;
}

/**
 * Where the section under the heading `text` at `level` begins and ends inside
 * `content`, or `null` when the note does not carry that heading.
 *
 * The heading must match `text` as a whole line, ignoring capitals and
 * surrounding blanks, and must be written at `level`: an appended word means a
 * different heading, and so does a different level. A section runs to the next
 * heading of the same or a shallower level, so a deeper heading stays inside
 * it. Headings inside a fenced block are text, not headings — the calendar
 * table lives in a fence, and a fence is where a stray `#` is most likely to
 * appear.
 *
 * A heading whose text is blank matches nothing, since nothing could ever find
 * it again.
 */
export function headingRange(content: string, text: string, level: number): SectionRange | null {
	const wanted = text.trim().toLowerCase();
	if (!wanted) return null;
	const wantedLevel = clampLevel(level);

	const lines = content.split("\n");
	let heading = -1;
	let fence: Fence | null = null;

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].replace(/\r$/, "");

		if (fence !== null) {
			if (closesFence(line, fence)) fence = null;
			continue;
		}
		const opening = openingFence(line);
		if (opening !== null) {
			fence = opening;
			continue;
		}

		const found = atxHeading(line);
		if (found === null) continue;

		if (heading < 0) {
			if (headingIs(found, text, wantedLevel)) heading = i;
			continue;
		}
		if (found.level <= wantedLevel) return { heading, start: heading + 1, end: i };
	}

	if (heading < 0) return null;
	return { heading, start: heading + 1, end: lines.length };
}

/**
 * The index of the line the note's frontmatter closes on, or `-1` when it has
 * none, which makes the first line to read `0`. Line zero must be `---` and a
 * later line `---` again; an opener with no close is ordinary text, which is how
 * Obsidian draws it. A trailing carriage return on a rule line is ignored, so a
 * note with Windows line endings reads the same.
 *
 * The one statement of the rule that is kept in the core: the rename reads it
 * here, and Review's waiting-notes reader imports it rather than writing its own.
 */
export function frontmatterEnd(lines: readonly string[]): number {
	if (lines.length === 0 || lines[0].replace(/\r$/, "") !== "---") return -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].replace(/\r$/, "") === "---") return i;
	}
	return -1;
}

/**
 * Which lines of `lines` sit inside a fenced block, one answer per line and in
 * order, the block's own delimiter lines counted as inside it. Lines above
 * `from` are not matched against the fence rules and answer `false`, which is
 * how a caller skips a note's frontmatter — it sits at the top of the note, so
 * `from` is the first line past it: three backticks written inside a note's
 * header open nothing over the words below it.
 *
 * **One pass over the note, one answer per line, rather than a question asked
 * per line.** Whether a line is inside a block is decided entirely by what is
 * above it, so a per-line question has to read the note from the top every time
 * and a whole selection costs the square of its length. Asking once and
 * reading the answers back is the same question, asked the way it can be
 * answered.
 *
 * A fence that is never closed runs to the end of the note, which is what
 * Obsidian draws.
 *
 * **`to` is an exclusive upper bound**. Lines at or past
 * `to` are not matched against the fence rules and answer `false`, exactly as
 * lines above `from` do. Before the bound, asking about five lines near the top
 * of a 20,000-line note still matched every one of the 20,000 lines against the
 * fence rules; the bound removes that matching for whatever lies outside
 * `[from, to)`, so what it saves scales with how much of the note sits at or
 * past `to` — nearly everything for a `to` near the top of the note, nearly
 * nothing for a `to` near its foot.
 *
 * **The loop still visits every line of the note, and the answer's shape is
 * why.** The array holds one answer per line of `lines` and keeps the note's own
 * numbering, so a caller reads `inside[i]` for the line it already calls `i` —
 * the checkbox feature's classifier does exactly that. A loop stopping at `to`
 * would hand back a shorter array — the numbering would still hold, but every
 * caller would first have to know where the array ends, and one answer per line
 * of the note is the shape they already hold. What the bound removes is the
 * matching, not the visit.
 *
 * Leaving `to` out keeps today's behaviour, so a caller that wants the whole
 * note writes nothing.
 */
export function fencedLines(
	lines: readonly string[],
	from = 0,
	to = lines.length,
): readonly boolean[] {
	const inside: boolean[] = [];
	const last = Math.min(to, lines.length);
	let fence: Fence | null = null;

	for (let i = 0; i < lines.length; i += 1) {
		if (i < from || i >= last) {
			inside.push(false);
			continue;
		}

		// Both fence rules strip one trailing carriage return for themselves, so this
		// strip is no longer needed for the ordinary Windows note. It is kept
		// because it is this scan's own reading of where a line ends: a line
		// carrying two carriage returns is still one line here.
		const line = lines[i].replace(/\r$/, "");
		if (fence !== null) {
			if (closesFence(line, fence)) fence = null;
			inside.push(true);
			continue;
		}

		fence = openingFence(line);
		inside.push(fence !== null);
	}

	return inside;
}

/**
 * Which lines of a note sit inside a fenced block, where the scan starts
 * depending on what kind of note it is: the rule for where a note's fence scan
 * starts, which Migration's place check and Review's open-task count both ask so
 * that the two cannot drift apart.
 *
 * - **A day's log**: the scan starts at line 0. A fence opened in the
 *   frontmatter stays open below it, as Migration has always read a day's log.
 * - **Any other note**: the scan starts below the frontmatter
 *   ({@link frontmatterEnd}), so three backticks written in the header are a
 *   value there and open nothing over the words below.
 *
 * `isDailyLog` is required: the caller says which kind of note this is, and
 * nothing here guesses.
 */
export function fencedLinesOfNote(lines: readonly string[], isDailyLog: boolean): readonly boolean[] {
	return fencedLines(lines, isDailyLog ? 0 : frontmatterEnd(lines) + 1);
}

/**
 * Whether `line` is an ATX heading — `#` through `######`, up to three spaces of
 * indentation, and whitespace or the end of the line after the hashes.
 *
 * The yes-or-no half of `atxHeading`, exported for a caller that needs only
 * that. What a heading *is* stays stated once.
 */
export function isAtxHeading(line: string): boolean {
	return atxHeading(line) !== null;
}

/** A heading's level and its text, as a heading line or Obsidian's own heading index states them. */
export interface HeadingParts {
	readonly level: number;
	readonly text: string;
}

/**
 * The level and text of `line` read as a heading, or `null` when it is not
 * one: the level-and-text half of `atxHeading`, for a caller holding a heading
 * as a setting — `## Logbook` — that has to hand {@link headingRange} its text
 * and level apart.
 */
export function headingParts(line: string): HeadingParts | null {
	return atxHeading(line);
}

/**
 * Whether `found` is the heading `text` at `level`: the same level, and the
 * same text once blanks at either end are gone and capitals ignored. The match
 * {@link headingRange} makes, exported so a caller asking Obsidian's heading
 * index the same question — is this heading in the note? — asks it this way. A blank `text` matches nothing.
 */
export function headingIs(found: HeadingParts, text: string, level: number): boolean {
	const wanted = text.trim().toLowerCase();
	return wanted !== "" && found.level === level && found.text.trim().toLowerCase() === wanted;
}

/**
 * The level and text of an ATX heading line, or `null` when it is not one.
 *
 * **A carriage return in the heading's text is text, wherever in it the
 * carriage return sits.** The text is read with `[^\n]` rather than `.`,
 * because `.` excludes `\r` as well as `\n` and the pattern anchors at the end
 * of the string. That refused two whole classes of line: one still carrying the
 * `\r` a CRLF note leaves behind after a split on `"\n"`, and one holding a
 * `\r` in the middle, which is every line of a note written with carriage
 * returns alone.
 * Both shipped callers strip one trailing `\r` from a line before they ask
 * this rule — `headingRange` below, and the checkbox feature's line classifier
 * at its one call to `isAtxHeading` — so a plain Windows note never hands this
 * rule a line with a trailing `\r` still on it. Only a line whose text ends in
 * a doubled `\r` does, which `headingRange`'s own test drives; otherwise that
 * half of the tolerance guards a direct caller that has not been written yet. Nothing strips a
 * carriage return that sits inside the text, so the middle-of-the-line half is
 * the one a real note reaches.
 *
 * CommonMark reads a bare `\r` as a line ending, so `# Heading\rmore` is really
 * a heading and a line under it. The note arrives already split on `"\n"`
 * alone, so the honest reading of the glued-together line is that the heading is
 * still a heading — recognising it is closer to the spec than refusing it. The
 * `\r` stays in the reported text, and `.trim()` takes off one at either end.
 *
 * `"#\r"` is still not a heading: nothing separates the hashes from the
 * carriage return, and the rule wants whitespace or the end of the line there.
 *
 * Both faces of the rule are fixed here rather than in `isAtxHeading`, so the
 * yes-or-no answer and the level-and-text answer cannot part.
 */
function atxHeading(line: string): { level: number; text: string } | null {
	const match = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*))?$/.exec(line);
	if (match === null) return null;
	return { level: match[1].length, text: (match[2] ?? "").trim() };
}

/**
 * What an opening fence line said. `openingFence` reads one; `closesFence` is
 * asked whether a later line ends it.
 */
export interface Fence {
	/** The character the opening run is made of: a backtick or a tilde. */
	readonly marker: string;
	/** How many of that character the opening run held — at least three. */
	readonly length: number;
	/**
	 * CommonMark's info string: everything after the run, with the blanks at
	 * either end taken off. `` ```schema json `` reads as `schema json`, and a
	 * fence with nothing after its run reads as the empty string.
	 */
	readonly info: string;
}

/**
 * What `line` opens as a fenced block, or `null` when it opens none.
 *
 * The rule is CommonMark's: up to three spaces of indentation, then a run of at
 * least three backticks or at least three tildes. **A backtick fence's info
 * string may hold no backtick**, which is what keeps an inline code span
 * written on a line of its own from opening a block; a tilde fence's info
 * string may hold anything, and that clause is applied here so that no caller
 * repeats it.
 *
 * **One trailing carriage return is stripped before the rule is applied**, so a
 * caller may hand this function a line exactly as it was given. A note split on
 * `"\n"` alone leaves a carriage return on the end of every line of a
 * Windows-written note, and until
 * #503 that carriage return
 * stopped the line opening a fence at all — the info string is read with `.`,
 * which excludes `\r` as well as `\n`, against a pattern anchored at the end of
 * the string. The calendar reader walks a note's lines as it was given them, so
 * a Windows-written note had no schema block in it anywhere and nothing said so.
 *
 * CommonMark reads a bare carriage return as a line ending, which is the
 * reading #407 settled for
 * the heading rule above and `closesFence` already used below. The two rules
 * are handed the same lines, so they answer the same about them: neither asks
 * its caller to strip first. `fencedLines` in this module strips anyway, which
 * is now redundant rather than required, and is kept because a line carrying
 * two carriage returns is still one line to that scan.
 *
 * A carriage return in the *middle* of a line is not touched here and opens
 * nothing — that is #406's
 * class for the fence rule, and it is still open.
 */
export function openingFence(line: string): Fence | null {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ""));
	if (match === null) return null;
	if (match[1][0] === "`" && match[2].indexOf("`") >= 0) return null;
	return { marker: match[1][0], length: match[1].length, info: match[2].trim() };
}

/**
 * Whether `line` closes the block `fence` opened: the same marker, a run at
 * least as long as the opening one, and nothing but blanks after it.
 *
 * **A trailing carriage return is not "something after it".** One is stripped
 * before the rule is applied, so a caller may hand this function a line exactly
 * as it was given — `openingFence` above says the same, and says why the two
 * have to. CommonMark reads a bare carriage return as the end of a line, which
 * is the reading #407
 * settled for the heading rule beside it. This docstring used to name the
 * calendar reader as the one caller that could reach the rule holding an
 * unstripped line, which it could not: `openingFence` refused such a line
 * before it ever got here.
 * It can now, because `openingFence` strips as well.
 *
 * **Only a space or a tab may follow the closing run**, narrower than the
 * calendar reader's pre-#412 `\s*` reading and kept that way deliberately —
 * see ADR [0004](../../docs/adr/0004-commonmark-decides-what-may-follow-a-closing-fence-run.md). The refusals are
 * pinned as a set in this module's tests so the class cannot drift again in
 * either direction.
 */
export function closesFence(line: string, fence: Fence): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line.replace(/\r$/, ""));
	if (match === null) return false;
	return match[1][0] === fence.marker && match[1].length >= fence.length;
}

/** Obsidian stores whatever level it was given; a heading only has six. */
export function clampLevel(level: number): number {
	if (!Number.isFinite(level)) return 1;
	return Math.min(6, Math.max(1, Math.round(level)));
}
