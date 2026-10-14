import { readProperties } from './article-properties';
export interface CheckIssue {
    path: string;
    field?: string;
    level: 'error' | 'warning';
    message: string;
}
export function isArticle(path: string): boolean { return !path.split('/').some(p => p.startsWith('.')) && path.split('/').pop() !== '_folder.md' && (/\.(md)$/i.test(path)) && (path.startsWith('post/') || /^pages\/[^/]+\.md$/i.test(path)); }
export function checkArticles(notes: Array<{
    path: string;
    text: string;
}>): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const ids = new Map<string, string>(), urls = new Map<string, string>();
    const add = (path: string, field: string, level: 'error' | 'warning', message: string) => issues.push({ path, field, level, message });
    for (const { path, text } of notes) {
        if (!isArticle(path) && path.split('/').pop() !== '_folder.md')
            continue;
        let m: Record<string, unknown>;
        try {
            m = readProperties(text);
        }
        catch (e) {
            add(path, 'YAML', 'error', String(e));
            continue;
        }
        if (path.split('/').pop() === '_folder.md') {
            if (typeof m.hidden !== 'boolean')
                add(path, 'hidden', 'error', '目录 hidden 必须为 true 或 false');
            continue;
        }
        for (const key of ['draft', 'publish', 'hidden', 'private', 'pin'])
            if (m[key] != null && typeof m[key] !== 'boolean')
                add(path, key, 'warning', '兼容历史开关，建议使用 true/false');
        for (const key of ['id', 'url']) {
            const value = String(m[key] ?? '').trim();
            if (!value) {
                add(path, key, 'warning', `缺少 ${key}，建议补全固定标识`);
                continue;
            }
            if (typeof m[key] !== 'string')
                add(path, key, 'warning', `${key} 建议使用字符串`);
            const map = key === 'id' ? ids : urls;
            let normalized = value;
            if (key === 'url') {
                let decoded: string;
                try {
                    decoded = decodeURIComponent(value);
                }
                catch {
                    add(path, key, 'error', 'URL 编码无效');
                    continue;
                }
                if (!value.startsWith('/') || value.startsWith('//') || /[\\?#\x00-\x20]/.test(decoded) || decoded.split('/').some(x => x === '.' || x === '..') || /^\/(resource|__themes)(\/|$)/i.test(decoded)) {
                    add(path, key, 'error', '永久 URL 必须为安全站点路径');
                    continue;
                }
                normalized = decoded.replace(/\/+$/, '') || '/';
            }
            if (map.has(normalized))
                add(path, key, 'error', `${key} 与 ${map.get(normalized)} 重复`);
            else
                map.set(normalized, path);
        }
        if (m.tags != null && (!Array.isArray(m.tags) || m.tags.some(x => typeof x !== 'string')))
            add(path, 'tags', 'warning', '标签建议使用字符串列表');
        if (m.order != null && m.order !== '' && !/^-?\d+$/.test(String(m.order)))
            add(path, 'order', 'error', '章节顺序必须为整数');
        for (const key of ['create_time', 'updated_time'])
            if (m[key] != null && m[key] !== '' && !Number.isFinite(Date.parse(String(m[key]).replace(' ', 'T'))))
                add(path, key, 'warning', '日期不能解析，建议修正后发表');
    }
    return issues;
}
