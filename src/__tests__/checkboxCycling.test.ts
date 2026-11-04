/**
 * The checkbox-cycling feature: what it declares, the commands it puts in the
 * palette, and what one press does to a note.
 *
 * Everything a press *decides* is tested in `checkboxCyclingCycleLines.test.ts`,
 * on text alone. What is left for this file is the half that only the editor
 * knows: which lines the selection covers, where the person's cursor ends up,
 * and that the whole edit arrives as one transaction so one undo puts it back
 * (spec #283, Testing
 * Decisions).
 *
 * **No Obsidian runs here and none is stubbed wholesale.** The feature asks its
 * editor for four things and its host for two, so the tests below hand it four
 * functions and a host whose other members throw the moment they are read. That
 * throwing host is not decoration: "it never calls `Vault`, never uses the note
 * writer, and registers no event handler" is spec decision 1, and a member that
 * throws is how a test says so rather than a comment saying so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	App,
	Command,
	EditorPosition,
	EditorRangeOrCaret,
	EditorSelection,
	EditorTransaction,
} from "obsidian";
import { Notice, Workspace } from "./__mocks__/obsidian";
import type { Calendar } from "../core/calendarSources";
import type { Collections } from "../core/collections";
import type { FeatureHost } from "../core/feature";
import type { NoteWriter } from "../core/noteWriter";
import type { FeatureProblems } from "../core/problems";
import type { CoreSettings } from "../core/settings";
import { CheckboxCycling } from "../features/checkboxCycling/checkboxCycling";
import type {
	CheckboxCyclingSettings,
	CyclingEditor,
} from "../features/checkboxCycling/checkboxCycling";
import { DEFAULT_SEQUENCES } from "../features/checkboxCycling/sequences";
import type { Sequence } from "../features/checkboxCycling/types";

/**
 * Every reading of the note's line kinds, in order, as `{ start, end }`.
 *
 * Deciding what a press may do to a line means reading the note from line zero,
 * because a line inside a code fence cannot be recognised without everything
 * above it. So the number of these readings *is* the cost of a press, and
 * #449 is the ticket that one
 * press over thirty cursors must not pay thirty times. Counting them is the only
 * way to say so: the note on screen is identical either way.
 *
 * The real classifier is wrapped rather than replaced, the way `main.test.ts`
 * watches the settings store — every call still answers exactly what it always
 * did, and the test learns only how many there were.
 */
const classifications = vi.hoisted(() => [] as Array<{ start: number; end: number }>);

vi.mock("../features/checkboxCycling/lineKind", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../features/checkboxCycling/lineKind")>();
	return {
		...actual,
		lineKindRange: (lines: readonly string[], start: number, end: number) => {
			classifications.push({ start, end });
			return actual.lineKindRange(lines, start, end);
		},
	};
});

/** The four command ids the two shipped sequences produce. */
const TASK_FLOW_FORWARD = "checkbox-cycling:shipped-task-flow:forward";
const TASK_FLOW_BACKWARD = "checkbox-cycling:shipped-task-flow:backward";
const ANNOTATIONS_FORWARD = "checkbox-cycling:shipped-annotations:forward";
const ANNOTATIONS_BACKWARD = "checkbox-cycling:shipped-annotations:backward";

/**
 * A host member this feature must never touch, which says so by throwing.
 *
 * Spec decision 1 lists five of them by name. A test that handed in a harmless
 * stub would pass whether the rule held or not; this one fails with the member's
 * own name in the message.
 */
function neverTouched<T extends object>(what: string): T {
	return new Proxy({} as T, {
		get(_target, name) {
			throw new Error(`the feature reached the ${what} (${String(name)})`);
		},
	});
}

/**
 * `app`, with exactly one door open: `workspace`, and nothing else on it.
 *
 * Decision 1 said this feature registers no event handler; issue
 * #774 is the one place
 * that no longer holds — a popout window's `<body>` is reachable no other
 * way, so the extended-symbol gate has to follow `workspace.on("window-open",
 * …)` and `workspace.iterateAllLeaves`. Everything else `app` carries — the
 * vault among it — stays off limits, guarded the same way {@link
 * neverTouched} guards every other member.
 */
function appWithWorkspace(workspace: Workspace): App {
	return new Proxy({} as App, {
		get(_target, name) {
			if (name === "workspace") return workspace;
			throw new Error(`the feature reached the app (${String(name)})`);
		},
	});
}

/** What a test holds onto after building a host: the palette, and the store. */
interface Wired {
	readonly host: FeatureHost;
	/** The commands the feature currently holds, in the order it added them. */
	readonly palette: Command[];
	/** Every id handed to `removeCommand`, in order, including repeats. */
	readonly withdrawn: string[];
	/** The feature's slice of `data.json`, as its last save left it. */
	stored(): Partial<CheckboxCyclingSettings>;
	/** The stub `app.workspace` sits behind — a test opens a popout on it. */
	readonly workspace: Workspace;
}

/**
 * A host with nothing in it but the three members this feature is allowed to
 * reach, and a settings slice that starts wherever `seed` says.
 */
function wire(seed: Partial<CheckboxCyclingSettings> = {}): Wired {
	const palette: Command[] = [];
	const withdrawn: string[] = [];
	let slice = seed;
	const workspace = new Workspace();
	const host: FeatureHost = {
		app: appWithWorkspace(workspace),
		core: neverTouched<CoreSettings>("core settings"),
		notes: neverTouched<NoteWriter>("note writer"),
		calendar: neverTouched<Calendar>("calendar"),
		collections: neverTouched<Collections>("collections index"),
		problems: neverTouched<FeatureProblems>("problem channel"),
		device: neverTouched<FeatureHost["device"]>("device"),
		registerEditorSuggest: () => {
			throw new Error("the feature reached the editor suggester");
		},
		registerMarkdownCodeBlockProcessor: () => {
			throw new Error("the feature reached the code-block renderer");
		},
		addCommand: (command: Command) => {
			palette.push(command);
		},
		removeCommand: (commandId: string) => {
			withdrawn.push(commandId);
			const at = palette.map((each) => each.id).indexOf(commandId);
			if (at >= 0) palette.splice(at, 1);
		},
		settings: <T extends object>(defaults: T) => {
			const save = async (next: T): Promise<void> => {
				slice = next as Partial<CheckboxCyclingSettings>;
			};
			// No store behind this host puts memory back, so nobody is ever told.
			return {
				read: () => ({ ...defaults, ...slice }) as T,
				save,
				saveSoon: save,
				onChange: () => () => undefined,
			};
		},
	};
	return { host, palette, withdrawn, stored: () => slice, workspace };
}

/** A wired host with the feature built on it and loaded, as the core loads it. */
function loadedOn(seed: Partial<CheckboxCyclingSettings> = {}): Wired & {
	feature: CheckboxCycling;
} {
	const wired = wire(seed);
	const feature = new CheckboxCycling(wired.host);
	feature.load();
	return { ...wired, feature };
}

/** How a command is called: Obsidian hands it the editor and looks at nothing. */
type EditorPress = (editor: CyclingEditor) => void;

/** The named command's callback, asserted to be an editor one before it is run. */
function pressOf(palette: Command[], commandId: string): EditorPress {
	const command = palette.filter((each) => each.id === commandId)[0];
	expect(command, `no command with the id "${commandId}"`).toBeDefined();
	expect(command.editorCallback, `"${commandId}" is not an editorCallback`).toBeDefined();
	return command.editorCallback as unknown as EditorPress;
}

