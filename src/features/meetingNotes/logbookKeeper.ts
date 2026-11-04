/**
 * When the logbook pass runs:
 * after every meeting-notes run, and a moment after a meeting note changes, is
 * deleted or is renamed — always one at a time, so two passes never work from
 * the same memory and the later save never undoes the earlier one.
 *
 * **A rename is taken into the memory in the same queue**, ahead of the pass
 * it schedules, so the pass looks for the line under the renamed note's path
 * (`renamedInLogbook`).
 *
 * The pass itself does not hold anything up: a write held for a collection the
 * person is typing in keeps only this queue waiting, never the meeting-notes
 * run that started it.
 */

import { noteName } from "../../core/collections";
import { reasonOf } from "../../core/reason";
import { runLogbook } from "./logbook";
import type { LogbookPorts } from "./logbook";
import { renamedInLogbook } from "./logbookMemory";
import type { LogbookMemory } from "./logbookMemory";
import type { MeetingNoteTemplate } from "./types";

/** How long the vault must be quiet after a change before the pass runs: a run of saves while typing is one pass. */
export const LOGBOOK_SETTLE_MS = 2000;

/** What the keeper asks of its feature, each read when asked and never kept. */
export interface LogbookKeeperHost {
	/** Whether the feature is `ready` now. */
	ready(): boolean;
	/** The logbook heading, or `null` while the stored one is refused. */
	heading(): string | null;
	/** What each logbook line starts with, or `null` while the stored start is refused. */
	lineStart(): string | null;
	template(): Pick<MeetingNoteTemplate, "tag" | "effortField">;
	memory(): LogbookMemory;
	save(memory: LogbookMemory): Promise<void>;
	/** The ports for one pass, writing every wanted line with `start`. */
	ports(start: string): LogbookPorts;
	notice(message: string): void;
}

export class LogbookKeeper {
	private work: Promise<void> = Promise.resolve();
	/** A pass is queued and not started yet; another asked for now would do the same work. */
	private passQueued = false;
	private timer: number | null = null;
	private stopped = false;

	constructor(private readonly host: LogbookKeeperHost) {}

	/** A pass once the vault has been quiet for {@link LOGBOOK_SETTLE_MS}. */
	passSoon(): void {
		if (this.stopped) return;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.pass();
		}, LOGBOOK_SETTLE_MS);
	}

	/** A pass, after whatever is already queued; joins one queued and not yet started. */
	pass(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.passQueued) return this.work;
		this.passQueued = true;
		return this.queue(async () => {
			this.passQueued = false;
			await this.runPass();
		});
	}

	/** Takes a rename this device saw into the memory, then asks for a pass. */
	renamed(oldPath: string, newPath: string): Promise<void> {
		if (this.stopped) return Promise.resolve();
		const done = this.queue(async () => {
			const memory = this.host.memory();
			// While the line start is refused no line can be said in the current
			// shape, so the entry keeps its old line (`renamedInLogbook`'s own
			// fallback) and still follows the note to its new path.
			const start = this.host.lineStart();
			const ports = start === null ? null : this.host.ports(start);
			const next = renamedInLogbook(memory, oldPath, newPath, (note, collection) => ports?.lineFor(note, collection) ?? null);
			if (next !== memory) await this.host.save(next);
		});
		this.passSoon();
		return done;
	}

	/** Nothing more runs: the pending pass is dropped, and queued work finds the keeper stopped. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	/**
	 * Runs `work` after everything queued before it. A step that fails — a
	 * collection that cannot be read, a memory that cannot be saved — is said in
	 * a notice here and goes no further, so the queue goes on for the next step
	 * and no caller is left holding a rejection nobody hears.
	 */
	private queue(work: () => Promise<void>): Promise<void> {
		const next = this.work.then(async () => {
			if (this.stopped) return;
			try {
				await work();
			} catch (error) {
				this.host.notice(`Effortless: meeting notes could not keep the logbook: ${reasonOf(error)}`);
			}
		});
		this.work = next;
		return next;
	}

	private async runPass(): Promise<void> {
		if (!this.host.ready()) return;
		const heading = this.host.heading();
		if (heading === null) return;
		const start = this.host.lineStart();
		if (start === null) return;
		const memory = this.host.memory();
		// A collection that cannot even be read rejects the whole pass, which
		// {@link queue} says; the memory stays as it was.
		const result = await runLogbook(this.host.ports(start), this.host.template(), heading, memory);
		if (this.stopped) return;
		if (JSON.stringify(result.memory) !== JSON.stringify(memory)) await this.host.save(result.memory);
		if (result.failed.length > 0) {
			const each = result.failed.map(({ path, reason }) => `${noteName(path)} (${reason})`).join(", ");
			this.host.notice(`Effortless: meeting notes could not write the logbook in ${each}, and tries again at its next run.`);
		}
	}
}
