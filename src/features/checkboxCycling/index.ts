/**
 * What the rest of the plugin may reach into this feature for.
 *
 * `main.ts` needs the class and nothing else; the settings screen that comes
 * later needs the sequence shapes and the two functions that make and judge
 * one. Everything not named here — how a press reads a selection, what a line
 * kind is, how the stepping works — is the feature's own and stays inside it,
 * which is what keeps the feature contract's "no feature references another"
 * cheap to hold.
 */

export { CheckboxCycling } from "./checkboxCycling";
export type { CheckboxCyclingSettings, CyclingEditor } from "./checkboxCycling";
export {
	DEFAULT_SEQUENCES,
	FEATURE_ID,
	commandIdFor,
	createSequence,
	newSequenceId,
	repeatedSymbol,
	sequencesReadiness,
	symbolRefusal,
} from "./sequences";
export type { RepeatedSymbol } from "./sequences";
export type { CycleDirection, Sequence } from "./types";
