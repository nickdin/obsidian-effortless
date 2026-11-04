/**
 * A caught thrown thing, as a sentence to show someone.
 *
 * `catch` hands back `unknown`, so anything with something to say about a
 * failure has to answer the same question first. **Six sites answered it**
 * separately — `src/core/icsOccurrences.ts`, `src/core/registry.ts`,
 * `src/core/settingsTab.ts` twice, `src/core/calendarSourcesSection.ts` and
 * `src/main.ts`. **Five of the six answered it worse:** only
 * `src/core/icsOccurrences.ts` handled an `Error` whose message is empty, and
 * the other five ended the sentence in nothing at all. The two numbers
 * count different things and say which, because they were read as one and
 * neither matched the list beside them. Each site is
 * named by its path because two of the core's files answer to the same
 * plain-words name; `README.md`'s map of the core is where what each one owns
 * is written down.
 *
 * Its own module rather than a home in one of the six. It lived in
 * `src/core/icsOccurrences.ts`, the only file that knows the two calendar
 * libraries exist; importing it from there would make the settings screen and
 * the plugin's entry point depend on that file — and so on both libraries — in
 * order to describe a failure, which is a worse coupling than the duplication
 * it removes. One function, one reason to change.
 */

/**
 * What the thrown thing says, or what it is when it says nothing.
 *
 * An `Error` with an empty message falls through to `String(error)`, which
 * answers the type's own name. A name is less than a sentence and far more than
 * the empty string the five worse copies produced.
 */
export function reasonOf(error: unknown): string {
	return error instanceof Error && error.message !== "" ? error.message : String(error);
}