/**
 * Just enough editor to press a key in: the four calls the feature makes, and a
 * note that really changes when the transaction lands.
 *
 * Applying the transaction is what lets a test compare the text that comes out
 * rather than the arguments that went in, which is what spec #283 asks a good
 * test here to do.
 */
class FakeEditor implements CyclingEditor {
	readonly transactions: EditorTransaction[] = [];

	constructor(
		private readonly lines: string[],
		private readonly selections: EditorSelection[],
	) {}

	lineCount(): number {
		return this.lines.length;
	}

	getLine(line: number): string {
		return this.lines[line];
	}

	listSelections(): EditorSelection[] {
		return this.selections;
	}

	transaction(tx: EditorTransaction): void {
		this.transactions.push(tx);
		for (const change of tx.changes ?? []) {
			const line = this.lines[change.from.line];
			const to = change.to ?? change.from;
			this.lines[change.from.line] =
				line.slice(0, change.from.ch) + change.text + line.slice(to.ch);
		}
	}

	/** The note as it now stands. */
	text(): string {
		return this.lines.join("\n");
	}

	/** Where the one transaction asked for the selections to be put back. */
	placed(): EditorRangeOrCaret[] {
		return this.transactions[0]?.selections ?? [];
	}
}

/** A cursor sitting on one line, with nothing selected. */
function cursorAt(line: number, ch = 0): EditorSelection {
	return { anchor: { line, ch }, head: { line, ch } };
}

/** A selection running from one position to another. */
function selecting(anchor: EditorPosition, head: EditorPosition): EditorSelection {
	return { anchor, head };
}

/** A sequence written out, for the tests that edit the stored set. */
function sequence(id: string, name: string, symbols: string[]): Sequence {
	return { id, name, symbols };
}

beforeEach(() => {
	Notice.messages = [];
	classifications.length = 0;
});

describe("what the feature declares", () => {
	it("carries the id the settings and the command ids are keyed by", () => {
		const { feature } = loadedOn();

		expect(feature.id).toBe("checkbox-cycling");
	});

	it("carries a name and a one-line description for the settings screen", () => {
		const { feature } = loadedOn();

		expect(feature.name).toBe("Checkbox cycling");
		expect(feature.description.length).toBeGreaterThan(20);
		expect(feature.description.endsWith(".")).toBe(true);
	});
});

describe("the commands it registers", () => {
	it("registers none while it is being built", () => {
		// The core refuses `addCommand` from a constructor and says so, and this
		// is the feature's side of that rule: nothing is registered until the core
		// loads it.
		const wired = wire();

		new CheckboxCycling(wired.host);

		expect(wired.palette).toEqual([]);
	});

	it("registers two per sequence from onload, forward first", () => {
		const { palette } = loadedOn();

		expect(palette.map((each) => each.id)).toEqual([
			TASK_FLOW_FORWARD,
			TASK_FLOW_BACKWARD,
			ANNOTATIONS_FORWARD,
			ANNOTATIONS_BACKWARD,
		]);
	});

	it("names each one after the sequence it steps", () => {
		const { palette } = loadedOn();

		expect(palette.map((each) => each.name)).toEqual([
			"Task flow: cycle forward",
			"Task flow: cycle backward",
			"Annotations: cycle forward",
			"Annotations: cycle backward",
		]);
	});

	it("makes every one an editorCallback, so a phone can reach it", () => {
		// Spec decision 10. A `callback` is not reachable from the mobile toolbar,
		// and a command that has both is a command whose editor half never runs.
		const { palette } = loadedOn();

		for (const command of palette) {
			expect(command.editorCallback, command.id).toBeDefined();
			expect(command.callback, command.id).toBeUndefined();
		}
	});

	it("builds the id from the sequence's id and never from its name", () => {
		const { palette } = loadedOn({
			sequences: [sequence("kept-id", "A name with spaces in it", [" ", "x"])],
		});

		expect(palette.map((each) => each.id)).toEqual([
			"checkbox-cycling:kept-id:forward",
			"checkbox-cycling:kept-id:backward",
		]);
	});
});

describe("one press", () => {
	it("steps the checkbox on the cursor's line when nothing is selected", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- [ ] Write it up", "- [ ] And send it"], [cursorAt(0, 8)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [/] Write it up\n- [ ] And send it");
	});

	it("steps backward, wrapping from the first symbol to the last", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- [ ] Write it up"], [cursorAt(0, 8)]);

		pressOf(palette, TASK_FLOW_BACKWARD)(editor);

		expect(editor.text()).toBe("- [-] Write it up");
	});

	it("leaves every other byte of the line exactly as it was", () => {
		// The rule the whole design exists for. A hidden marker, a wiki reference,
		// a due date, a priority, a tag and a field the plugin has never heard of,
		// all on one line (#15
		// G2, G7).
		const line =
			"  - [ ] Roof quote [[Roof]] 📅 2026-09-30 ⏫ #house recur::weekly %% eid:9f3a %%";
		const { palette } = loadedOn();
		const editor = new FakeEditor([line], [cursorAt(0, 12)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe(line.replace("[ ]", "[/]"));
	});

	it("steps every line a selection touches, in one transaction", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["- [ ] One", "- [/] Two", "- [x] Three"],
			[selecting({ line: 0, ch: 2 }, { line: 2, ch: 7 })],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.transactions).toHaveLength(1);
		expect(editor.text()).toBe("- [/] One\n- [>] Two\n- [-] Three");
	});

	it("keeps every change inside the line it is about", () => {
		// One undo puts the selection back because the edit is one transaction;
		// the note survives because each change replaces one line and nothing
		// between two of them.
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["- [ ] One", "Ordinary words", "* A bullet"],
			[selecting({ line: 0, ch: 0 }, { line: 2, ch: 10 })],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		const changes = editor.transactions[0].changes ?? [];
		expect(changes).toHaveLength(3);
		for (const change of changes) expect(change.to?.line).toBe(change.from.line);
		expect(editor.text()).toBe("- [/] One\n- [ ] Ordinary words\n* [ ] A bullet");
	});

	it("steps a line covered by two cursors once, not twice", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- [ ] One"], [cursorAt(0, 0), cursorAt(0, 8)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [/] One");
	});

	it("touches no line outside the selections it was given", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["- [ ] One", "- [ ] Two", "- [ ] Three"],
			[cursorAt(0, 0), cursorAt(2, 0)],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [/] One\n- [ ] Two\n- [/] Three");
	});

	it("starts a checkbox on an empty line, issue #751", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(["", "Something else"], [cursorAt(0, 0)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [ ] \nSomething else");
	});

	it("starts a checkbox on a whitespace-only line, keeping its indentation", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(["\t\t"], [cursorAt(0, 0)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("\t\t- [ ] ");
	});

	it("takes the sequence's last symbol on a backward press", () => {
		// Task flow's symbols are [" ", "/", ">", "x", "-"]; the natural reading
		// this ticket settles for a blank line is the first symbol going
		// forward and the last symbol going backward, the two places wrapping
		// already lands a step on.
		const { palette } = loadedOn();
		const editor = new FakeEditor([""], [cursorAt(0, 0)]);

		pressOf(palette, TASK_FLOW_BACKWARD)(editor);

		expect(editor.text()).toBe("- [-] ");
	});

	it("reaches nothing on the host but its commands and its settings", () => {
		// Every other member of the host throws when it is read, so a press that
		// returns at all is a press that touched none of them (spec decision 1).
		const { palette } = loadedOn();
		const editor = new FakeEditor(["Ordinary words"], [cursorAt(0, 0)]);

		expect(() => pressOf(palette, TASK_FLOW_FORWARD)(editor)).not.toThrow();
		expect(editor.text()).toBe("- [ ] Ordinary words");
	});
});

