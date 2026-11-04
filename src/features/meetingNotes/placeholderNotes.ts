/**
 * Which notes in the vault are an older build's note for a meeting that then
 * had no title. The name they carry is the core's own
 * ({@link meetingNotePath} over an empty summary), so a change to the note-name
 * shape reaches this search too and does not silently stop finding them.
 */

import { meetingNotePath } from "./notePath";

/**
 * The paths among `markdownPaths` that are placeholder notes for `date` under
 * `folder`. A name ending in ` 1` counts too — inferred to be how Obsidian
 * names a second note of one name, not driven: a second placeholder note is
 * exactly the case that must not be guessed at.
 */
export function placeholderNotePaths(
  markdownPaths: readonly string[],
  folder: string,
  date: string,
): string[] {
  const path = meetingNotePath(folder, date, "");
  const base = path.slice(0, -".md".length);
  return markdownPaths.filter(
    (candidate) =>
      candidate === path ||
      (candidate.startsWith(base) &&
        /^ \d+\.md$/.test(candidate.slice(base.length))),
  );
}
