/**
 * A short, fixed-shape fingerprint of a text, kept in place of the text itself
 * where a copy would cost too much — in `data.json`, which grows for ever, or in a
 * note's frontmatter, which the person reads.
 *
 * The fingerprint is a 53-bit hash of the text with its length beside it: a text
 * that differs by so much as a space fingerprints differently, and two different
 * texts reading alike is a chance far below anything else that could go wrong
 * here. Meeting notes uses it to tell a note nobody touched from one holding the
 * person's words, and the core uses
 * it for the diary section a day's log was built with. It lives in the
 * core so both read one rule: a feature may not import another feature's module.
 */

/** A fingerprint as {@link fingerprintOf} writes it: `<length>:<hash in hex>`. */
const FINGERPRINT_SHAPE = /^\d+:[0-9a-f]+$/;

/**
 * A fingerprint of `text`: its length and a 53-bit hash of it (cyrb53, public
 * domain), as `<length>:<hash in hex>`. Synchronous, so a check made inside
 * the writer's queue (`NoteWriter.trashIf`) can use it.
 */
export function fingerprintOf(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
	return `${text.length}:${hash.toString(16)}`;
}

/** Whether `value` has a fingerprint's shape, `<length>:<hash in hex>`: what a reader of a stored one checks before trusting it. */
export function isFingerprint(value: unknown): value is string {
	return typeof value === "string" && FINGERPRINT_SHAPE.test(value);
}