describe("where the cursor and the selection end up", () => {
	it("leaves the cursor where it was when a character was merely replaced", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- [ ] Write it up"], [cursorAt(0, 9)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 9 }, to: { line: 0, ch: 9 } }]);
	});

	it("moves it by the prefix a line of prose gained", () => {
		// `- [ ] ` is six characters, so the word the cursor sat in front of is now
		// six characters further along and the cursor goes with it.
		const { palette } = loadedOn();
		const editor = new FakeEditor(["Ordinary words"], [cursorAt(0, 9)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [ ] Ordinary words");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 15 }, to: { line: 0, ch: 15 } }]);
	});

	it("moves the cursor to the end of a checkbox started on an empty line", () => {
		// The old plugin's own rule (`~/Devbox/checkbox-cycler/src/cycle.ts:63`,
		// `main.ts:180`): the cursor goes to the end of the line the press just
		// wrote, so typing continues the task. Bought here for free by
		// `selectionGeometry.ts`'s text diff rather than a rule of its own.
		const { palette } = loadedOn();
		const editor = new FakeEditor([""], [cursorAt(0, 0)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [ ] ");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 6 }, to: { line: 0, ch: 6 } }]);
	});

	it("moves the cursor to the end of a checkbox started on a whitespace-only line, cursor after the indentation", () => {
		// Issue #765: the cursor was left at `ch: 0` (before the tabs) rather than
		// following the empty-line rule above. `"\t\t"` becomes `"\t\t- [ ] "`
		// (length 8), so both starting positions this ticket names belong at the
		// same place, the end of the line.
		const { palette } = loadedOn();
		const editor = new FakeEditor(["\t\t"], [cursorAt(0, 2)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("\t\t- [ ] ");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 8 }, to: { line: 0, ch: 8 } }]);
	});

	it("moves the cursor to the end of a checkbox started on a whitespace-only line, cursor before the indentation", () => {
		// Issue #765's actual finding: a cursor sitting at `ch: 0`, in front of the
		// tabs the line already had, stayed at `ch: 0` instead of following them to
		// the end of the written checkbox.
		const { palette } = loadedOn();
		const editor = new FakeEditor(["\t\t"], [cursorAt(0, 0)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("\t\t- [ ] ");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 8 }, to: { line: 0, ch: 8 } }]);
	});

	it("moves the cursor to the end of a checkbox started on a bullet with no content, cursor after the marker", () => {
		// #765's fix is general, not blank-line-specific: "- " has no content after
		// its marker, so the whole line is the shared prefix the same way a
		// whitespace-only line's is, and a cursor sitting anywhere in it belongs at
		// the end of the checkbox the press wrote, `"- [ ] "` (length 6). `ch: 2`
		// sits exactly at the old diff's rewrite boundary, the same coincidence
		// `ch: 2` on a whitespace-only line had, so this one already landed at
		// `ch: 6` before the fix too — a regression guard, not evidence of the bug.
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- "], [cursorAt(0, 2)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [ ] ");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 6 }, to: { line: 0, ch: 6 } }]);
	});

	it("moves the cursor to the end of a checkbox started on a bullet with no content, cursor before the marker", () => {
		// The same case, cursor at the very start of the line rather than after the
		// marker. This is the one that actually shows the bug: reverting the fix
		// leaves this cursor at `ch: 0`, where it already sat, instead of following
		// it to `ch: 6`.
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- "], [cursorAt(0, 0)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [ ] ");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 6 }, to: { line: 0, ch: 6 } }]);
	});

	it("moves it by the shorter prefix a bullet gained", () => {
		// A bullet keeps its marker, so it gains `[ ] ` — four characters, not six.
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- A bullet"], [cursorAt(0, 2)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [ ] A bullet");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 6 }, to: { line: 0, ch: 6 } }]);
	});

	it("leaves a cursor sitting in the indentation where it was", () => {
		// The brackets are written where the content starts, so nothing in front of
		// that point moved and neither does a cursor there.
		const { palette } = loadedOn();
		const editor = new FakeEditor(["    - A bullet"], [cursorAt(0, 2)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("    - [ ] A bullet");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 2 }, to: { line: 0, ch: 2 } }]);
	});

	it("puts both ends back when they gained different prefixes", () => {
		// The case one number cannot describe, and the reason this half works the
		// two ends out for itself: the anchor's line gains `[ ] ` and the head's
		// gains `- [ ] `
		// (#324's closing note).
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["- A bullet", "Ordinary words"],
			[selecting({ line: 0, ch: 2 }, { line: 1, ch: 9 })],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [ ] A bullet\n- [ ] Ordinary words");
		expect(editor.placed()).toEqual([{ from: { line: 0, ch: 6 }, to: { line: 1, ch: 15 } }]);
	});

	it("keeps a selection made upwards backwards, so the next shift-up grows the same end", () => {
		// The measurement #554 was filed from: the cursor at the end of the last of
		// three task lines, shift-up twice, then a press. Obsidian hands the
		// transaction's `from` to the editor as the anchor and `to` as the head, in
		// the order given, so the anchor has to stay on the last line and the head
		// two lines up.
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["- [ ] first", "- [ ] second", "- [ ] third"],
			[selecting({ line: 2, ch: 11 }, { line: 0, ch: 11 })],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [/] first\n- [/] second\n- [/] third");
		expect(editor.placed()).toEqual([{ from: { line: 2, ch: 11 }, to: { line: 0, ch: 11 } }]);
	});

	it("puts every cursor back when there are several", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["- [ ] One", "Ordinary words"],
			[cursorAt(0, 8), cursorAt(1, 9)],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.placed()).toEqual([
			{ from: { line: 0, ch: 8 }, to: { line: 0, ch: 8 } },
			{ from: { line: 1, ch: 15 }, to: { line: 1, ch: 15 } },
		]);
	});

	it("does not touch the line a selection merely stops at the start of", () => {
		// Shift and down from the start of a line is how one line is selected, and
		// it leaves the far end on the line below at character zero.
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["- [ ] One", "Ordinary words"],
			[selecting({ line: 0, ch: 0 }, { line: 1, ch: 0 })],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("- [/] One\nOrdinary words");
	});
});

