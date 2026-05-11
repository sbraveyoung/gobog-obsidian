/* wechat.ts — WeChat MP (公众号) draft submission.
 *
 * Flow when the user runs "Push to WeChat as draft":
 *   1. POST /cgi-bin/stable_token with AppID + AppSecret → access_token
 *      (cached in memory for ~1h50m; refreshed lazily).
 *   2. For every local image referenced in the markdown
 *      (![alt](./resource/image/foo.png) or ![[foo.png]]):
 *        - POST /cgi-bin/material/add_material?type=image (multipart) →
 *          { media_id, url }. Rewrite the markdown to use the returned
 *          public CDN URL so WeChat can render it.
 *   3. Convert markdown → HTML via `marked`. We inline a small style
 *      block at the top of the HTML; WeChat's editor preserves inline
 *      styles but strips <style> blocks at submission time. Inline is
 *      safer.
 *   4. POST /cgi-bin/draft/add with the article HTML, title, author,
 *      digest (summary), cover thumb_media_id. Returns a media_id —
 *      hand it to the user so they can find the draft in the WeChat
 *      backend.
 *
 * The "manual review" requirement is satisfied by the API itself:
 * drafts are *never* auto-published — the user opens
 * https://mp.weixin.qq.com/ → 草稿箱 → preview → publish.
 *
 * Caveats:
 *   - WeChat requires the caller's egress IP to be whitelisted in the MP
 *     console (IP 白名单). On error 40164 the user has to add their
 *     home IP.
 *   - access_token has 1 of 2 endpoints today: /token (legacy, 2h ttl) or
 *     /stable_token (stable, less rotation overhead). We use stable_token.
 *   - The image upload limit is 10 MB per image / 64 KB per voice etc.
 *     We don't downscale — large vault images will fail server-side.
 */

import * as fs from "fs";
import * as path from "path";
import { marked } from "marked";

export interface WeChatOpts {
  appId: string;
  appSecret: string;
  author: string;
  /** Cover thumb_media_id. If empty, we upload the first image in the
   *  article (or fail if there isn't one). */
  defaultThumbMediaId: string;
  /** Vault-side base path used to resolve relative image references. */
  vaultBase: string;
  /** Optional callback that takes a title and returns a description /
   *  digest (≤ 120 chars). If omitted, we pick the first paragraph. */
  digestExtractor?: (markdown: string) => string;
}

export interface ArticleInput {
  title: string;
  author: string;
  /** Raw markdown including front matter (we strip it ourselves). */
  markdown: string;
  /** Optional canonical URL written into the WeChat "原文链接" slot. */
  canonicalUrl?: string;
}

export interface DraftResult {
  /** media_id of the freshly-created draft. Use this in the
   *  WeChat backend to preview / publish. */
  mediaId: string;
}

const WECHAT_BASE = "https://api.weixin.qq.com";

interface TokenCacheEntry {
  token: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCacheEntry | null = null;
// Refresh 5 min before declared expiry so we never present a stale token
// to a subsequent request.
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - TOKEN_SAFETY_MARGIN_MS > now) {
    return tokenCache.token;
  }
  const body = {
    grant_type: "client_credential",
    appid: appId,
    secret: appSecret,
    force_refresh: false,
  };
  const res = await fetch(`${WECHAT_BASE}/cgi-bin/stable_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j: any = await res.json();
  if (j.errcode) {
    throw new Error(`wechat token error ${j.errcode}: ${j.errmsg}`);
  }
  tokenCache = {
    token: j.access_token as string,
    expiresAt: now + Number(j.expires_in || 7200) * 1000,
  };
  return tokenCache.token;
}

/**
 * Upload a local file as a permanent image asset. Returns the public
 * CDN URL (used inside the article HTML) plus the media_id (used when
 * the image becomes the thumb of the draft).
 */
async function uploadImage(
  token: string,
  filePath: string,
): Promise<{ mediaId: string; url: string }> {
  const buf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const mime = guessMime(filename);
  const form = new FormData();
  const blob = new Blob([buf], { type: mime });
  form.append("media", blob, filename);
  const res = await fetch(
    `${WECHAT_BASE}/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
    { method: "POST", body: form as any },
  );
  const j: any = await res.json();
  if (j.errcode) {
    throw new Error(`wechat upload error ${j.errcode}: ${j.errmsg} (${filename})`);
  }
  return { mediaId: j.media_id as string, url: j.url as string };
}

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "png":  return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "bmp":  return "image/bmp";
    default:     return "application/octet-stream";
  }
}

