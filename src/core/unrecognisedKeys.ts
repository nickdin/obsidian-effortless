/**
 * The settings in `data.json` that this build of the plugin does not
 * recognise, and how they are carried back into the file.
 *
 * Every device shares one `data.json` through Sync, and the devices need not
 * run the same build. A build reads the core settings key by key, so a key a
 * newer build added is one this build has no reader for. Before issue #1209 it
 * was simply dropped, and the next save from the older device removed it from
 * the file every device reads: a Diary heading the person had filled in went
 * blank everywhere, with no notice. From that issue on, such a key is carried
 * as the file holds it and written back unchanged.
 *
 * Plain functions over plain records. Nothing here writes the file: the one
 * caller of `saveData` is `settings.ts`, which holds what these find and hands
 * it back at every write.
 */

// A type only, and erased: `settings.ts` imports this module's values, so a
// value import back would be a cycle at run time.
import type { EffortlessData } from "./settings";

/**
 * The keys under `core` and under `core.layout` that this build does not
 * recognise, as the file holds them: most likely a newer build's settings.
 * Never read or changed by this build, and written back with every save.
 */
export interface Unrecognised {
	core: Record<string, unknown>;
	layout: Record<string, unknown>;
}

/** The entries of `record` whose key is not in `known`, in the file's order. */
export function unrecognisedIn(record: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
	const found: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!known.has(key)) found[key] = value;
	}
	return found;
}

/**
 * The settings as `data.json` is to hold them: `data`, with the keys this build
 * does not recognise put back after the ones it does. With none, the result
 * serialises exactly as `data` does, so a file with nothing unrecognised is
 * written byte for byte as before issue #1209.
 */
export function withUnrecognised(data: EffortlessData, unrecognised: Unrecognised): EffortlessData {
	return {
		...data,
		core: {
			...data.core,
			...unrecognised.core,
			layout: { ...data.core.layout, ...unrecognised.layout },
		},
	};
}