describe("a stored record that is not a sequence", () => {
	/**
	 * `data.json` can hold anything, and until
	 * #448 what it held reached
	 * the command palette: a record with no `name` produced a command called
	 * `undefined: cycle forward` under an id holding the same word, which the
	 * person could neither use nor delete — the settings screen for sequences does
	 * not exist yet.
	 *
	 * A record missing any of the three fields a sequence needs — a name, an id, or
	 * a list of symbols — is refused where the stored list is read, and the refusal
	 * says how many were refused rather than which field was missing, because it
	 * can be any combination of them. A record that *is* a sequence but
	 * cannot step keeps its commands and keeps saying why, which is settled the
	 * other way and asserted in "a press that changed no line" below.
	 */

	/** A good sequence, for the tests that store a bad record beside one. */
	const GOOD = sequence("good", "Reading", [" ", "x"]);

	/**
	 * Stored records as `data.json` can really hold them.
	 *
	 * The cast is the point rather than a convenience: the type says these are
	 * sequences and the disk does not, and this is the gap the refusal exists for.
	 */
	function stored(records: unknown[]): Partial<CheckboxCyclingSettings> {
		return { sequences: records } as unknown as Partial<CheckboxCyclingSettings>;
	}

	/** Every command id and command name the palette holds, as one list. */
	function shown(palette: Command[]): string[] {
		return [...palette.map((each) => each.id), ...palette.map((each) => each.name)];
	}

	it("gives no command to a record with no name", () => {
		const { palette } = loadedOn(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));

		expect(palette.map((each) => each.id)).toEqual([
			"checkbox-cycling:good:forward",
			"checkbox-cycling:good:backward",
		]);
	});

	it("gives no command to a record whose name is blank or is not words", () => {
		const { palette } = loadedOn(
			stored([
				{ id: "empty", name: "", symbols: [" ", "x"] },
				{ id: "spaces", name: "   ", symbols: [" ", "x"] },
				{ id: "number", name: 7, symbols: [" ", "x"] },
				GOOD,
			]),
		);

		expect(palette.map((each) => each.id)).toEqual([
			"checkbox-cycling:good:forward",
			"checkbox-cycling:good:backward",
		]);
	});

	it("gives no command to a record with no usable id", () => {
		const { palette } = loadedOn(
			stored([
				{ name: "No id at all", symbols: [" ", "x"] },
				{ id: "", name: "Empty id", symbols: [" ", "x"] },
				{ id: "  ", name: "Blank id", symbols: [" ", "x"] },
				GOOD,
			]),
		);

		expect(palette.map((each) => each.id)).toEqual([
			"checkbox-cycling:good:forward",
			"checkbox-cycling:good:backward",
		]);
	});

	it("puts the word undefined in no command id and no command name", () => {
		// The shape the ticket was filed for, and its neighbours. Whatever else is
		// wrong with a stored record, this word is what the person used to read.
		const { palette } = loadedOn(
			stored([
				{ id: "nameless", symbols: [" ", "x"] },
				{ name: "No id", symbols: [" ", "x"] },
				{ symbols: [" ", "x"] },
				{},
				null,
				"not a record at all",
				GOOD,
			]),
		);

		for (const said of shown(palette)) expect(said).not.toContain("undefined");
		expect(palette).toHaveLength(2);
	});

	it("says how many records it skipped, once and not once each", () => {
		const { feature, palette } = loadedOn(
			stored([{ id: "nameless", symbols: [" ", "x"] }, { name: "No id" }, GOOD]),
		);

		// Every reader of the stored list, read again and again: the palette was
		// built at load, and these three read it afresh.
		feature.readiness();
		feature.sequences();
		pressOf(palette, "checkbox-cycling:good:forward")(new FakeEditor(["- [ ] One"], [cursorAt(0, 8)]));

		expect(Notice.messages).toEqual([
			"Effortless: 2 stored cycling sequences are not ones this version can read, so they were skipped and have no commands. They are left as they are on disk.",
		]);
	});

	it("says it in the singular for one", () => {
		loadedOn(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));

		expect(Notice.messages).toEqual([
			"Effortless: one stored cycling sequence is not one this version can read, so it was skipped and has no commands. It is left as it is on disk.",
		]);
	});

	it("says nothing at all when every stored record is a sequence", () => {
		loadedOn();

		expect(Notice.messages).toEqual([]);
	});

	it("says it again after the feature is switched off and on", () => {
		// A switch back on is a fresh load, and the person is being told what the
		// feature starts with.
		const { feature } = loadedOn(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));

		feature.unload();
		feature.load();

		expect(Notice.messages).toHaveLength(2);
	});

	it("says nothing when the feature is switched off", () => {
		// Switching a feature off on the settings screen unloads it and then
		// redraws the whole screen: every row is asked for its readiness — the
		// switched-off ones too, which is what lets a row read *Not configured*
		// before anyone turns it on — and the open card is drawn again. Since #513
		// the reads are plain reads and cannot announce; the card draw can, and
		// must not here: the count survives the unload, so the fact the load said
		// is not said again on the switch off.
		const { feature } = loadedOn(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));
		Notice.messages = [];

		feature.unload();
		feature.readiness();
		feature.sequences();
		feature.displaySettings(document.createElement("div"), () => {});

		expect(Notice.messages).toEqual([]);
	});

	it("says it once on a fresh load, though the core reads the list before loading it", () => {
		// The core asks a feature whether it stands down before it loads it, and
		// that read walks the stored list (`src/core/registry.ts`). Forgetting the
		// count on load alone made that read say the refusal once and the load say
		// it again: the test Obsidian showed two notices on every reload of the
		// plugin. Since #513 that read is a plain read and only the load speaks;
		// a feature that is not running still announces when its own card is
		// drawn or its list is saved, which the #513 cases below cover.
		const feature = new CheckboxCycling(wire(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD])).host);

		feature.readiness();
		expect(Notice.messages).toEqual([]);

		feature.load();
		feature.readiness();

		expect(Notice.messages).toHaveLength(1);
	});

	it("says nothing when the settings card of a feature never switched on reads its list", () => {
		// An off feature still opens: you configure it before switching it on.
		// These are the card's reads; what the card's own draw says is below.
		const feature = new CheckboxCycling(wire(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD])).host);

		expect(feature.sequences()).toEqual([GOOD]);
		expect(feature.readiness()).toEqual({ state: "ready" });
		expect(Notice.messages).toEqual([]);
	});

	it("says it once on the switch back on, not once for the off and once for the on", () => {
		const { feature } = loadedOn(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));
		Notice.messages = [];

		feature.unload();
		feature.readiness();
		feature.load();
		feature.readiness();

		expect(Notice.messages).toHaveLength(1);
	});

	it("says it again when a refusal that had gone comes back", async () => {
		// `data.json` edited while Obsidian is running: the bad record removed, the
		// list saved, the bad record put back, the list saved again. Zero refusals
		// is remembered as zero, so the record's return is a different number and
		// is said again. The outside edits are written through the host directly,
		// the way an outside edit reaches it, because the feature's own save keeps
		// the refused records; the feature's own save is what says it, because a
		// read says nothing.
		const wired = wire(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));
		const feature = new CheckboxCycling(wired.host);
		feature.load();
		const store = wired.host.settings<Partial<CheckboxCyclingSettings>>({});

		void store.save({ sequences: [GOOD] });
		await feature.saveSequences([GOOD]);
		void store.save(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));
		await feature.saveSequences([GOOD]);

		expect(Notice.messages).toEqual([
			"Effortless: one stored cycling sequence is not one this version can read, so it was skipped and has no commands. It is left as it is on disk.",
			"Effortless: one stored cycling sequence is not one this version can read, so it was skipped and has no commands. It is left as it is on disk.",
		]);
	});

	it("raises no notice from any reader, however many times it is asked", () => {
		// Readiness, the card's list, the palette's commands and a press all read
		// the stored list, and none of their names says anything is said out loud.
		// So nothing is: the one notice here is the load's, and the reads before
		// and after it — the palette is built at load — add none.
		const wired = wire(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));
		const feature = new CheckboxCycling(wired.host);
		for (let times = 0; times < 3; times += 1) {
			feature.readiness();
			feature.sequences();
		}
		expect(Notice.messages).toEqual([]);

		feature.load();
		expect(Notice.messages).toHaveLength(1);

		const press = pressOf(wired.palette, "checkbox-cycling:good:forward");
		for (let times = 0; times < 3; times += 1) {
			feature.readiness();
			feature.sequences();
			press(new FakeEditor(["- [ ] One"], [cursorAt(0, 8)]));
		}
		expect(Notice.messages).toHaveLength(1);
	});

	it("says it once when the card of a switched-off feature is drawn, and not again on a redraw", () => {
		// A switched-off feature never loads, so its card is where it is heard
		// from — the place the list is edited, rather than the settings screen
		// opened about some other feature. The switch on after that says it once
		// more: the load forgets the count and says what the feature starts with.
		const feature = new CheckboxCycling(wire(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD])).host);

		feature.displaySettings(document.createElement("div"), () => {});
		expect(Notice.messages).toEqual([
			"Effortless: one stored cycling sequence is not one this version can read, so it was skipped and has no commands. It is left as it is on disk.",
		]);

		feature.displaySettings(document.createElement("div"), () => {});
		expect(Notice.messages).toHaveLength(1);

		feature.load();
		expect(Notice.messages).toHaveLength(2);
	});

	it("says nothing when the card is drawn and every stored record is a sequence", () => {
		const feature = new CheckboxCycling(wire().host);

		feature.displaySettings(document.createElement("div"), () => {});

		expect(Notice.messages).toEqual([]);
	});

	it("says the new count when a save finds the refused count has changed", async () => {
		// The feature's own save keeps the refused records, so the count changes
		// only when `data.json` changed underneath it; the outside edit is written
		// through the host directly. A save that finds the same count says nothing.
		const wired = wire(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));
		const feature = new CheckboxCycling(wired.host);
		feature.load();
		const store = wired.host.settings<Partial<CheckboxCyclingSettings>>({});

		void store.save(stored([{ id: "nameless", symbols: [" ", "x"] }, { name: "No id" }, GOOD]));
		await feature.saveSequences([GOOD]);
		await feature.saveSequences([GOOD]);

		expect(Notice.messages).toEqual([
			"Effortless: one stored cycling sequence is not one this version can read, so it was skipped and has no commands. It is left as it is on disk.",
			"Effortless: 2 stored cycling sequences are not ones this version can read, so they were skipped and have no commands. They are left as they are on disk.",
		]);
	});

	it("hands the settings card only the records that are sequences", () => {
		const { feature } = loadedOn(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));

		expect(feature.sequences()).toEqual([GOOD]);
	});

	it("counts only records it kept when it answers whether it is ready", () => {
		// The refused record held two different symbols. Readiness must not be
		// bought by a record that has no commands.
		const { feature } = loadedOn(stored([{ id: "", name: "Refused", symbols: [" ", "x"] }]));

		expect(feature.readiness().state).toBe("unconfigured");
	});

	it("is ready when a record it kept holds two different symbols", () => {
		const { feature } = loadedOn(stored([{ id: "nameless", symbols: [" ", "x"] }, GOOD]));

		expect(feature.readiness()).toEqual({ state: "ready" });
	});

	it("keeps both commands of a stored record holding one symbol", () => {
		// Settled the other way, on purpose: a sequence that cannot step is a
		// sequence, and hiding its commands would leave the person who configured it
		// with no sign of it anywhere. What a press on one says is asserted below.
		const { palette } = loadedOn({ sequences: [sequence("one-symbol", "Only one", ["x"])] });

		expect(palette.map((each) => each.id)).toEqual([
			"checkbox-cycling:one-symbol:forward",
			"checkbox-cycling:one-symbol:backward",
		]);
	});

	it("refuses a stored slice that is not a list of sequences at all, loudly", () => {
		// Not a record among records but a slice that is not a set of sequences, so
		// the feature is stopped and reported rather than left running on nonsense.
		// `main.test.ts` is where the core's half of that is asserted.
		expect(() => loadedOn(stored("not a list" as unknown as unknown[]))).toThrow(
			'The stored cycling sequences are "not a list", which is not a list of sequences.',
		);
	});
});

