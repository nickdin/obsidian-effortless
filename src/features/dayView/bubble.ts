/**
 * The bubble: the small box that says what a block or bar cannot show — a
 * block's time, and a meeting's text where the block clips it.
 *
 * Carried from `~/Devbox/schema-render/src/renderer.ts:313-378`. What it says
 * is {@link bubbleText}, a pure function; {@link Bubble} is the element and
 * nothing else. When it shows — a hover on the laptop, a tap on a phone — is
 * `openMeeting.ts`'s, which also knows what a tap on it opens.
 *
 * **It is mounted on the anchor block's own document's body**, not in the
 * drawn block: live preview draws a block inside an element carrying a CSS
 * `transform`, which makes a `position: fixed` child measure itself against
 * that element instead of the window, and the bubble lands in the wrong
 * place. Mounting on the block's own document, rather than the main window's,
 * is what keeps a popout's bubble in the popout. **It shows and hides
 * by a class**, as the now-line does, never by an inline `display`, which
 * Obsidian's community-plugin-list rules forbid; its place on screen, which
 * depends on where the block is, is the one thing set inline, as a block's own
 * geometry is in `render.ts`.
 */

import type { Component } from "obsidian";

/** How long the pointer rests on a block or bar before its bubble appears. */
export const BUBBLE_DELAY_MS = 300;

/** The class a hidden bubble carries. Hidden rather than absent, so it can be measured before it is placed. */
export const BUBBLE_HIDDEN_CLASS = "effortless-day-view-bubble--hidden";

/** What the bubble is told about the meeting under it: its time on the grid, or `null` for an all-day bar, and its drawn text. */
export interface BubbleMeeting {
	readonly time: { readonly startMin: number; readonly endMin: number } | null;
	readonly text: string;
}

/**
 * What the bubble says for `meeting`, or `null` when it has nothing to say.
 *
 * A block's bubble always says its time — the grid shows a place, not the
 * digits — and adds the meeting's text only when the block clips it. A bar's
 * time is the whole day, which the band exists to leave unsaid, so a bar's
 * bubble says only its text, and only when clipped: a bar whose text fits
 * shows no bubble at all rather than an empty one.
 */
export function bubbleText(meeting: BubbleMeeting, clipped: boolean): string | null {
	const parts: string[] = [];
	if (meeting.time !== null) parts.push(`${clock(meeting.time.startMin)}–${clock(meeting.time.endMin)}`);
	if (clipped && meeting.text !== "") parts.push(meeting.text);
	return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The one bubble a drawn day's blocks and bars share, made on the body the
 * first time it is shown and removed when `owner` — the drawn block's own
 * child — unloads.
 */
export class Bubble {
	private el: HTMLElement | null = null;

	private gone = false;

	/**
	 * @param owner unloads when Obsidian throws the drawn block away; the bubble goes with it.
	 * @param tapped called when the showing bubble itself is tapped or clicked.
	 */
	constructor(
		owner: Component,
		private readonly tapped: () => void,
	) {
		owner.register(() => {
			this.gone = true;
			this.el?.remove();
			this.el = null;
		});
	}

	/** Whether the bubble is on screen now. */
	get showing(): boolean {
		return this.el !== null && !this.el.classList.contains(BUBBLE_HIDDEN_CLASS);
	}

	/** Whether the block that owns this bubble has already unloaded. A show after that must add nothing. */
	get disposed(): boolean {
		return this.gone;
	}

	/** Whether `target` is the bubble or inside it. */
	holds(target: EventTarget | null): boolean {
		return this.el !== null && target instanceof Node && this.el.contains(target);
	}

	/**
	 * Shows `text` beside `anchor`: to its left, or to its right where the left
	 * would run off the window. Does nothing once the block has unloaded, so a
	 * hover begun before cannot leave a bubble behind.
	 */
	show(anchor: HTMLElement, text: string): void {
		if (this.gone) return;
		const el = this.element(anchor);
		el.setText(text);

		// Measured while hidden and far off screen, so it never flickers at the
		// wrong place before it is moved.
		el.setCssProps({ left: "-9999px", top: "-9999px" });
		const width = el.offsetWidth;

		const rect = anchor.getBoundingClientRect();
		let left = rect.left - width - 8;
		if (left < 0) left = rect.right + 8;
		el.setCssProps({ left: `${left}px`, top: `${rect.top}px` });
		el.toggleClass(BUBBLE_HIDDEN_CLASS, false);
	}

	hide(): void {
		this.el?.toggleClass(BUBBLE_HIDDEN_CLASS, true);
	}

	/**
	 * Lets go of the element once made, so the next {@link show} remakes it —
	 * a tab carrying the anchor moved to another window, and the caller has
	 * already decided `doc` is where it belongs now. Does nothing
	 * before anything has ever shown, or when the element is already there.
	 */
	moveTo(doc: Document): void {
		if (this.el === null || this.el.doc === doc) return;
		this.el.remove();
		this.el = null;
	}

	/**
	 * Made in `anchor`'s own document — the popout's, when `anchor` is drawn
	 * there — never the main window's regardless of where the code itself
	 * runs. Made again, fresh, whenever {@link moveTo} has just let
	 * the previous one go: the caller decides when the anchor's document has
	 * moved on, this only ever answers for the document it is asked about now.
	 */
	private element(anchor: HTMLElement): HTMLElement {
		if (this.el !== null) return this.el;
		const el = anchor.doc.body.createDiv({ cls: ["effortless-day-view-bubble", BUBBLE_HIDDEN_CLASS] });
		el.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.tapped();
		});
		this.el = el;
		return el;
	}
}

/** `HH:MM` for a minute of the day. */
function clock(minute: number): string {
	const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
	return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}