/**
 * Walk the markdown for image refs, upload each one to WeChat, and
 * return a rewritten markdown plus the list of uploaded media_ids
 * (so the caller can use the first one as the cover).
 *
 * Refs handled:
 *   - markdown:  ![alt](./resource/image/foo.png)   relative paths only
 *   - obsidian:  ![[foo.png]]                       basename via vaultBase
 *
 * Absolute URLs are left alone — WeChat happily renders any http(s) src.
 */
async function rewriteImages(
  token: string,
  md: string,
  vaultBase: string,
): Promise<{ md: string; uploaded: { mediaId: string; url: string }[] }> {
  const uploaded: { mediaId: string; url: string }[] = [];
  // Cache so an image referenced twice only uploads once.
  const cache = new Map<string, { mediaId: string; url: string }>();

  // 1. Obsidian-style embeds: ![[name.png]] or ![[name.png|alt]].
  const obsidianRe = /!\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;
  let out = "";
  let lastIdx = 0;
  for (const m of md.matchAll(obsidianRe)) {
    out += md.slice(lastIdx, m.index);
    const target = m[1].trim();
    const alt = (m[2] || target).trim();
    if (isImage(target)) {
      const abs = resolveImage(vaultBase, target);
      if (abs && fs.existsSync(abs)) {
        const up = cache.get(abs) || (await uploadImage(token, abs));
        cache.set(abs, up);
        if (!uploaded.some((u) => u.url === up.url)) uploaded.push(up);
        out += `![${alt}](${up.url})`;
      } else {
        out += `*(missing image: ${target})*`;
      }
    } else {
      out += m[0];
    }
    lastIdx = m.index! + m[0].length;
  }
  out += md.slice(lastIdx);

  // 2. Standard markdown images. Skip absolute URLs.
  const stdRe = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let out2 = "";
  lastIdx = 0;
  for (const m of out.matchAll(stdRe)) {
    out2 += out.slice(lastIdx, m.index);
    const alt = m[1];
    const src = m[2];
    if (/^https?:\/\//i.test(src)) {
      out2 += m[0];
    } else {
      const abs = resolveImage(vaultBase, src);
      if (abs && fs.existsSync(abs)) {
        const up = cache.get(abs) || (await uploadImage(token, abs));
        cache.set(abs, up);
        if (!uploaded.some((u) => u.url === up.url)) uploaded.push(up);
        out2 += `![${alt}](${up.url})`;
      } else {
        out2 += `*(missing image: ${src})*`;
      }
    }
    lastIdx = m.index! + m[0].length;
  }
  out2 += out.slice(lastIdx);

  return { md: out2, uploaded };
}

function isImage(s: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(s);
}

