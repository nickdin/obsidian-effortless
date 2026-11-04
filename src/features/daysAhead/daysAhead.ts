/**
 * Building the days ahead: the feature itself, its settings, its readiness
 * and its run, in the shape spec
 * #687 decisions 1, 2, 3
 * and 10 ask for.
 *
 * **It references no other feature**, and reads the daily-log layout and the calendar column names from the
 * core, never from a feature.
 */

import { Notice } from "obsidian";
import { Feature } from "../../core/feature";
import type { Readiness, SettingsChanged } from "../../core/feature";
import { parseCalendarTableFromBody } from "../../core/calendarTable";
import { dailyLogPrefix } from "../../core/vaultLayout";
import { readRowMemory } from "./rowMemory";
import type { RowMemory } from "./rowMemory";
import { runWindow } from "./run";
import type { RunNotes, RunProblems } from "./run";
import {
	DAYS_AHEAD_SETTING_NAMES,
	DEFAULT_DAYS_AHEAD_SETTINGS,
	renderDaysAheadSettings,
	usableWindowDays,
	windowDaysRefusal,
} from "./settingsPanel";
import type { DaysAheadSettings } from "./settingsPanel";

/** Stable for ever: it keys this feature's slice of `data.json`. */
export const FEATURE_ID = "days-ahead";

/** Where the daily-log folder and filename are answered, named in a readiness sentence. */
const CORE_CARD = "Your day's logs";

/**
 * Ten seconds after the feature starts, matching `calendar-scaffold`'s own
 * cadence (`src/main.ts`), and close enough behind `host.calendar`'s own
 * fifteen-minute refresh (`src/core/calendarSources.ts:35`,
 * `REFRESH_EVERY_MS`) that the calendar's own refresh and this feature's
 * rebuild land close together at start-up too.
 */
const FIRST_RUN_DELAY_MS = 10_000;

/** Every fifteen minutes after the first run — the same `REFRESH_EVERY_MS`. */
const RUN_EVERY_MS = 15 * 60 * 1000;

export class DaysAhead extends Feature {
	readonly id = FEATURE_ID;

	readonly name = "Building the days ahead";

	readonly description =
		"Creates the day's log for today and the days ahead, and fills its calendar table from your calendars.";
	override readonly settingNames = DAYS_AHEAD_SETTING_NAMES;

	/**
	 * Taken here and used from `onload` onwards, as the feature contract asks:
	 * the handle finds its feature when it is read, not when it is taken.
	 */
	private readonly own = this.host.settings<DaysAheadSettings>(DEFAULT_DAYS_AHEAD_SETTINGS);

	/** A run already in flight; a second timer tick joins nothing and does nothing (decision 10, rule "one run at a time"). */
	private runInFlight = false;

	/**
	 * Which keys this feature currently has standing on the settings screen:
	 * dates, and the one fixed key a calendar source that will not read is reported
	 * under (`CALENDAR_READING_KEY`, #1211). `host.problems` (`FeatureProblems`) can be reported to and
	 * cleared, but never asked what is already standing, so `runWindow` needs
	 * this feature's own record to clear a date it no longer visits — kept
	 * for as long as this feature instance is loaded, which is exactly as
	 * long as anything could be standing under it.
	 */
	private readonly reportedDates = new Set<string>();

	/**
	 * Says once per load whether the stored `windowDays` is unusable — the
	 * pattern the day view's density notice already uses. The stored value is
	 * never rewritten, so this comes back at every start until the person
	 * changes it on the card, which shows the stored value it names.
	 *
	 * Registers both of this feature's own timers here, on the feature itself
	 * (`Feature extends Component`), which is what makes switching the feature
	 * off stop them — the day view's minute tick is the pattern
	 * (`src/features/dayView/dayView.ts:155`). **Onload runs whenever this
	 * feature is loaded at all, `unconfigured` included** — `standby` is the
	 * only readiness answer the core will not load it for
	 * (`src/core/registry.ts`'s `standsDown`) — so `tick` itself checks
	 * `readiness()` again before doing anything, rather than assuming the
	 * device and the layout are still answered by the time a timer fires.
	 *
	 * **Coming out of `standby` needs no new mechanism.** The core loads this
	 * feature the moment `recheckReadiness` finds it `ready`
	 * (`src/core/registry.ts`), which runs `onload` again — the first run's
	 * own ten-second delay is the "run at once" decision 4 asks for, and
	 * nothing here retries a start that already failed.
	 */
	override onload(): void {
		const stored = this.storedWindowDays();
		if (usableWindowDays(stored) === null) {
			new Notice(`Effortless: ${windowDaysRefusal(stored)}`);
		}

		const firstRun = window.setTimeout(() => this.tick(), FIRST_RUN_DELAY_MS);
		this.register(() => window.clearTimeout(firstRun));
		this.registerInterval(window.setInterval(() => this.tick(), RUN_EVERY_MS));
	}

	/**
	 * One timer's firing. Does nothing, and says nothing, when a run is
	 * already in flight or when this feature is not `ready` right now — a
	 * device switch or an unanswered layout is already said on the settings
	 * screen through `readiness()` itself, and running anyway would mean
	 * `host.notes.createDailyLog` throwing on an unanswered daily-log folder,
	 * reported once per day in the window for one cause that is not the
	 * day's own.
	 */
	private tick(): void {
		if (this.runInFlight) return;
		if (this.readiness().state !== "ready") return;

		this.runInFlight = true;
		void this.runOnce().finally(() => {
			this.runInFlight = false;
		});
	}