describe("what one press costs", () => {
	/**
	 * One reading of the note per press, whatever the number of cursors.
	 *
	 * These assert the count and not a duration: a stopwatch in a test says
	 * different things on different machines, and the count is the thing the ticket
	 * is about. Thirty cursors in a three-thousand-line log used to be thirty
	 * readings of that log for one keystroke, and sixty when the press turned out
	 * to change nothing.
	 */

	/** A note long enough that reading it thirty times would be worth noticing. */
	function longNote(): string[] {
		const lines: string[] = [];
		for (let at = 0; at < 60; at += 1) lines.push(`- [ ] Task ${at}`);
		return lines;
	}

	it("reads the note once for a press over ten selections, down to the lowest", () => {
		const { palette } = loadedOn();
		const lines = longNote();
		const cursors = [];
		for (let at = 0; at < 10; at += 1) cursors.push(cursorAt(at * 5, 8));
		const editor = new FakeEditor(lines, cursors);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		// One reading, and it stops one line below the lowest cursor rather than at
		// the foot of a sixty-line note.
		expect(classifications).toEqual([{ start: 0, end: 46 }]);
		// And every one of the ten lines really was stepped, so the single reading
		// is not a press that quietly did nothing.
		expect(editor.transactions[0].changes).toHaveLength(10);
	});

	it("reads it once for a press over one cursor", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- [ ] One", "- [ ] Two"], [cursorAt(0, 8)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(classifications).toEqual([{ start: 0, end: 1 }]);
	});

	it("reads no line below a single cursor near the top of a long note", () => {
		// The regression #507
		// exists to undo: one cursor on line 12 used to classify every line of the
		// note on every keystroke, which is the cost
		// #410 had removed.
		const { palette } = loadedOn();
		const editor = new FakeEditor(longNote(), [cursorAt(12, 8)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(classifications).toEqual([{ start: 0, end: 13 }]);
		expect(editor.transactions[0].changes).toHaveLength(1);
	});

	it("reads nothing at all for a press with no selection", () => {
		// A maximum over no ranges is not a number, so the bound is folded from
		// zero: a press with nothing selected classifies nothing rather than
		// handing a nonsense bound down or falling back to the whole note.
		const { palette } = loadedOn();
		const editor = new FakeEditor(longNote(), []);

		expect(() => pressOf(palette, TASK_FLOW_FORWARD)(editor)).not.toThrow();

		expect(classifications).toEqual([{ start: 0, end: 0 }]);
		expect(editor.transactions).toEqual([]);
		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — none of those lines had anywhere to step.",
		]);
	});

	it("still begins at line zero, so a fence above the cursor is seen", () => {
		// The bound moves the end of the walk and never its start: what a line is
		// still depends on everything above it.
		const { palette } = loadedOn();
		const lines = ["```schema", "- [ ] Looks exactly like a task", "```", "- [ ] A real task"];
		const editor = new FakeEditor(lines, [cursorAt(1, 8)]);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(classifications).toEqual([{ start: 0, end: 2 }]);
		expect(editor.transactions).toEqual([]);
		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — a line inside a code fence is left alone.",
		]);
	});

	it("does not read it again when the press changed nothing", () => {
		// The sentence explaining a press that changed nothing used to work the line
		// kinds out for itself, which doubled the cost of the one press that had
		// already found nothing to do.
		// A blockquote rather than a blank line: since #751 a blank line gains a
		// checkbox instead of being left alone, so it can no longer stand for a
		// press that changes nothing.
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["# A heading", "> Quoted", "| Time | What |"],
			[selecting({ line: 0, ch: 0 }, { line: 2, ch: 15 })],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(classifications).toEqual([{ start: 0, end: 3 }]);
		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — a heading is left alone; a quoted line is left alone; a table row is left alone.",
		]);
	});

	it("reads nothing at all when the sequence the command names has gone", async () => {
		// The press returns before it touches the note, so the reading never
		// happens rather than happening and being thrown away.
		const { feature, palette } = loadedOn();
		const press = pressOf(palette, TASK_FLOW_FORWARD);
		const editor = new FakeEditor(["- [ ] One"], [cursorAt(0, 8)]);

		await feature.saveSequences([DEFAULT_SEQUENCES[1]]);
		classifications.length = 0;
		press(editor);

		expect(classifications).toEqual([]);
	});
});

