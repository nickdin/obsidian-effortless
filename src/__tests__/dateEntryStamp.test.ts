import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures";
import { editTaskField, parseTaskLine, type DateStampKind } from "../core/taskLine";
import { stamp } from "../features/dateEntry/stamp";

/** Every line of the corpus that is a case rather than commentary. */
const corpus: string[] = fixture("task-lines.md")
	.split("\n")
	.filter((line) => line.length > 0 && !line.startsWith(">"));

/** Thursday 2026-09-03, the day every worked example in the ticket accepts against. */
const TOMORROW = new Date(2026, 8, 4);

/** Runs a case whose trigger is the literal text `@imorgon`, found once in `line`. */
function accept(line: string, kind: DateStampKind) {
	const triggerAt = line.indexOf("@imorgon");
	if (triggerAt === -1) throw new Error(`no trigger in ${JSON.stringify(line)}`);
	return stamp(line, triggerAt, triggerAt + "@imorgon".length, kind, TOMORROW);
}

/** No double space and no trailing space, the shape every case below must keep. */
function hasNoStrayWhitespace(line: string): boolean {
	return !/ {2}/u.test(line) && !/[ \t]$/u.test(line);
}

describe("stamp — the five worked examples, scheduled", () => {
	it("appends the stamp when the trigger sits after the task's last word", () => {
		const result = accept("- [ ] Write report @imorgon", "scheduled");
		expect(result.line).toBe("- [ ] Write report ⏳ 2026-09-04");
		// The stamp landed where the trigger was, so the cursor lands just after
		// it, as the old plugin's replaceRange left it (#577's cursor rule; #594).
		expect(result.cursor).toBe(result.line.length);
	});

	it("closes the gap the trigger leaves behind when it sat mid-description", () => {
		const result = accept("- [ ] Write @imorgon report", "scheduled");
		expect(result.line).toBe("- [ ] Write report ⏳ 2026-09-04");
		expect(result.cursor).toBe("- [ ] Write".length);
	});

	it("adds the stamp before a trailing bookkeeping comment, not after it", () => {
		const result = accept("- [ ] Write %% eid:abc %% @imorgon", "scheduled");
		expect(result.line).toBe("- [ ] Write ⏳ 2026-09-04 %% eid:abc %%");
		expect(result.cursor).toBe(result.line.length);
	});

	it("replaces an existing stamp of the same kind in place, in one line, one undo", () => {
		const result = accept("- [ ] Write ⏳ 2026-01-01 @imorgon", "scheduled");
		expect(result.line).toBe("- [ ] Write ⏳ 2026-09-04");
		expect(result.cursor).toBe(result.line.length);
	});

	it("writes the stamp where the trigger was on a line that is not a task line", () => {
		const result = accept("Plan ⏳ 2026-01-01 @imorgon", "scheduled");
		expect(result.line).toBe("Plan ⏳ 2026-01-01 ⏳ 2026-09-04");
		expect(result.cursor).toBe(result.line.length);
	});
});

describe("stamp — the same five, due", () => {
	it("appends the stamp when the trigger sits after the task's last word", () => {
		const result = accept("- [ ] Write report @imorgon", "due");
		expect(result.line).toBe("- [ ] Write report \u{1F4C5} 2026-09-04");
		// Just after the stamp, which landed where the trigger was.
		expect(result.cursor).toBe(result.line.length);
	});

	it("closes the gap the trigger leaves behind when it sat mid-description", () => {
		const result = accept("- [ ] Write @imorgon report", "due");
		expect(result.line).toBe("- [ ] Write report \u{1F4C5} 2026-09-04");
		expect(result.cursor).toBe("- [ ] Write".length);
	});

	it("adds the stamp before a trailing bookkeeping comment, not after it", () => {
		const result = accept("- [ ] Write %% eid:abc %% @imorgon", "due");
		expect(result.line).toBe("- [ ] Write \u{1F4C5} 2026-09-04 %% eid:abc %%");
		expect(result.cursor).toBe(result.line.length);
	});

	it("adds a due date beside a scheduled one already there, and keeps it", () => {
		// Unlike the scheduled set's fourth row, this is a different kind: the
		// existing scheduled stamp has no due date to replace, so this one is
		// added rather than replaced, and lands where an add always lands.
		const result = accept("- [ ] Write ⏳ 2026-01-01 @imorgon", "due");
		expect(result.line).toBe("- [ ] Write ⏳ 2026-01-01 \u{1F4C5} 2026-09-04");
		// The added stamp landed where the trigger was, so the cursor is after it.
		expect(result.cursor).toBe(result.line.length);
	});

	it("writes the stamp where the trigger was on a line that is not a task line", () => {
		const result = accept("Plan ⏳ 2026-01-01 @imorgon", "due");
		expect(result.line).toBe("Plan ⏳ 2026-01-01 \u{1F4C5} 2026-09-04");
		expect(result.cursor).toBe(result.line.length);
	});
});

