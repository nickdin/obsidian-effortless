/**
 * Standing problems — how a feature says something is wrong and has it stay
 * said.
 *
 * A pairing breaks when a collection stops being one: its tasks heading is
 * renamed, or the note moves out of reach. The plugin then changes nothing in
 * either file and says so instead. Saying so is two things at once — one
 * `Notice` at the moment it happens, which fades, and a line on the settings
 * screen, which does not, until the feature that reported it clears it again.
 *
 * **One notice per standing key, never one per affected item.** Rename a
 * heading with twelve tasks under it and that is one report naming twelve
 * tasks, and one notice. A feature re-checks its work on every vault change, so
 * the same breakage arrives here over and over: a key that is already standing
 * speaks once, however its message moves afterwards, and the second and later
 * arrivals are silent.
 *
 * **Nothing is ever written into a note.** That is a property of this file's
 * shape rather than a rule anyone has to remember: `Problems` is built with no
 * vault and no app, and the handle a feature gets carries no route to either.
 *
 * What holds that claim is one test — `problems.test.ts`, "imports `Notice`
 * from `obsidian` and nothing else, so it holds no route to a note" — and it
 * holds the import half of it and no more. A vault arriving as a
 * structurally-typed parameter is not an import and is not seen there, and
 * `Problems` takes no host, so that half cannot be driven either. The claim
 * above is therefore wider than its guard on purpose; the test's own comment
 * says by how much, and is the thing to read before leaning on it.
 *
 * The channel is forced rather than chosen. Detecting the breakage belongs to a
 * feature; the settings screen and every note write belong to the core; and a
 * feature may reach neither directly.
 */

import { Notice } from "obsidian";

/** One thing that is wrong, as the settings screen reads it. */
export interface StandingProblem {
	/** The feature that reported it. */
	readonly featureId: string;
	/** That feature's name, so the screen can say who is complaining. */
	readonly featureName: string;
	/**
	 * Which thing this problem is about — a note path, a calendar source, a
	 * heading. Two reports under one key are one problem, which is what keeps a
	 * re-checking feature from announcing itself twice.
	 */
	readonly key: string;
	/** What is wrong, in the feature's own words, ready to read. */
	readonly message: string;
}

/**
 * The channel one feature reports through. It already knows which feature it
 * belongs to, so a feature can neither name another nor read another's
 * problems.
 *
 * A channel taken straight from `Problems` works for as long as it is held.
 * Whether a *feature* may still speak is a different question, and the answer
 * is the registry's rather than this file's: the handle a feature is given is
 * wrapped in `gatedProblems` below, and the registry supplies the rule
 * (`registry.ts`, `hostFor`). The shape of the wrapper lives here, beside the
 * interface it has to match member for member; this file still stays a store,
 * with no idea what a feature is.
 */
export interface FeatureProblems {
	/**
	 * Says that `key` is broken, and why. Only the first report of a key raises
	 * a `Notice`: the problem is standing after that, and a later report of the
	 * same key is the same event however its message reads. A changed message
	 * still replaces the standing line, so the settings screen keeps up.
	 */
	report(key: string, message: string): void;
	/** Says `key` is well again. Clearing something never reported does nothing. */
	clear(key: string): void;
	/** Says everything this feature reported is well again. */
	clearAll(): void;
}

/**
 * A `FeatureProblems` that asks permission before passing anything on.
 *
 * This exists so that the three-member shape is written once. Whoever needs a
 * conditional channel needs all three members and needs them to answer alike,
 * and a second hand-written copy of the interface is three places to forget.
 *
 * **Both arguments are called on every call, never once when the handle is
 * taken.** That is the whole point: a feature may keep one of these for its
 * whole life, across being switched off and on again, and it has to answer for
 * how things stand at the moment it speaks rather than at the moment it took
 * the handle.
 *
 * @param channel Where a permitted call goes. A function rather than a value,
 * because the caller may not be able to build a channel yet at the moment the
 * handle is taken — the registry's is keyed by a feature that does not exist
 * until its constructor has returned.
 * @param speaking Whether this call may pass. Returning `false` drops the call
 * silently, which is what a switched-off feature gets. It may also throw, and
 * then the throw reaches the caller untouched: a caller that must refuse some
 * calls outright rather than swallow them says so here, in one place, instead
 * of once per member.
 */
export function gatedProblems(
	channel: () => FeatureProblems,
	speaking: () => boolean,
): FeatureProblems {
	return {
		report: (key: string, message: string) => {
			if (speaking()) channel().report(key, message);
		},
		clear: (key: string) => {
			if (speaking()) channel().clear(key);
		},
		clearAll: () => {
			if (speaking()) channel().clearAll();
		},
	};
}

/**
 * Told whenever the set of standing problems has actually changed — one
 * arrived, one went, or one that was already standing broke differently. It is
 * given nothing: whoever wants to know what changed reads `all()` again.
 */
export type ProblemsListener = () => void;

/**
 * Every standing problem, from every feature. One of these exists per plugin,
 * built in `main.ts` and handed to both the registry and the settings screen —
 * a second one would be a screen that never shows what the features report.
 */
export class Problems {
	/**
	 * Keyed by feature and key together, so two features may use the same key
	 * for different things. Insertion order is the order they were first
	 * reported, and re-reporting one does not move it.
	 */
	private readonly standing = new Map<string, StandingProblem>();