describe("a press that changed no line", () => {
	it("says so once for a whole selection, not once per line", () => {
		// A blockquote rather than a blank line: see the note beside the same
		// substitution above.
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["# A heading", "> Quoted", "| Time | What |"],
			[selecting({ line: 0, ch: 0 }, { line: 2, ch: 15 })],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(Notice.messages).toHaveLength(1);
		expect(editor.transactions).toEqual([]);
		expect(editor.text()).toBe("# A heading\n> Quoted\n| Time | What |");
	});

	it("names every reason it met, once each", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["# A heading", "> Quoted", "| Time | What |", "# Another heading"],
			[selecting({ line: 0, ch: 0 }, { line: 3, ch: 17 })],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — a heading is left alone; a quoted line is left alone; a table row is left alone.",
		]);
	});

	it("says a sequence of one symbol has nowhere to step", () => {
		const { palette } = loadedOn({
			sequences: [sequence("one-symbol", "Only one", ["x"])],
		});
		const editor = new FakeEditor(["- [ ] One"], [cursorAt(0, 0)]);

		pressOf(palette, "checkbox-cycling:one-symbol:forward")(editor);

		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — that sequence holds fewer than two different symbols, so a press has nowhere to step.",
		]);
		expect(editor.text()).toBe("- [ ] One");
	});

	it("says the same of a sequence whose two symbols are the same symbol", () => {
		// A repeat is allowed and stored as typed, so this sequence
		// has its two commands and a person can press one. The press writes `x` over
		// `x`, so nothing changes — and the sentence used to skip this case, find no
		// left-alone line to name, and say "none of those lines had anywhere to
		// step". That blames the line: the line had somewhere to step, the sequence
		// did not.
		const { palette } = loadedOn({
			sequences: [sequence("twice-over", "Twice over", ["x", "x"])],
		});
		const editor = new FakeEditor(["- [x] Write the report"], [cursorAt(0, 8)]);

		pressOf(palette, "checkbox-cycling:twice-over:forward")(editor);

		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — that sequence holds fewer than two different symbols, so a press has nowhere to step.",
		]);
		expect(editor.text()).toBe("- [x] Write the report");
	});

	it("says a press came back to the character the line already had", () => {
		// A sequence that repeats a symbol can hold two symbols that differ and still
		// step a line onto the character already on it. `["a", "b", "a"]` pressed
		// backward from `a` finds the first `a`, steps back, wraps to the last
		// position — and that position holds `a` too. Nothing is written. The
		// sequence sentence is skipped because the symbols do differ, and the line is
		// an ordinary task, so before
		// #504 the person was told
		// "none of those lines had anywhere to step". The line had somewhere; the
		// press came back to where it started.
		const { palette } = loadedOn({
			sequences: [sequence("there-and-back", "There and back", ["a", "b", "a"])],
		});
		const editor = new FakeEditor(["- [a] Write the report"], [cursorAt(0, 8)]);

		pressOf(palette, "checkbox-cycling:there-and-back:backward")(editor);

		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — that press landed back on the character each line already had.",
		]);
		expect(editor.text()).toBe("- [a] Write the report");
	});

	it("says nothing when that same sequence pressed the other way does move", () => {
		// The same line and the same sequence, forward: `a` steps to `b`. The new
		// sentence belongs to the press's direction, not to the sequence, so this
		// press writes and stays silent.
		const { palette } = loadedOn({
			sequences: [sequence("there-and-back", "There and back", ["a", "b", "a"])],
		});
		const editor = new FakeEditor(["- [a] Write the report"], [cursorAt(0, 8)]);

		pressOf(palette, "checkbox-cycling:there-and-back:forward")(editor);

		expect(Notice.messages).toEqual([]);
		expect(editor.text()).toBe("- [b] Write the report");
	});

	it("names the fenced line rather than the press, when it met both", () => {
		// A press over a mix says what the person can act on. They can move the
		// second cursor's line out of nothing — it came back to itself — but they can
		// take the first one out of the code fence, so that is the sentence.
		const { palette } = loadedOn({
			sequences: [sequence("there-and-back", "There and back", ["a", "b", "a"])],
		});
		const editor = new FakeEditor(
			["```markdown", "- [a] A sample", "```", "- [a] Write the report"],
			[cursorAt(1, 8), cursorAt(3, 8)],
		);

		pressOf(palette, "checkbox-cycling:there-and-back:backward")(editor);

		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — a line inside a code fence is left alone.",
		]);
		expect(editor.text()).toBe("```markdown\n- [a] A sample\n```\n- [a] Write the report");
	});

	it("says it once for a whole selection of lines that all came back to themselves", () => {
		// Spec decision 3: one notice per press, however many lines it covered.
		const { palette } = loadedOn({
			sequences: [sequence("there-and-back", "There and back", ["a", "b", "a"])],
		});
		const editor = new FakeEditor(
			["- [a] One", "- [a] Two", "- [a] Three"],
			[selecting({ line: 0, ch: 0 }, { line: 2, ch: 11 })],
		);

		pressOf(palette, "checkbox-cycling:there-and-back:backward")(editor);

		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — that press landed back on the character each line already had.",
		]);
		expect(editor.transactions).toEqual([]);
	});

	it("leaves the folded sequence #425 pins moving on a backward press", () => {
		// `[" ", "x", " ", "/"]` repeats a symbol too, and a backward press from `" "`
		// steps to `/` rather than back to `" "`. It is not an example of the case
		// above and must not pick up its sentence.
		const { palette } = loadedOn({
			sequences: [sequence("folded", "Folded", [" ", "x", " ", "/"])],
		});
		const editor = new FakeEditor(["- [ ] Write the report"], [cursorAt(0, 8)]);

		pressOf(palette, "checkbox-cycling:folded:backward")(editor);

		expect(Notice.messages).toEqual([]);
		expect(editor.text()).toBe("- [/] Write the report");
	});

	it("leaves a task line inside a code fence alone and says why", () => {
		const { palette } = loadedOn();
		const editor = new FakeEditor(
			["```markdown", "- [ ] A sample", "```"],
			[cursorAt(1, 8)],
		);

		pressOf(palette, TASK_FLOW_FORWARD)(editor);

		expect(editor.text()).toBe("```markdown\n- [ ] A sample\n```");
		expect(Notice.messages).toEqual([
			"Effortless: nothing changed — a line inside a code fence is left alone.",
		]);
	});
});

