/**
 * The one place a test finds a file under `src/__tests__/__fixtures__/`.
 *
 * **The form, and the reason for it.** The path is built with `resolve` from
 * `__dirname` — this file's own folder — so a fixture is found whatever the
 * working directory is. The form to avoid is
 * `new URL(..., import.meta.url)`, because Vite rewrites that into one of its
 * own asset lookups and the test then reads something other than the file on
 * disk. `join(dirname(fileURLToPath(import.meta.url)), …)` avoids that rewrite
 * too, which is why one suite used it; it is simply the longer way to the same
 * place, and having both in the tree is what issue
 * #185 was filed about.
 *
 * The reason is written here rather than in each suite because it was written
 * in two suites before, and the two copies contradicted each other: one warned
 * against `import.meta.url` and the other's replaced comment had warned towards
 * it. Whoever rewrites the suite's `process.cwd()` reads onto `__dirname` should apply this
 * form rather than pick another.
 *
 * It lives in `src/__tests__/` and is not a `.test.ts` file, so vitest imports
 * it and runs nothing from it. It is a sibling of `sourceGuards.ts` rather than
 * part of it: that module reads the plugin's shipped source, this one reads
 * test fixtures, and they change for different reasons
 * (#162's note asked for
 * them to stay apart).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The contents of `src/__tests__/__fixtures__/<name>`, as text. */
export function fixture(name: string): string {
	return readFileSync(resolve(__dirname, "__fixtures__", name), "utf8");
}
