/**
 * Leaving the join block out of an invitation's text.
 *
 * A calendar invitation carries a block that exists only for joining the
 * meeting — a video service's link, a dial-in number, a help link. A meeting
 * note copies the invitation's text, and the block is noise there: the
 * calendar keeps the whole invitation, so nothing is lost by leaving it out.
 *
 * **A block is left out only when it is fenced and carries a known service's
 * own wording.** A fenced block without that wording is a person's own boxed
 * text and stays whole, even with a link inside; a new service's block stays
 * in the note until its wording is added to {@link JOIN_MARKERS}.
 */

/** A line made only of one repeated `.` or `_`, at least this long, is a fence. */
const MIN_FENCE_LENGTH = 20;

/**
 * One service's wording. A block carries the service when its text holds, for
 * every group in `requires`, at least one of that group's phrases (compared
 * case-insensitively). A group is how a service asks for two things at once —
 * its name and a join phrase — without either alone being enough.
 *
 * To recognise a new service, add one entry.
 */
interface JoinMarker {
	readonly service: string;
	readonly requires: readonly (readonly string[])[];
}

export const JOIN_MARKERS: readonly JoinMarker[] = [
	// Seen in a real invitation: the Skype/Lync block, Swedish and English.
	{ service: "Skype", requires: [["anslut till skype-mötet", "join skype meeting"]] },
	// Seen in a real invitation: the SAFOS video-meeting block.
	{ service: "SAFOS", requires: [["safos videomöte"]] },
	// INFERRED, not seen: Microsoft Teams' published invitation format puts the
	// product name and a "join the meeting" line inside an underscore fence.
	// Neither phrase alone is enough, since a person may write either one in
	// their own boxed text. Check against a real Teams invitation before
	// trusting this entry.
	{
		service: "Microsoft Teams",
		requires: [["microsoft teams"], ["join the meeting", "join on your computer", "anslut till mötet"]],
	},
];

function fenceCharacter(line: string): "." | "_" | null {
	const trimmed = line.trim();
	if (trimmed.length < MIN_FENCE_LENGTH) return null;
	const first = trimmed[0];
	if (first !== "." && first !== "_") return null;
	return [...trimmed].every((c) => c === first) ? first : null;
}

function carriesMarker(blockLines: readonly string[]): boolean {
	const text = blockLines.join("\n").toLowerCase();
	return JOIN_MARKERS.some((marker) =>
		marker.requires.every((phrases) => phrases.some((phrase) => text.includes(phrase))),
	);
}

/**
 * The invitation text without its join blocks. A join block is a pair of
 * fences of the same character with at least one line between them, one of
 * which carries a known marker; it goes together with both fences. A fence
 * with no partner, or a fenced block without a marker, is left untouched.
 * Where the removal leaves two blank lines side by side, one goes, and blank
 * lines are not left at the start of the text.
 *
 * Expects line endings already as `\n`.
 */
export function withoutJoinBlocks(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const char = fenceCharacter(lines[i]);
		if (char !== null) {
			let close = -1;
			for (let j = i + 1; j < lines.length; j++) {
				if (fenceCharacter(lines[j]) === char) {
					close = j;
					break;
				}
			}
			if (close > i + 1 && carriesMarker(lines.slice(i + 1, close))) {
				i = close;
				// Collapse the blank lines the removal brought together.
				if (out.length === 0 || out[out.length - 1].trim() === "") {
					while (i + 1 < lines.length && lines[i + 1].trim() === "") i++;
				}
				continue;
			}
		}
		out.push(lines[i]);
	}
	return out.join("\n");
}