	/** Everyone waiting to be told this changed. See `onChange`. */
	private readonly listeners = new Set<ProblemsListener>();

	/**
	 * True while `announce()` is telling everyone. See `announce()` for why a
	 * second round is refused rather than queued.
	 */
	private announcing = false;

	/** The channel for one feature. Cheap: it holds nothing of its own. */
	forFeature(featureId: string, featureName: string): FeatureProblems {
		return {
			report: (key: string, message: string) => {
				const id = entryId(featureId, key);
				const before = this.standing.get(id);
				this.standing.set(id, { featureId, featureName, key, message });
				// A standing key speaks once, however its message moves after
				// that: "once per event, never once per task",
				// and a count that climbs from twelve to thirteen under a key
				// that has been standing all along is the same event, not a
				// second one.
				if (before === undefined) new Notice(`Effortless: ${message}`);
				// The screen is the other channel and it does not go quiet: a
				// changed message must reach it, or it goes on showing wording
				// the feature has already replaced.
				else if (before.message === message) return;
				this.announce();
			},
			clear: (key: string) => {
				if (this.standing.delete(entryId(featureId, key))) this.announce();
			},
			clearAll: () => {
				let removed = false;
				for (const [id, problem] of this.standing) {
					if (problem.featureId === featureId) {
						this.standing.delete(id);
						removed = true;
					}
				}
				if (removed) this.announce();
			},
		};
	}

	/** Everything standing, oldest first. A fresh array each time. */
	all(): readonly StandingProblem[] {
		return [...this.standing.values()];
	}

	/**
	 * Asks to be told whenever this changes, and hands back the one way to stop
	 * being told. Whoever registers owns that call: nothing here drops a
	 * listener by itself.
	 *
	 * The settings screen is why this exists. It draws the section once and
	 * then sits there, so without being told it goes on showing a problem the
	 * feature has already said is fixed — and there is no "it is well again"
	 * notice to contradict it.
	 *
	 * Only real changes arrive. A feature re-checks its work on every vault
	 * change and reports the same breakage over and over; those repeats are as
	 * silent here as they are on the notice.
	 */
	onChange(listener: ProblemsListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * How many listeners are registered.
	 *
	 * Here so that a screen which forgets to drop its listener fails a test
	 * rather than being found months later. The settings screen's own listener
	 * is released at unload — its constructor registers the drop on the plugin. Other things
	 * the plugin holds have had the same shape: a feature reporting after
	 * unload, a
	 * debounce timer not owned by the plugin `Component`, and
	 * #150 before those two.
	 * Where each of those tickets stands is the tracker's to say and not this
	 * file's: a status sentence that once stood here was repaired by hand three
	 * times, and went stale again the same day. None
	 * of them was measurable from outside the object holding the reference,
	 * which is what a count is for.
	 */
	listenerCount(): number {
		return this.listeners.size;
	}

	/**
	 * Over a copy, so the round tells the listeners that were there when it
	 * started. A listener registered from inside the round is told at the next
	 * real change and not in this one: an announcement that grows its own
	 * audience mid-round is the unbounded shape this whole method is written
	 * against. Dropping a listener mid-round is *not* what the copy is for — a
	 * `Set` already tolerates deleting the element it is visiting, so that
	 * works either way.
	 *
	 * It refuses to re-enter. The settings screen redraws from here and runs
	 * feature-supplied code on the same pass, so a feature can report from a
	 * draw path — and a feature reporting a *varying* message never hits
	 * `report`'s early return, so a nested round would not terminate. Queueing
	 * the redraw instead does not terminate either: it queues the next one for
	 * ever rather than recursing for ever. A guard terminates in every case.
	 *
	 * The cost falls on the settings screen and not on the person. The notice
	 * is raised in `report` before the announcement, so a problem reported from
	 * inside a draw still raises its toast and is still recorded in `standing`;
	 * what waits is the row. The list goes on showing what it showed until the
	 * next real change redraws it. A feature reporting from its own draw path is
	 * misbehaving, and a slightly late row is a much better answer than an
	 * unbounded loop.
	 *
	 * **That cost is the same whichever draw the report came from, and it was
	 * not.** This guard is off for a draw the settings screen started itself —
	 * a card click — so a report from there passed it, redrew the screen from
	 * inside the draw, and left the outer pass appending its remaining cards to
	 * a container that had just been emptied and rebuilt. The screen carries a
	 * guard of its own on the draw for that
	 * (#225;
	 * `EffortlessSettingTab.drawing`). The two refuse different loops — this one
	 * a second round of announcements, that one a nested draw — and neither
	 * replaces the other.
	 *
	 * The `try`/`finally` is load-bearing: a listener that throws must not
	 * leave the guard stuck on, or nothing is ever announced again.
	 */
	private announce(): void {
		if (this.announcing) return;
		this.announcing = true;
		try {
			for (const listener of [...this.listeners]) listener();
		} finally {
			this.announcing = false;
		}
	}
}

/**
 * A feature's id and its key, joined by a character neither an id nor a vault
 * path can contain, so that a feature called `a` reporting `b/c` cannot collide
 * with one called `a/b` reporting `c`.
 */
function entryId(featureId: string, key: string): string {
	return `${featureId}\u0000${key}`;
}