	private async runOnce(): Promise<void> {
		await runWindow({
			calendar: this.host.calendar,
			notes: this.notesPort(),
			problems: this.problemsPort(),
			layout: this.host.core.layout,
			windowDays: this.windowDays(),
			today: new Date(),
			memory: this.storedRowMemory(),
			commitMemory: (memory) => this.saveRowMemory(memory),
		});
	}

	/**
	 * `host.notes` narrowed to what a run needs, plus a plain read — never
	 * `host.app` for anything else, and never for a write: `read` only peeks,
	 * so that `run.ts` can tell a day needs no change without ever asking
	 * `host.notes.edit` to find that out for it (decision 10, rule 7).
	 */
	private notesPort(): RunNotes {
		return {
			createDailyLog: (date, layout) => this.host.notes.createDailyLog(date, layout),
			read: (file) => this.host.app.vault.cachedRead(file),
			edit: (file, edit) => this.host.notes.edit(file, edit),
		};
	}

	/** `host.problems` plus {@link reportedDates}, which is what lets `list()` answer at all. */
	private problemsPort(): RunProblems {
		return {
			report: (key, message) => {
				this.reportedDates.add(key);
				this.host.problems.report(key, message);
			},
			clear: (key) => {
				this.reportedDates.delete(key);
				this.host.problems.clear(key);
			},
			list: () => [...this.reportedDates],
		};
	}

	/** This feature's memory of what it last wrote, validated the way `rows` on `data.json` always is. */
	private storedRowMemory(): RowMemory {
		return readRowMemory((this.own.read() as { rows?: unknown }).rows);
	}

	/** Stores `rows` at once — this is the run's own commit, never a keystroke, so it never defers. */
	private saveRowMemory(memory: RowMemory): Promise<void> {
		return this.own.save({ ...this.own.read(), rows: memory });
	}

	/**
	 * `standby` beats everything else here, because there is nothing for a
	 * person to configure on a device that is not doing the job — the core's
	 * own precedence for the seven states (`src/core/registry.ts`). This is
	 * the first feature to return it: #26
	 * asked for a reused `off` with a reason, and the core, built after #26
	 * closed, generalised that into a readiness answer of its own
	 * (`src/core/feature.ts`'s `Readiness`).
	 *
	 * Below that, `unconfigured` names whichever of the daily-log folder, the
	 * filename pattern or the two calendar column names is missing — unlike
	 * the day view, the folder and the filename **are** readiness here:
	 * without them `dailyLogPath` throws and no day can be created at all.
	 *
	 * Never `unavailable`: #26
	 * put this feature on every device once the calendar stopped being a file
	 * on disk, amending #23.
	 */
	readiness(): Readiness {
		if (!this.host.device.buildsTheDays()) {
			return { state: "standby", reason: "Another device builds the days." };
		}

		const layout = this.host.core.layout;

		if (dailyLogPrefix(layout) === null) {
			return {
				state: "unconfigured",
				reason: `The daily-log folder is not set. Enter it under Folder on the ${CORE_CARD} card.`,
			};
		}
		if (!layout.dailyLogFilename.trim()) {
			return {
				state: "unconfigured",
				reason: `The daily-log filename pattern is not set. Enter it under Filename on the ${CORE_CARD} card.`,
			};
		}

		const columns = parseCalendarTableFromBody([], layout.calendarColumns);
		if (!columns.found && columns.absence === "column-name-blank") {
			return {
				state: "unconfigured",
				reason: `One of the two calendar table column names is blank, so no table can be found. Enter both under Calendar table columns on the ${CORE_CARD} card.`,
			};
		}
		if (!columns.found && columns.absence === "column-names-alike") {
			return {
				state: "unconfigured",
				reason: `The two calendar table column names read as the same name, so they cannot tell two columns apart. Give them different names under Calendar table columns on the ${CORE_CARD} card.`,
			};
		}

		return { state: "ready" };
	}

	/**
	 * `changed` is unused: `renderDaysAheadSettings`'s own doc comment says
	 * why this card never calls it.
	 */
	override displaySettings(containerEl: HTMLElement, _changed: SettingsChanged): void {
		renderDaysAheadSettings(containerEl, this);
	}

	/** The `windowDays` field exactly as `data.json` holds it, unjudged — what the card shows. */
	storedWindowDays(): unknown {
		return (this.own.read() as { windowDays?: unknown }).windowDays;
	}

	/** How many days ahead a run would keep ready: the stored value when usable, the shipped default otherwise. */
	windowDays(): number {
		return usableWindowDays(this.storedWindowDays()) ?? DEFAULT_DAYS_AHEAD_SETTINGS.windowDays;
	}

	/**
	 * Stores `windowDays` once the typing that asked for it has stopped
	 * (`renderDaysAheadSettings`'s own doc comment says why the box defers
	 * rather than writes on every keystroke).
	 */
	async saveWindowDaysSoon(windowDays: number): Promise<void> {
		await this.own.saveSoon({ ...this.own.read(), windowDays });
	}
}
