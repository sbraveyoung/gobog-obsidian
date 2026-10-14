/* Front-matter helpers for the gobog-obsidian sync plugin.
 *
 * Two responsibilities:
 *   - generate a stable id for a new note
 *   - prepend a `---`-delimited YAML block, but only if the file doesn't
 *     already have one (and only fill in the keys that are missing — never
 *     overwrite what the user wrote)
 *
 * The plugin runs on save, not on render, so anything we write here ends up
 * persisted in the user's vault. Be conservative.
 */
import { readProperties, patchProperties } from "./article-properties";
export { readProperties, patchProperties, articleBody, publicationState } from "./article-properties";
export { checkArticles } from "./publish-check";
export interface FrontMatterDefaults {
    title: string;
    author: string;
    id: string;
    url: string;
    create_time: string;
    updated_time: string;
    draft?: boolean;
    publish?: boolean;
    tags?: string[];
    description?: string;
    category?: string;
    hidden?: boolean;
    private?: boolean;
    pin?: boolean;
    ai?: boolean;
    cover?: string;
}
/** Generate a short hex id (8 hex chars from a fresh random source). */
export function generateId(): string {
    const buf = new Uint8Array(4);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        crypto.getRandomValues(buf);
    }
    else {
        // Fallback: time + pseudo-random. Not cryptographically strong, but the
        // id only needs to avoid collision within one author's vault.
        const t = Date.now();
        for (let i = 0; i < 4; i++)
            buf[i] = (t >>> (i * 8)) & 0xff ^ Math.floor(Math.random() * 256);
    }
    return Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
/**
 * Return `body` with a YAML front-matter block, filling in any `defaults`
 * keys that aren't already set. Never overwrites existing values; never
 * collapses an existing block. If the file has no front matter, prepends a
 * fresh one with all the default keys.
 *
 * Parse keys using Obsidian’s YAML parser; keep the original block text so
 * comments, custom properties and formatting remain intact.
 */
export function ensureFrontMatter(body: string, defaults: FrontMatterDefaults): string {
    const present = readProperties(body);
    const missing: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(defaults)) {
        if (value === undefined || key in present)
            continue;
        if ((key === 'draft' || key === 'publish') && ('draft' in present || 'publish' in present))
            continue;
        missing[key] = value;
    }
    return Object.keys(missing).length ? patchProperties(body, missing) : body;
}
