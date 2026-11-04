/**
 * The core's one recognition of a feature's own appended link, and the fourth
 * marker word, `L`, a feature writes to claim one. Every name below
 * is invented.
 */

import { describe, expect, it } from "vitest";
import { appendedLink, isMarkerShapedComment, marksAppendedLink, withoutAppendedLink } from "../core/markerLink";

/** A marker that claims no link of its own — the shape every filing before #919's fix wrote. */
const MIGRATION = "%% migration:k1abcd 0a1b2c3d 0 %%";
/** The same marker, now also claiming the link right before it. */
const MIGRATION_LINKED = "%% migration:k1abcd 0a1b2c3d 0 L %%";
const TASK_CONSISTENCY = "%% task-consistency:xyz789 1a2b3c4d %%";
const HAND_COMMENT = "%% note: ring after 5 %%";

describe("isMarkerShapedComment", () => {
	it("is true for a feature's own two-word marker", () => {
		expect(isMarkerShapedComment(`- [ ] Tea ${TASK_CONSISTENCY}`, TASK_CONSISTENCY)).toBe(true);
	});

	it("is true for a feature's own three-word marker, the third one character", () => {
		expect(isMarkerShapedComment(`- [ ] Tea ${MIGRATION}`, MIGRATION)).toBe(true);
	});

	it("is true for a feature's own four-word marker, the fourth the link flag", () => {
		expect(isMarkerShapedComment(`- [ ] Tea ${MIGRATION_LINKED}`, MIGRATION_LINKED)).toBe(true);
	});

	it("is false for a comment with no colon", () => {
		const comment = "%% just a thought %%";
		expect(isMarkerShapedComment(`- [ ] Tea ${comment}`, comment)).toBe(false);
	});

	it("is false for a hand comment that happens to hold a colon", () => {
		expect(isMarkerShapedComment(`- [ ] Tea ${HAND_COMMENT}`, HAND_COMMENT)).toBe(false);
	});

	it("is false for a hand comment naming a time, not a hash", () => {
		const comment = "%% 12:30 call %%";
		expect(isMarkerShapedComment(`- [ ] Tea ${comment}`, comment)).toBe(false);
	});
});

describe("marksAppendedLink", () => {
	it("is true only for the four-word form, the fourth word the flag", () => {
		expect(marksAppendedLink(`- [ ] Tea ${MIGRATION_LINKED}`, MIGRATION_LINKED)).toBe(true);
	});

	it("is false for the three-word form: a checkbox word alone claims no link", () => {
		expect(marksAppendedLink(`- [ ] Tea ${MIGRATION}`, MIGRATION)).toBe(false);
	});

	it("is false for a two-word marker, an earlier build's own", () => {
		expect(marksAppendedLink(`- [ ] Tea ${TASK_CONSISTENCY}`, TASK_CONSISTENCY)).toBe(false);
	});
});

describe("appendedLink", () => {
	it("is the last link on a line, when the marker that follows claims it", () => {
		const line = `- [ ] Order more tea [[2031-04-05]] ${MIGRATION_LINKED}`;
		expect(appendedLink(line)).toMatchObject({ path: "2031-04-05" });
	});

	it("is null when the line carries no comment at all", () => {
		expect(appendedLink("- [ ] Order more tea [[2031-04-05]]")).toBeNull();
	});

	it("is null when what follows the link is the person's own comment, not a marker", () => {
		const line = `- [ ] Order more tea [[2031-04-05]] ${HAND_COMMENT}`;
		expect(appendedLink(line)).toBeNull();
	});

	// #919, #928: a line filed before this marker word existed has a marker in
	// exactly this position, and it claims no link. Position alone used to be
	// enough to eat a person's own trailing link here; now only the flag is.
	it("is null when a marker follows the link but does not claim one — a filing from before the flag existed", () => {
		const line = `- [ ] Call Bob [[Bob]] ${MIGRATION}`;
		expect(appendedLink(line)).toBeNull();
	});

	it("is null when a different feature's own marker, which never claims a link, follows the link — a collection task re-copied under its existing id", () => {
		const line = `- [ ] email [[Anna]] ${TASK_CONSISTENCY}`;
		expect(appendedLink(line)).toBeNull();
	});

	it("is null when the line's last link is the person's own, earlier than the marker's own appended text", () => {
		// The person's link sits before the words a feature added after it; the
		// marker that follows those words claims no link either way.
		const line = `- [ ] Call about [[Bob]] some more words ${MIGRATION}`;
		expect(appendedLink(line)).toBeNull();
	});

	it("is null when the line carries no link at all", () => {
		expect(appendedLink(`- [ ] Order more tea ${MIGRATION_LINKED}`)).toBeNull();
	});

	it("finds the link right before the first of several trailing markers, when any of them claims it", () => {
		const line = `- [ ] Order more tea [[2031-04-05]] ${TASK_CONSISTENCY} ${MIGRATION_LINKED}`;
		expect(appendedLink(line)).toMatchObject({ path: "2031-04-05" });
	});

	// #930: a field the core adds later (a tag, a date, a priority) lands at the
	// same insertion point every added field uses — after the link, before the
	// trailing comments — so the link no longer sits right before the marker
	// that claims it. The flag is found regardless.
	it("is still the link when a field sits between it and the marker that claims it", () => {
		const line = `- [ ] Order more tea [[2031-04-05]] #urgent ${MIGRATION_LINKED}`;
		expect(appendedLink(line)).toMatchObject({ path: "2031-04-05" });
	});
});

describe("withoutAppendedLink", () => {
	it("takes the link and its one leading space off, leaving the marker", () => {
		const line = `- [ ] Order more tea [[2031-04-05]] ${MIGRATION_LINKED}`;
		expect(withoutAppendedLink(line)).toBe(`- [ ] Order more tea ${MIGRATION_LINKED}`);
	});

	it("leaves a person's own trailing link alone when there is no marker after it", () => {
		const line = "- [ ] Order more tea [[2031-04-05]]";
		expect(withoutAppendedLink(line)).toBe(line);
	});

	it("leaves a person's own trailing link before a hand comment alone", () => {
		const line = `- [ ] Order more tea [[2031-04-05]] ${HAND_COMMENT}`;
		expect(withoutAppendedLink(line)).toBe(line);
	});

	it("leaves a person's own link that sits before the feature's, dropping only the feature's own", () => {
		const line = `- [ ] Call about [[Bob]] and then this [[2031-04-05]] ${MIGRATION_LINKED}`;
		expect(withoutAppendedLink(line)).toBe(`- [ ] Call about [[Bob]] and then this ${MIGRATION_LINKED}`);
	});

	it("leaves a person's own trailing link alone when the marker after it claims no link", () => {
		const line = `- [ ] Call Bob [[Bob]] ${MIGRATION}`;
		expect(withoutAppendedLink(line)).toBe(line);
	});

	it("leaves an embed alone when the marker after it claims no link", () => {
		const line = `- [ ] see ![[pic.png]] ${MIGRATION}`;
		expect(withoutAppendedLink(line)).toBe(line);
	});
});