function resolveImage(vaultBase: string, ref: string): string | null {
  // Strip leading ./
  let r = ref.replace(/^\.\//, "");
  // Absolute on disk? rare in vault, but allow it.
  if (path.isAbsolute(r)) return r;
  // Try direct join first.
  const direct = path.resolve(vaultBase, r);
  if (fs.existsSync(direct)) return direct;
  // Fall back to basename search under common attachment paths.
  for (const sub of ["resource/image", "image", "attachments"]) {
    const cand = path.resolve(vaultBase, sub, path.basename(r));
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/** Strip the YAML front-matter block (gobog convention). */
function stripFrontMatter(s: string): string {
  if (!s.startsWith("---")) return s;
  const i = s.indexOf("\n---", 3);
  if (i < 0) return s;
  return s.slice(i + 4).replace(/^\n+/, "");
}

/** Pull the first paragraph as a fallback digest (capped at 120 chars). */
function pickDigest(md: string): string {
  for (const line of md.split("\n")) {
    const t = line
      .replace(/^#+\s*/, "")
      .replace(/^[*\->+\s]+/, "")
      .trim();
    if (t && !t.startsWith("```")) {
      return t.length > 120 ? t.slice(0, 117) + "…" : t;
    }
  }
  return "";
}

/**
 * Style the rendered HTML so it survives WeChat's editor. WeChat strips
 * `<style>` blocks at submit time, so everything needs to be inline.
 * We post-process the goldmark-style output with regexes; keeps the
 * plugin bundle small (no DOM parser dependency).
 */
function inlineStyles(html: string): string {
  return html
    .replace(/<h1\b/g, '<h1 style="font-size:24px;margin:24px 0 12px;color:#222"')
    .replace(/<h2\b/g, '<h2 style="font-size:20px;margin:24px 0 10px;color:#222;border-bottom:1px solid #eee;padding-bottom:4px"')
    .replace(/<h3\b/g, '<h3 style="font-size:17px;margin:20px 0 8px;color:#333"')
    .replace(/<h4\b/g, '<h4 style="font-size:15px;margin:18px 0 6px;color:#333"')
    .replace(/<p\b/g,  '<p style="margin:14px 0;line-height:1.8;color:#333;font-size:16px"')
    .replace(/<li\b/g, '<li style="margin:6px 0;line-height:1.8;color:#333"')
    .replace(/<blockquote\b/g, '<blockquote style="border-left:3px solid #1a73e8;background:#f4f8fc;padding:8px 14px;margin:14px 0;color:#555"')
    .replace(/<pre\b/g, '<pre style="background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;line-height:1.6"')
    .replace(/<code\b(?![^>]*style)/g, '<code style="background:#f0f0f0;padding:1px 6px;border-radius:3px;font-size:13px"')
    .replace(/<table\b/g, '<table style="border-collapse:collapse;margin:14px auto"')
    .replace(/<th\b/g, '<th style="border:1px solid #ddd;padding:6px 10px;background:#fafafa"')
    .replace(/<td\b/g, '<td style="border:1px solid #ddd;padding:6px 10px"')
    .replace(/<img\b/g, '<img style="max-width:100%;display:block;margin:14px auto"');
}

/**
 * Top-level entrypoint. Resolves access_token, uploads images, renders
 * HTML, submits as draft, returns the media_id.
 */
export async function pushToWeChat(
  input: ArticleInput,
  opts: WeChatOpts,
): Promise<DraftResult> {
  if (!opts.appId || !opts.appSecret) {
    throw new Error("AppID / AppSecret missing — set them in Settings → Gobog Sync → WeChat.");
  }
  const token = await getAccessToken(opts.appId, opts.appSecret);

  // Strip front matter; the title we already have from caller.
  const bodyMd = stripFrontMatter(input.markdown);

  // Rewrite images and capture the uploaded list.
  const { md: rewrittenMd, uploaded } = await rewriteImages(token, bodyMd, opts.vaultBase);

  // Render markdown → HTML, then inline styles.
  const html = inlineStyles(await marked.parse(rewrittenMd, { async: true }));

  // Pick a cover thumb. Order: configured default → first uploaded image.
  let thumbMediaId = opts.defaultThumbMediaId;
  if (!thumbMediaId && uploaded.length > 0) {
    thumbMediaId = uploaded[0].mediaId;
  }
  if (!thumbMediaId) {
    throw new Error(
      "WeChat draft needs a cover image. Either set a default thumb_media_id " +
        "in plugin settings, or embed at least one local image in the article.",
    );
  }

  // Digest = configured extractor → first paragraph → empty (WeChat allows it).
  const digest = (opts.digestExtractor || pickDigest)(bodyMd);

  const draftBody = {
    articles: [
      {
        title: input.title.slice(0, 64),
        author: input.author || opts.author,
        digest: digest.slice(0, 120),
        content: html,
        content_source_url: input.canonicalUrl || "",
        thumb_media_id: thumbMediaId,
        need_open_comment: 1,
        only_fans_can_comment: 0,
      },
    ],
  };
  const res = await fetch(
    `${WECHAT_BASE}/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draftBody),
    },
  );
  const j: any = await res.json();
  if (j.errcode) {
    throw new Error(`wechat draft error ${j.errcode}: ${j.errmsg}`);
  }
  return { mediaId: j.media_id as string };
}

/** Reset the in-memory token cache. Useful when AppID/Secret changes. */
export function resetTokenCache(): void {
  tokenCache = null;
}
