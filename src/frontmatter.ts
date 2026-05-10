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

export interface FrontMatterDefaults {
  title: string;
  author: string;
  id: string;
  url: string;
  create_time: string;
  updated_time: string;
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
 * The YAML parsing is intentionally minimal — the file format is
 * "key: value" lines between `---` markers, matching what gobog reads.
 */
export function ensureFrontMatter(body: string, defaults: FrontMatterDefaults): string {
  const { existingBlock, rest, hasBlock } = splitFrontMatter(body);

  const keys: (keyof FrontMatterDefaults)[] = [
    "title",
    "author",
    "id",
    "url",
    "create_time",
    "updated_time",
  ];

  if (!hasBlock) {
    const lines = ["---"];
    for (const k of keys) lines.push(`${k}: ${defaults[k]}`);
    lines.push("---", "");
    return lines.join("\n") + body;
  }

  const present = parseKeys(existingBlock);
  const missing: string[] = [];
  for (const k of keys) {
    if (!present.has(k)) missing.push(`${k}: ${defaults[k]}`);
  }
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
  if (!body.startsWith("---")) {
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
    return { existingBlock: "", rest: body, hasBlock: false };
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
  const out = new Set<string>();
  for (const line of block.split("\n")) {
    if (line.startsWith("---")) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}
