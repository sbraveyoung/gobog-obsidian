import { parseYaml } from "obsidian";

export interface PropertyChange { key: string; before: string; after: string }
export interface ReviewFile {
  path: string; oldPath?: string; status: string;
  additions: number; deletions: number; binary: boolean;
  kind: "article" | "folder" | "image" | "file";
  title: string; properties: PropertyChange[]; notices: string[];
  beforeBody?: string; afterBody?: string; contentSkipped?: boolean;
  metadataError?: boolean;
  beforeBodyLine?: number; afterBodyLine?: number;
}
export interface ReviewSnapshot { tree: string; head: string; files: ReviewFile[] }
export interface PatchLine { kind: "add" | "delete" | "context" | "note"; text: string; old?: number; next?: number }
export interface PatchHunk { heading: string; lines: PatchLine[] }

function splitNote(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
  if (!match) {
    if (/^\uFEFF?---\r?\n/.test(text)) throw new Error("未闭合的属性区块");
    return { meta: {}, body: text };
  }
  const meta = parseYaml(match[1]);
  if (meta != null && (typeof meta !== "object" || Array.isArray(meta))) throw new Error("属性必须是键值表");
  return { meta: meta || {}, body: text.slice(match[0].length) };
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
function display(value: unknown): string {
  if (value === undefined) return "（未设置）";
  if (Array.isArray(value)) return `[${value.map(display).join(", ")}]`;
  if (value !== null && typeof value === "object") return JSON.stringify(canonical(value));
  return String(value);
}
function truthy(value: unknown): boolean {
  return value === true || value === 1 || ["true","1","yes","on"].includes(String(value).trim().toLowerCase());
}
function visible(meta: Record<string, unknown>): boolean {
  return !truthy(meta.draft) && !(meta.publish != null && String(meta.publish).trim() !== "" && !truthy(meta.publish)) && !truthy(meta.hidden) && !truthy(meta.private);
}
function isPolicy(p: string): boolean { return p.split("/").pop() === "_folder.md"; }
function isArticle(p: string): boolean {
  return /\.md$/i.test(p) && (p.startsWith("post/") || /^pages\/[^/]+\.md$/i.test(p)) && !p.split("/").some(part=>part.startsWith(".")) && !isPolicy(p);
}

/** Interpret the staged versions, never read unsaved/unstaged working-tree content. */
export function describeReviewFile(file: ReviewFile, before: string | undefined, after: string | undefined): ReviewFile {
  file.kind = isPolicy(file.path) || !!file.oldPath && isPolicy(file.oldPath) ? "folder" : isArticle(file.path) || !!file.oldPath && isArticle(file.oldPath) ? "article" : /\.(png|jpe?g|webp|gif|svg|avif|ico|heic)$/i.test(file.path) ? "image" : "file";
  file.title = file.path.split("/").pop() || file.path;
  if (!/\.md$/i.test(file.path)) return file;
  if (file.binary) { file.notices.push("二进制 Markdown 无法读取属性，请检查文件格式。"); return file; }
  if (file.contentSkipped) { file.notices.push("文件过大，属性摘要未读取；请查看逐文件差异。"); return file; }
  try {
    const a = splitNote(before || ""), b = splitNote(after || "");
    file.beforeBody = a.body; file.afterBody = b.body;
    file.beforeBodyLine = ((before || "").slice(0,(before || "").length-a.body.length).match(/\n/g) || []).length+1;
    file.afterBodyLine = ((after || "").slice(0,(after || "").length-b.body.length).match(/\n/g) || []).length+1;
    const title = b.meta.title ?? a.meta.title;
    if (typeof title === "string" && title.trim()) file.title = title;
    const keys = [...new Set([...Object.keys(a.meta), ...Object.keys(b.meta)])];
    file.properties = keys.filter(k => JSON.stringify(canonical(a.meta[k])) !== JSON.stringify(canonical(b.meta[k]))).map(key => ({key, before: display(a.meta[key]), after: display(b.meta[key])}));
    if (file.kind !== "folder" && file.kind !== "article") return file;
    if (file.kind === "folder") {
      const oldHidden = isPolicy(file.oldPath || file.path) && file.status !== "A" && a.meta.hidden === true;
      const newHidden = isPolicy(file.path) && file.status !== "D" && b.meta.hidden === true;
      if (isPolicy(file.path) && file.status !== "D" && typeof b.meta.hidden !== "boolean") file.notices.push("目录开关无效：hidden 必须为 true 或 false，构建会失败。");
      else if (file.oldPath && isPolicy(file.oldPath) && isPolicy(file.path) && oldHidden && newHidden) file.notices.push("移动目录开关：解除原文件夹的隐藏，隐藏新文件夹及其子文件夹；其他规则仍生效。");
      else if (newHidden && !oldHidden) file.notices.push("隐藏整个文件夹及其子文件夹；下次成功部署后生效。");
      else if (oldHidden && !newHidden) file.notices.push("解除此文件夹的隐藏；父目录与文章自己的开关仍生效。");
    } else if (file.status === "D") file.notices.push("删除文章；若此前公开，下次成功部署后移除页面。");
    else if ((file.status === "A" || !visible(a.meta)) && visible(b.meta)) file.notices.push("准备发表；仍受父目录隐藏规则约束。");
    else if (file.status === "A") file.notices.push("新增未发表文章；本次同步不会公开此文章。");
    else if (visible(a.meta) && !visible(b.meta)) file.notices.push(truthy(b.meta.hidden) ? "单篇隐藏；下次成功部署后生效。" : truthy(b.meta.private) ? "改为私有；静态博客不再导出。" : "转为未发表；下次成功部署后移除页面。");
    else if (file.properties.some(p=>["draft","publish","hidden","private"].includes(p.key))) file.notices.push("发表开关已修改；仍受其他开关和父目录规则约束。");
  } catch {
    file.metadataError = true;
    file.notices.push("属性解析失败，请在完整差异中检查 YAML；无法判断发表状态。");
  }
  return file;
}

/** Unified hunk parser keeps original text and old/new line numbers. */
export function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = []; let h: PatchHunk | undefined; let old = 0, next = 0;
  for (const text of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match) { old=Number(match[1]);next=Number(match[2]);h={heading:text,lines:[]};hunks.push(h);continue; }
    if (!h) continue;
    const prefix=text[0];
    if (prefix === "+") h.lines.push({kind:"add",text:text.slice(1),next:next++});
    else if (prefix === "-") h.lines.push({kind:"delete",text:text.slice(1),old:old++});
    else if (prefix === " ") h.lines.push({kind:"context",text:text.slice(1),old:old++,next:next++});
    else if (prefix === "\\") h.lines.push({kind:"note",text});
  }
  return hunks;
}
