/**
 * One read of the vault for Review: the markdown
 * files listed once, and every note's frontmatter taken once from Obsidian's
 * metadata cache. The count, the list's rows and the chain of one refresh are
 * all drawn from the same read, so they can never be drawn from two vaults,
 * and the vault is not listed again for each of them.
 *
 * **Nothing here outlives the refresh that made it.** The next refresh reads
 * the vault again, so a note edited, renamed or deleted since is seen as it is
 * then. No note's text is read here: the readers that need text read it with
 * `cachedRead` themselves, for the notes they need.
 */

import type { MetadataCache, TFile, Vault } from "obsidian";
import type { ReviewNote } from "./waitingNotes";

/** The vault as one read found it. */
export interface VaultNotes {
	/** The moment the read was taken: the day the count, the rows and the chain of one refresh are all reckoned from. */
	readonly today: Date;
	/** Every markdown file, by path. */
	readonly files: ReadonlyMap<string, TFile>;
	/** Every markdown file with its frontmatter as the cache held it, and no text. */
	readonly notes: readonly ReviewNote[];
}

/** Lists the vault's markdown files once and takes each one's frontmatter once. */
export function readVaultNotes(vault: Vault, metadataCache: MetadataCache, today: Date): VaultNotes {
	const listed = vault.getMarkdownFiles();
	return {
		today,
		files: new Map(listed.map((file) => [file.path, file])),
		notes: listed.map((file) => ({
			path: file.path,
			frontmatter: metadataCache.getCache(file.path)?.frontmatter ?? null,
			text: "",
		})),
	};
}