describe("stamp — a task line carrying the other kind already", () => {
	it("gains a scheduled date beside a due one already there, and keeps it", () => {
		const result = accept("- [ ] Write \u{1F4C5} 2026-01-01 @imorgon", "scheduled");
		expect(result.line).toBe("- [ ] Write \u{1F4C5} 2026-01-01 ⏳ 2026-09-04");
		expect(parseTaskLine(result.line)?.due).toBe("2026-01-01");
	});
});

describe("stamp — list markers other than a bare dash", () => {
	it("stamps a star task line the way it stamps a dash one", () => {
		const result = accept("* [ ] Write report @imorgon", "scheduled");
		expect(result.line).toBe("* [ ] Write report ⏳ 2026-09-04");
	});

	it("stamps a plus task line the way it stamps a dash one", () => {
		const result = accept("+ [ ] Write report @imorgon", "scheduled");
		expect(result.line).toBe("+ [ ] Write report ⏳ 2026-09-04");
	});
});

describe("stamp — a trigger at the very start of a line that is not a task line", () => {
	it("gives the stamp alone, with nothing else on the line to preserve", () => {
		const line = "@imorgon";
		const result = stamp(line, 0, line.length, "scheduled", TOMORROW);
		expect(result.line).toBe("⏳ 2026-09-04");
		expect(result.cursor).toBe(result.line.length);
	});

	it("leaves whatever followed the trigger's query exactly where it was", () => {
		const line = "@imorgon rest of the line";
		const cursorAt = "@imorgon".length;
		const result = stamp(line, 0, cursorAt, "scheduled", TOMORROW);
		expect(result.line).toBe("⏳ 2026-09-04 rest of the line");
		expect(result.cursor).toBe("⏳ 2026-09-04".length);
	});
});

describe("stamp — a trigger without one space on each side", () => {
	it("keeps the task line a task line when the trigger opens its description", () => {
		const result = stamp("- [ ] @buy milk", 6, 7, "scheduled", TOMORROW);
		expect(result.line).toBe("- [ ] buy milk ⏳ 2026-09-04");
		expect(result.cursor).toBe("- [ ] ".length);
	});

	it("puts the cursor after the stamp on a task with no words yet", () => {
		const result = stamp("- [ ] @tom", 6, 10, "scheduled", TOMORROW);
		expect(result.line).toBe("- [ ] ⏳ 2026-09-04");
		expect(result.cursor).toBe(result.line.length);
	});

	it("leaves no trailing space when two spaces separated the trigger", () => {
		const result = accept("- [ ] buy milk  @imorgon", "scheduled");
		expect(result.line).toBe("- [ ] buy milk ⏳ 2026-09-04");
		expect(result.cursor).toBe(result.line.length);
	});

	it("does not join the words around a trigger that touches the next one", () => {
		const result = stamp("- [ ] buy @milk", 10, 11, "scheduled", TOMORROW);
		expect(result.line).toBe("- [ ] buy milk ⏳ 2026-09-04");
		expect(result.cursor).toBe("- [ ] buy ".length);
	});
});

describe("stamp — no stray whitespace", () => {
	it("leaves no double space and no trailing space in any worked example, either kind", () => {
		const lines = [
			"- [ ] Write report @imorgon",
			"- [ ] Write @imorgon report",
			"- [ ] Write %% eid:abc %% @imorgon",
			"- [ ] Write ⏳ 2026-01-01 @imorgon",
			"Plan ⏳ 2026-01-01 @imorgon",
		];
		for (const line of lines) {
			for (const kind of ["scheduled", "due"] as const) {
				expect(hasNoStrayWhitespace(accept(line, kind).line)).toBe(true);
			}
		}
	});
});

describe("stamp — the corpus, once per kind", () => {
	it("has cases to run", () => {
		expect(corpus.length).toBeGreaterThan(30);
	});

	for (const kind of ["scheduled", "due"] as const) {
		it(`writes the ${kind} date editTaskField would write, and changing it back restores the line`, () => {
			for (const raw of corpus) {
				const withTrigger = `${raw} @imorgon`;
				const triggerAt = raw.length + 1;
				const cursorAt = withTrigger.length;

				const was = parseTaskLine(raw)?.[kind] ?? null;
				const result = stamp(withTrigger, triggerAt, cursorAt, kind, TOMORROW);

				expect(result.line).toBe(editTaskField(raw, kind, "2026-09-04"));
				expect(editTaskField(result.line, kind, was)).toBe(raw);
			}
		});
	}
});