describe("when the press itself fails", () => {
	it("says so and writes nothing, rather than throwing into Obsidian", () => {
		// A fake editor reporting a selection on a line the note does not have.
		// `cycleLines` throws on a range like that, unconditionally since
		// #426. Obsidian
		// cannot report such a selection — the range and the lines are read
		// from one document inside one synchronous handler — so this is a
		// fixture rather than a case the field will produce. What it proves is
		// the containment: whatever reaches the catch, the key says why instead
		// of dying silently. The live case this once used was the carriage
		// return, and #424
		// fixed it.
		const { palette } = loadedOn();
		const editor = new FakeEditor(["- [ ] One"], [cursorAt(9, 0)]);

		expect(() => pressOf(palette, TASK_FLOW_FORWARD)(editor)).not.toThrow();

		expect(editor.text()).toBe("- [ ] One");
		expect(editor.transactions).toEqual([]);
		expect(Notice.messages).toHaveLength(1);
		expect(Notice.messages[0].startsWith("Effortless: the cycling key could not run.")).toBe(true);
	});
});

describe("a press whose sequence has gone", () => {
	it("says so, writes nothing, and calls the thing by the name everything else uses", async () => {
		// A command can outlive the sequence it was built for: a press already on
		// its way, or a palette entry a person opened before the edit landed.
		// `syncCommands` withdraws the command, so this test takes the callback
		// first and presses it afterwards — which is the state the branch was
		// written for and the only way to reach it.
		//
		// The sentence says *sequence*, never *cycle*: a sequence is the named list
		// of symbols, and *cycle* is spent on the two command names. The rule is
		// written out once, beside `nothingChanged` in `checkboxCycling.ts`.
		const { feature, palette } = loadedOn();
		const press = pressOf(palette, TASK_FLOW_FORWARD);
		const editor = new FakeEditor(["- [ ] Write it up"], [cursorAt(0, 8)]);

		await feature.saveSequences([DEFAULT_SEQUENCES[1]]);
		press(editor);

		expect(editor.text()).toBe("- [ ] Write it up");
		expect(editor.transactions).toEqual([]);
		expect(Notice.messages).toEqual([
			"Effortless: that sequence has been deleted, so a press has nothing to step.",
		]);
	});
});

describe("editing the sequences while the feature is loaded", () => {
	it("withdraws the commands of a sequence that has gone", async () => {
		const { feature, palette, withdrawn } = loadedOn();

		await feature.saveSequences([DEFAULT_SEQUENCES[0]]);

		expect(withdrawn).toEqual([ANNOTATIONS_FORWARD, ANNOTATIONS_BACKWARD]);
		expect(palette.map((each) => each.id)).toEqual([TASK_FLOW_FORWARD, TASK_FLOW_BACKWARD]);
	});

	it("registers the commands of a sequence that is new", async () => {
		const { feature, palette } = loadedOn({ sequences: [] });

		await feature.saveSequences([sequence("fresh", "Reading", [" ", "x"])]);

		expect(palette.map((each) => each.id)).toEqual([
			"checkbox-cycling:fresh:forward",
			"checkbox-cycling:fresh:backward",
		]);
	});

	it("keeps a renamed sequence's command ids and gives it the new name", async () => {
		// The whole reason a sequence carries a generated id: Obsidian keys the
		// person's hotkey by command id, so a rename must not move it.
		const { feature, palette } = loadedOn({
			sequences: [sequence("kept-id", "Old name", [" ", "x"])],
		});

		await feature.saveSequences([sequence("kept-id", "New name", [" ", "x"])]);

		expect(palette.map((each) => each.id)).toEqual([
			"checkbox-cycling:kept-id:forward",
			"checkbox-cycling:kept-id:backward",
		]);
		expect(palette.map((each) => each.name)).toEqual([
			"New name: cycle forward",
			"New name: cycle backward",
		]);
	});

	it("leaves the commands alone when only the symbols changed, and presses the new ones", async () => {
		const { feature, palette } = loadedOn({
			sequences: [sequence("kept-id", "Reading", [" ", "x"])],
		});
		const before = palette.map((each) => each.id);

		await feature.saveSequences([sequence("kept-id", "Reading", [" ", "?"])]);
		const editor = new FakeEditor(["- [ ] One"], [cursorAt(0, 8)]);
		pressOf(palette, "checkbox-cycling:kept-id:forward")(editor);

		expect(palette.map((each) => each.id)).toEqual(before);
		expect(editor.text()).toBe("- [?] One");
	});

	it("stores what it was given, through its own handle and not through saveData", async () => {
		const { feature, stored } = loadedOn();
		const next = [sequence("fresh", "Reading", [" ", "x"])];

		await feature.saveSequences(next);

		// `symbolLook` rides along at its default: this write is a sequence
		// edit, and `sliceHolding` carries the stored switch through unchanged
		// rather than dropping it.
		expect(stored()).toEqual({ sequences: next, symbolLook: true });
		expect(feature.sequences()).toEqual(next);
	});

	it("registers nothing while the feature is switched off", async () => {
		// The core lets a feature that is constructed and not running reach
		// `addCommand`, because the settings screen opens such a feature's own
		// settings on purpose. An edit made there must not fill the palette.
		const wired = wire();
		const feature = new CheckboxCycling(wired.host);

		await feature.saveSequences([sequence("fresh", "Reading", [" ", "x"])]);

		expect(wired.palette).toEqual([]);
	});

	it("registers the whole set again after a switch off and on", () => {
		// The feature keeps its own record of what it holds, and empties it on the
		// way down. Without that, the second load would find every command already
		// registered and put none of them back.
		//
		// This host is not the core, so nothing here takes the first four out of
		// the list again — the core does that, and `main.test.ts` is where that
		// half is asserted. What this test says is that the second load registers
		// the whole set rather than nothing.
		const { feature, palette } = loadedOn();

		feature.unload();
		feature.load();

		expect(palette.map((each) => each.id).slice(4)).toEqual([
			TASK_FLOW_FORWARD,
			TASK_FLOW_BACKWARD,
			ANNOTATIONS_FORWARD,
			ANNOTATIONS_BACKWARD,
		]);
	});
});

describe("readiness", () => {
	it("is ready with the shipped sequences", () => {
		const { feature } = loadedOn();

		expect(feature.readiness()).toEqual({ state: "ready" });
	});

	it("is not configured when every sequence has been emptied", () => {
		const { feature } = loadedOn({
			sequences: [sequence("a", "One", []), sequence("b", "Two", [])],
		});

		expect(feature.readiness().state).toBe("unconfigured");
	});

	it("is not configured when no sequence is left at all", () => {
		const { feature } = loadedOn({ sequences: [] });

		expect(feature.readiness().state).toBe("unconfigured");
	});

	it("says what to do about it, since that is the person's work waiting", () => {
		const { feature } = loadedOn({ sequences: [] });
		const readiness = feature.readiness();

		expect(readiness.state === "unconfigured" && readiness.reason.length > 20).toBe(true);
	});

	it("is never unavailable and never standby, whatever is stored", () => {
		// Spec decision 7. Cycling a checkbox needs no device and is nobody else's
		// job, so neither answer can ever be right.
		const stored: Array<Partial<CheckboxCyclingSettings>> = [
			{},
			{ sequences: [] },
			{ sequences: [sequence("a", "One", [])] },
			{ sequences: [sequence("a", "One", ["x"])] },
			{ sequences: [sequence("a", "One", [" ", "x"])] },
		];

		for (const seed of stored) {
			const { feature } = loadedOn(seed);
			expect(["ready", "unconfigured"], JSON.stringify(seed)).toContain(
				feature.readiness().state,
			);
		}
	});
});

