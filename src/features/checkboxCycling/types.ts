/**
 * What a checkbox-cycling sequence is made of.
 *
 * Shapes only, so that the settings screen, the editor half and the pure
 * stepping code all agree on one description of the data without any of them
 * having to import the others' behaviour.
 *
 * A **sequence** is a named, ordered list of checkbox symbols the person steps
 * a task line through with one key. It carries three things and the first of
 * them is the one that is easy to get wrong: the id is generated once and never
 * derived from the name, because Obsidian keys a hotkey by command id and a
 * name-derived id would lose the person's hotkey on every rename.
 */

/**
 * One sequence, as it is stored and as every part of the feature reads it.
 *
 * Nothing here is a display string except {@link Sequence.name}: the id is
 * machinery and the symbols are the characters written into the checkbox.
 */
export interface Sequence {
	/**
	 * Generated once, when the sequence is made, and never changed afterwards.
	 *
	 * It is what the sequence's two command ids are built from, so it is what the
	 * person's hotkey is keyed by. Renaming the sequence leaves it alone; that is
	 * the whole reason it exists rather than the name being used directly.
	 */
	readonly id: string;
	/** What the person typed. Shown in the palette and on the settings screen. */
	readonly name: string;
	/**
	 * The symbols, in the order a press steps through them. Each is one code
	 * point — the single character that sits between the checkbox brackets.
	 */
	readonly symbols: readonly string[];
}

/**
 * Which way along the sequence a press steps.
 *
 * Both ends wrap, so `backward` from the first symbol lands on the last. The
 * two words are also the last part of the two command ids a sequence produces,
 * so changing either word changes an id and costs the person their hotkey.
 */
export type CycleDirection = "forward" | "backward";
