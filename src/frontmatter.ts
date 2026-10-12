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

import { parseYaml } from "obsidian";

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
  } else {
    // Fallback: time + pseudo-random. Not cryptographically strong, but the
    // id only needs to avoid collision within one author's vault.
    const t = Date.now();
    for (let i = 0; i < 4; i++) buf[i] = (t >>> (i * 8)) & 0xff ^ Math.floor(Math.random() * 256);
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
  const { existingBlock, rest, hasBlock } = splitFrontMatter(body);

  const keys: (keyof FrontMatterDefaults)[] = [
    "title",
    "author",
    "id",
    "url",
    "create_time",
    "updated_time", "tags", "description", "category", "hidden", "private", "pin", "ai", "cover",
  ];

  if (!hasBlock) {
    const lines = ["---"];
    for (const k of keys) if (defaults[k] !== undefined) lines.push(`${k}: ${JSON.stringify(defaults[k])}`);
    if (defaults.draft !== undefined) lines.push(`draft: ${defaults.draft}`);
    if (defaults.publish !== undefined) lines.push(`publish: ${defaults.publish}`);
    lines.push("---", "");
    return lines.join("\n") + body;
  }

  const present = parseKeys(existingBlock);
  const missing: string[] = [];
  for (const k of keys) {
    if (!present.has(k) && defaults[k] !== undefined) missing.push(`${k}: ${JSON.stringify(defaults[k])}`);
  }
  if (defaults.draft !== undefined && !["draft", "publish"].some(k => present.has(k))) missing.push(`draft: ${defaults.draft}`);
  if (defaults.publish !== undefined && !present.has("publish") && !present.has("draft")) missing.push(`publish: ${defaults.publish}`);
  if (missing.length === 0) return body;

  // Insert missing keys right before the closing `---`. Preserves the
  // user's ordering of existing keys and any blank lines / comments.
  const lines = existingBlock.split("\n");
  // Last line of existingBlock is the closing `---`. Insert before it.
  let endIdx = lines.length - 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  const newBlock = [...lines.slice(0, endIdx), ...missing, ...lines.slice(endIdx)].join("\n");
  return newBlock + rest;
}

/**
 * Split `body` into the leading front-matter block (including delimiters)
 * and the rest. Returns hasBlock=false when the file doesn't start with
 * `---\n`.
 */
function splitFrontMatter(body: string): {
  existingBlock: string;
  rest: string;
  hasBlock: boolean;
} {
  if (!/^---[ \t]*\r?\n/.test(body)) {
    return { existingBlock: "", rest: body, hasBlock: false };
  }
  // Find the closing `---` on its own line (allow trailing whitespace).
  const lines = body.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error("Front matter has no closing ---; fix YAML before filling metadata.");
  }
  const blockLines = lines.slice(0, closeIdx + 1);
  const restLines = lines.slice(closeIdx + 1);
  return {
    existingBlock: blockLines.join("\n"),
    rest: (restLines.length > 0 ? "\n" : "") + restLines.join("\n"),
    hasBlock: true,
  };
}

function parseKeys(block: string): Set<string> {
  const lines = block.split("\n");
  const values = parseYaml(lines.slice(1, -1).join("\n")) ?? {};
  if (typeof values !== "object" || Array.isArray(values)) throw new Error("Front matter must be a YAML mapping.");
  return new Set(Object.keys(values));
}