/**
 * The extended-symbol switch's one effect outside `data.json`: the class
 * `styles.css`'s seventeen-symbol rules are gated behind, on `<body>`.
 *
 * `document.body` is real here — this suite runs under `jsdom` — so these
 * tests drive the actual class the running plugin would toggle, through the
 * real feature, rather than asserting on a value read back from a fake
 * settings slice.
 */
describe("the extended-symbol look's class on <body>", () => {
	const GATE = "effortless-symbol-look";

	beforeEach(() => {
		document.body.classList.remove(GATE);
	});

	it("carries the class after load with the switch on, and not with it off", () => {
		// What this would report if the code were wrong: both loads leave the
		// class the same — either always present or always absent — rather
		// than following what each one stored.
		const on = loadedOn({ symbolLook: true });
		expect(document.body.classList.contains(GATE)).toBe(true);
		on.feature.unload();
		document.body.classList.remove(GATE);

		const off = loadedOn({ symbolLook: false });
		expect(document.body.classList.contains(GATE)).toBe(false);
		off.feature.unload();
	});

	it("saveSymbolLook(false) takes the class off; saveSymbolLook(true) puts it back", async () => {
		const { feature } = loadedOn({ symbolLook: true });
		expect(document.body.classList.contains(GATE)).toBe(true);

		await feature.saveSymbolLook(false);
		expect(document.body.classList.contains(GATE)).toBe(false);

		await feature.saveSymbolLook(true);
		expect(document.body.classList.contains(GATE)).toBe(true);

		feature.unload();
	});

	it("switching the feature off removes the class", () => {
		// What this would report if the code were wrong: the look would keep
		// showing in a note after the feature that owns it was switched off,
		// which is the effect every other feature's own switch-off already
		// clears (`onunload` elsewhere in this file).
		const { feature } = loadedOn({ symbolLook: true });
		expect(document.body.classList.contains(GATE)).toBe(true);

		feature.unload();

		expect(document.body.classList.contains(GATE)).toBe(false);
	});

	it("a rejected write leaves the class matching what the store still holds, not what the write tried", async () => {
		// What this would report if the code were wrong: the class would
		// follow the value the rejected write attempted, rather than the
		// value the store's own memory rolls back to once the write is
		// refused (`~/Devbox/CLAUDE.md`: "the store is the one truth for what
		// a screen shows"). Faked here the way the store's own rollback
		// behaves — a rejected `save` never moves memory away from what was
		// already there, so `read()` keeps answering the pre-write value.
		let slice: Partial<CheckboxCyclingSettings> = { symbolLook: true };
		const rejecting: FeatureHost["settings"] = <T extends object>(defaults: T) => ({
			read: () => ({ ...defaults, ...slice }) as T,
			save: async () => {
				throw new Error("the vault is read-only");
			},
			saveSoon: async () => {
				throw new Error("the vault is read-only");
			},
			onChange: () => () => undefined,
		});
		const host: FeatureHost = { ...wire().host, settings: rejecting };
		const feature = new CheckboxCycling(host);
		feature.load();
		expect(document.body.classList.contains(GATE)).toBe(true);

		await expect(feature.saveSymbolLook(false)).rejects.toThrow("the vault is read-only");

		expect(slice.symbolLook).toBe(true);
		expect(document.body.classList.contains(GATE)).toBe(true);

		feature.unload();
	});
});

/**
 * The gate's reach past the main window: every open window's `<body>`
 * follows the switch, including one opened after load, and the class comes
 * off all of them at unload.
 *
 * `document.body` alone used to be the whole of this feature's reach. A note
 * moved to a popout window (`Move to new window`) has its own document and
 * its own `<body>`, which Obsidian never mirrors a class onto from the main
 * one. The mock's `Workspace.openWindow` stands in for that: it pushes a
 * leaf whose container is a second document and fires `window-open` the way
 * the real workspace does (`node_modules/obsidian/obsidian.d.ts:8090`).
 */
describe("the extended-symbol look reaching every open window", () => {
	const GATE = "effortless-symbol-look";

	beforeEach(() => {
		document.body.classList.remove(GATE);
	});

	/** A throwaway document standing in for a popout window's own. */
	function popoutDocument(): Document {
		return document.implementation.createHTMLDocument("popout");
	}

	it("applies the class to a window the workspace already holds a leaf in when the feature loads", () => {
		// What this would report if the code were wrong: the popout's own body
		// never gets the class, because the gate only ever touched the main
		// window's `document.body`.
		const wired = wire({ symbolLook: true });
		const popout = popoutDocument();
		wired.workspace.openWindow(popout);

		const feature = new CheckboxCycling(wired.host);
		feature.load();

		expect(document.body.classList.contains(GATE)).toBe(true);
		expect(popout.body.classList.contains(GATE)).toBe(true);

		feature.unload();
	});

	it("applies the class to a window opened after load, via workspace.on('window-open')", () => {
		const wired = wire({ symbolLook: true });
		const feature = new CheckboxCycling(wired.host);
		feature.load();
		const popout = popoutDocument();

		wired.workspace.openWindow(popout);

		expect(popout.body.classList.contains(GATE)).toBe(true);

		feature.unload();
	});

	it("follows the switch in a popout the same as in the main window", async () => {
		const wired = wire({ symbolLook: true });
		const feature = new CheckboxCycling(wired.host);
		feature.load();
		const popout = popoutDocument();
		wired.workspace.openWindow(popout);
		expect(popout.body.classList.contains(GATE)).toBe(true);

		await feature.saveSymbolLook(false);

		expect(document.body.classList.contains(GATE)).toBe(false);
		expect(popout.body.classList.contains(GATE)).toBe(false);

		await feature.saveSymbolLook(true);

		expect(document.body.classList.contains(GATE)).toBe(true);
		expect(popout.body.classList.contains(GATE)).toBe(true);

		feature.unload();
	});

	it("removes the class from every open window at unload, not only the main one", () => {
		const wired = wire({ symbolLook: true });
		const feature = new CheckboxCycling(wired.host);
		feature.load();
		const popout = popoutDocument();
		wired.workspace.openWindow(popout);
		expect(popout.body.classList.contains(GATE)).toBe(true);

		feature.unload();

		expect(document.body.classList.contains(GATE)).toBe(false);
		expect(popout.body.classList.contains(GATE)).toBe(false);
	});

	it("drops the window-open subscription at unload, so a window opened afterwards is never touched", () => {
		const wired = wire({ symbolLook: true });
		const feature = new CheckboxCycling(wired.host);
		feature.load();
		feature.unload();

		const popout = popoutDocument();
		wired.workspace.openWindow(popout);

		expect(popout.body.classList.contains(GATE)).toBe(false);
	});
});
