/**
 * Meeting notes' slice of `data.json`, its shipped defaults, and the rules a
 * stored or typed template field is judged by.
 *
 * Shapes and rules only, so the settings card and the feature agree on one
 * description of the data without either importing the other's behaviour —
 * `src/features/dateEntry/types.ts` is the same file one feature along.
 *
 * **One rule, asked from both sides.** The card asks {@link templateFieldRefusal}
 * before it stores what was typed, and the feature asks it again of what is
 * stored, because `data.json` is hand-editable and a value that got in that
 * way has never passed the card (the rule this repository's `CLAUDE.md`
 * records from #606 and
 * #607).
 */

import { fieldNameRefusal, textFieldRefusal } from "../../core/vaultLayout";
import type { NotesMemory } from "./notesMemory";

/** Stable for ever: it keys this feature's slice of `data.json`. */
export const FEATURE_ID = "meeting-notes";

/**
 * The field names and headings a created note is written with, answered once
 * in the person's own words. The old plugin shipped these in Swedish for one
 * vault; here they default to English.
 */
export interface MeetingNoteTemplate {
	/** The one `tags:` entry a created note carries. */
	readonly tag: string;
	/** The frontmatter field that holds the meeting's effort — the day's table's dropped third column. */
	readonly effortField: string;
	/** The frontmatter field that lists who was invited. */
	readonly participantsField: string;
	/** The note's top heading. */
	readonly notesHeading: string;
	/** The heading the invitation's own text is written under. */
	readonly agendaHeading: string;
	/** The heading left for the person's decisions and actions. */
	readonly decisionsHeading: string;
}

/** The six template fields, in the order the card shows them. */
export const TEMPLATE_FIELDS: ReadonlyArray<keyof MeetingNoteTemplate> = [
	"tag",
	"effortField",
	"participantsField",
	"notesHeading",
	"agendaHeading",
	"decisionsHeading",
];

/** The three fields that are headings, and so must start with `#`. */
const HEADING_FIELDS: ReadonlySet<keyof MeetingNoteTemplate> = new Set([
	"notesHeading",
	"agendaHeading",
	"decisionsHeading",
]);

/** The two fields that are frontmatter property names, judged like the layout's own. */
const PROPERTY_NAME_FIELDS: ReadonlySet<keyof MeetingNoteTemplate> = new Set(["effortField", "participantsField"]);

/** What a stranger installing the plugin gets: English, never the old plugin's Swedish. */
export const DEFAULT_TEMPLATE: MeetingNoteTemplate = {
	tag: "meeting",
	effortField: "effort",
	participantsField: "participants",
	notesHeading: "# Notes",
	agendaHeading: "## Agenda and purpose",
	decisionsHeading: "## Decisions and actions",
};

/** Each template field's row name on the card, which is also how a refusal names it. */
export const TEMPLATE_FIELD_NAMES: Readonly<Record<keyof MeetingNoteTemplate, string>> = {
	tag: "Tag",
	effortField: "Effort field",
	participantsField: "Participants field",
	notesHeading: "Notes heading",
	agendaHeading: "Agenda heading",
	decisionsHeading: "Decisions heading",
};

/**
 * This feature's slice of `data.json`.
 *
 * `notes` has no row on the card: it is the feature's own memory of the notes
 * it has written, read through `readNotesMemory` and never trusted as stored.
 * The interface says what a valid slice looks like, the same way
 * `DaysAheadSettings.rows` does, and guards nothing by itself.
 */
export interface MeetingNotesSettings {
	/** A vault path. Blank means the feature is not configured. */
	readonly meetingNotesFolder: string;
	/** The address left off every participant list. Blank is allowed and never a readiness answer. */
	readonly selfEmail: string;
	readonly template: MeetingNoteTemplate;
	readonly notes: NotesMemory;
}

/** A fresh install: no folder, no address, the English template, no memory yet. */
export const DEFAULT_MEETING_NOTES_SETTINGS: MeetingNotesSettings = {
	meetingNotesFolder: "",
	selfEmail: "",
	template: DEFAULT_TEMPLATE,
	notes: {},
};

/** A stored value as the person would recognise it in `data.json`: quoted when it is text. */
export function storedAsWritten(stored: unknown): string {
	const written = JSON.stringify(stored);
	return written === undefined ? String(stored) : written;
}

/**
 * Why `value` cannot be stored as template field `field`, or `null` where it
 * can: not text, blank, or — for the three headings — not starting with `#`.
 * The two property names also take the layout's property-name rule
 * ({@link fieldNameRefusal}); a heading and the tag may hold a colon, which is
 * ordinary text there.
 *
 * A heading is judged exactly as written, with no leading space taken off,
 * because the note is written with the heading exactly as written.
 */
export function templateFieldRefusal(field: keyof MeetingNoteTemplate, value: unknown): string | null {
	const name = TEMPLATE_FIELD_NAMES[field];
	const unusable = PROPERTY_NAME_FIELDS.has(field) ? fieldNameRefusal(name, value) : textFieldRefusal(name, value);
	if (unusable !== null) return unusable;
	if (typeof value === "string" && HEADING_FIELDS.has(field) && !value.startsWith("#")) {
		return `${name} must start with #, the way a heading is written.`;
	}
	return null;
}

/** One stored template field the feature cannot use, and what it runs on instead. */
export interface RefusedTemplateField {
	readonly field: keyof MeetingNoteTemplate;
	readonly stored: unknown;
}

/**
 * The stored `template` read as the feature can use it: each field the
 * stored one where {@link templateFieldRefusal} accepts it, its English
 * default where it does not, and every refused field named so the feature can
 * say so. Never repaired in the file: the stored value stays until the person
 * changes it.
 *
 * **A field missing from the file is not refused**, only filled from the
 * default in silence. That is how a later release's new field arrives in an
 * older file, and how the store itself fills a missing top-level field
 * (`SettingsStore.handleFor`); a person who never wrote a value has nothing
 * to be told about. A `template` that is not an object at all is refused
 * whole, under the field name `template`.
 */
export function readTemplate(raw: unknown): {
	template: MeetingNoteTemplate;
	refused: RefusedTemplateField[];
	wholeRefused: boolean;
} {
	if (raw === undefined) return { template: DEFAULT_TEMPLATE, refused: [], wholeRefused: false };
	if (!isRecord(raw)) return { template: DEFAULT_TEMPLATE, refused: [], wholeRefused: true };

	const template: Record<string, string> = { ...DEFAULT_TEMPLATE };
	const refused: RefusedTemplateField[] = [];
	for (const field of TEMPLATE_FIELDS) {
		if (!(field in raw) || raw[field] === undefined) continue;
		const stored = raw[field];
		if (templateFieldRefusal(field, stored) === null) template[field] = stored as string;
		else refused.push({ field, stored });
	}
	return { template: template as unknown as MeetingNoteTemplate, refused, wholeRefused: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
