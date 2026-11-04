/**
 * The note meeting notes would create for a meeting the person has just
 * clicked in the day view, whatever day it is on.
 *
 * The same text a run writes on the day — `noteText` over the same participants
 * and the same day link — plus the meeting's identity (`noteIdentity.ts`), so
 * that the run on the day knows the note for its own without any record from
 * this device. Pure: what the calendar says and what the settings say arrive
 * as arguments, and nothing here reads the vault or `buildsTheDays`.
 */

import type { Meeting } from "../../core/icsReader";
import type { FilledMeetingNote } from "../../core/meetingNoteFill";
import { localDateKey, meetingNoteBasename, meetingNoteDate } from "../../core/meetingName";
import type { VaultLayout } from "../../core/settings";
import { parseDailyLogDate } from "../../core/vaultLayout";
import { chooseNamedNote, dayLinkOrRefusal, holdsContent } from "./ensureNote";
import { noteText } from "./noteText";
import { withOfferedLine, withWrittenLine } from "./noteIdentity";
import { meetingIdentity } from "./notesMemory";
import { meetingNotePath } from "./notePath";
import { participants } from "./participants";
import type { MeetingNoteTemplate } from "./types";

/** What {@link clickFill} reads, all of it asked at the click. */
export interface ClickFillInputs {
	readonly layout: VaultLayout;
	/** Every meeting on `day` whose calendar is set to make notes. */
	readonly meetingsOn: (day: Date) => readonly Meeting[];
	readonly folder: string;
	readonly template: MeetingNoteTemplate;
	readonly selfEmail: string;
	/**
	 * The paths of the notes anywhere in the vault whose frontmatter names
	 * `identity` (`noteIdentity.ts`). Absent reads as none.
	 */
	readonly notesNamingIdentity?: (identity: string) => readonly string[];
	/**
	 * The text of the note at `path` as far as the caller knows it, or `null`.
	 * Of several notes naming the meeting, only one it can read can be found to
	 * hold the person's words.
	 */
	readonly readNote?: (path: string) => string | null;
}

/**
 * The note for the meeting `linkpath` names on the day `sourcePath` is the
 * log of, or `null` when meeting notes would make none: the source is not a
 * day's log, no meeting of that day has that note name, or the layout cannot
 * name the day's link.
 *
 * Of two meetings that want one name the first gets it, as in a run
 * (`ensureNotes`).
 *
 * **A note that already names the meeting is the answer's path**, wherever it
 * sits and whatever it is called now: the meeting may have moved or been
 * retitled since the person first clicked it, and a second note beside the one
 * holding their preparation is the worse cost.
 * Of several, the run's own choice (`chooseNamedNote`): the one holding the
 * person's words, else the one at the computed path, else the first. The caller
 * finds a file there and opens it rather than creating.
 */
export function clickFill(linkpath: string, sourcePath: string, inputs: ClickFillInputs): FilledMeetingNote | null {
	const day = parseDailyLogDate(sourcePath, inputs.layout);
	if (day === null) return null;
	const dayKey = localDateKey(day);

	const meeting = inputs
		.meetingsOn(day)
		.find((candidate) => meetingNoteBasename(meetingNoteDate(candidate, dayKey), candidate.summary) === linkpath);
	if (meeting === undefined) return null;

	const noteDate = meetingNoteDate(meeting, dayKey);
	const identity = meetingIdentity(meeting.uid, meeting.occurrenceKey);
	const link = dayLinkOrRefusal(noteDate, inputs.layout);
	if ("refused" in link) return null;

	const computed = meetingNotePath(inputs.folder, noteDate, meeting.summary);
	const named = inputs.notesNamingIdentity?.(identity) ?? [];
	// One note naming the meeting is the answer without reading it: the text only
	// tells several apart, so only several ask for it.
	const chosen =
		named.length < 2
			? null
			: chooseNamedNote(named, computed, (candidate) => {
					const text = inputs.readNote?.(candidate) ?? null;
					return text !== null && holdsContent(text, meeting, inputs.template, inputs.layout);
				});
	const offered = participants(meeting, inputs.selfEmail);
	const text = noteText(meeting, link.target, inputs.template, offered, inputs.layout, identity);
	return {
		path: chosen?.chosen ?? named[0] ?? computed,
		// The names offered are written beside the identity, so a name the person
		// removes by hand is not offered again on the day. The fingerprint of
		// the body goes last, so a note nobody has touched is told from one holding
		// the person's words whatever the invitation says by then.
		text: withWrittenLine(withOfferedLine(text, identity, offered), identity),
	};
}
