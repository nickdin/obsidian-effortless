/**
 * What the rest of the plugin may reach into this feature for.
 *
 * `main.ts` needs the class and nothing else. Everything not named here — how
 * the popup decides, how a stamp is written, what a trigger may be — is the
 * feature's own and stays inside it, which is what keeps the feature contract's
 * "no feature references another" cheap to hold.
 */

export { DateEntry } from "./dateEntry";
export { FEATURE_ID } from "./types";
export type { DateEntrySettings } from "./types";
