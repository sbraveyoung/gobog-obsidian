import { App, TFile } from 'obsidian';
import { extractReferences, markdownCodeRanges } from './asset-references';
import { resolveReference } from './asset-audit';
import { patchProperties } from './article-properties';
import { gitBlobSha } from './content-hash';
import { MAX_MOBILE_BLOB } from './github-source';
import { isImage, within } from './vault-path';
import type { SourceFile } from './sync-types';
export interface AttachmentPlan {
    imported: SourceFile[];
    replacements: Record<string, {
        before: string;
        after: string;
    }>;
    external: Record<string, string>;
}
function relative(from: string, to: string): string { const a = from.split('/').slice(0, -1), b = to.split('/'); while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
} return [...a.map(() => '..'), ...b].join('/'); }
export async function planAttachments(app: App, blogFolder: string, notes: Array<{
    path: string;
    text: string;
}>): Promise<AttachmentPlan> {
    const files = app.vault.getFiles(), imported = new Map<string, SourceFile>(), replacements: Record<string, {
        before: string;
        after: string;
    }> = {}, external: Record<string, string> = {};
    for (const note of notes) {
        const code = markdownCodeRanges(note.text);
        const edits: Array<{
            start: number;
            end: number;
            value: string;
        }> = [], properties: Record<string, unknown> = {};
        for (const ref of extractReferences(note.path, note.text)) {
            if (ref.start !== undefined && code.some(([start, end]) => ref.start! >= start && ref.start! < end))
                continue;
            if (ref.kind === 'text' || /^(https?:|data:|mailto:|#)/i.test(ref.link) || !isImage(ref.link))
                continue;
            const resolved = resolveReference(app, note.path, ref.link, files, blogFolder);
            if (!resolved.paths.length)
                throw new Error(`${note.path}: 图片不存在或未下载：${ref.link}`);
            if (resolved.ambiguous)
                throw new Error(`${note.path}: 图片路径有歧义：${ref.link}`);
            const file = app.vault.getAbstractFileByPath(resolved.paths[0]);
            if (!(file instanceof TFile))
                throw new Error('附件不可读取');
            const bytes = new Uint8Array(await app.vault.readBinary(file));
            if (bytes.length > MAX_MOBILE_BLOB)
                throw new Error(file.path + ': 超过手机 20 MiB 附件限额');
            if (within(file.path, blogFolder))
                continue;
            const sha = await gitBlobSha(bytes), ext = file.extension.toLowerCase(), path = `resource/image/${sha}.${ext}`;
            external[file.path] = sha;
            const existing = app.vault.getAbstractFileByPath(blogFolder + '/' + path);
            if (existing instanceof TFile && await gitBlobSha(new Uint8Array(await app.vault.readBinary(existing))) !== sha)
                throw new Error('资源名称已被不同内容占用');
            imported.set(path, { path, sha, bytes });
            if (ref.kind === 'yaml') {
                const key = ref.evidence.replace(/^属性 /, '');
                if (key !== 'cover')
                    throw new Error('外部图片属性需明确路径后再发布：' + key);
                properties.cover = path;
            }
            else if (ref.start !== undefined && ref.end !== undefined) {
                const target = ref.kind === 'wiki' ? blogFolder + '/' + path : relative(note.path, blogFolder + '/' + path);
                edits.push({ start: ref.start, end: ref.end, value: ref.kind === 'wiki' ? target : target.split('/').map(encodeURIComponent).join('/') });
            }
            else
                throw new Error(`${note.path}: 不能安全改写外部附件引用，请先将图片放入 blog：${ref.link}`);
        }
        let after = note.text;
        for (const e of edits.sort((a, b) => b.start - a.start))
            after = after.slice(0, e.start) + e.value + after.slice(e.end);
        if (Object.keys(properties).length)
            after = patchProperties(after, properties);
        if (after !== note.text)
            replacements[note.path] = { before: note.text, after };
    }
    return { imported: [...imported.values()], replacements, external };
}
