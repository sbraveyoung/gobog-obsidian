import { isAlias, isMap, isScalar, parseDocument } from 'yaml';
export interface NoteParts {
    prefix: string;
    yaml: string;
    closing: string;
    body: string;
    newline: string;
}
export function splitNote(text: string): NoteParts {
    const start = /^(\uFEFF?---[ \t]*\r?\n)/.exec(text);
    if (!start)
        return { prefix: '', yaml: '', closing: '', body: text, newline: text.includes('\r\n') ? '\r\n' : '\n' };
    const rest = text.slice(start[0].length);
    const end = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
    if (!end)
        throw new Error('Front matter has no closing delimiter.');
    return { prefix: start[0], yaml: rest.slice(0, end.index), closing: end[0], body: rest.slice(end.index + end[0].length), newline: start[0].endsWith('\r\n') ? '\r\n' : '\n' };
}
function document(yaml: string) {
    const doc = parseDocument(yaml, { keepSourceTokens: true, uniqueKeys: true });
    if (doc.errors.length)
        throw new Error(`Invalid YAML: ${doc.errors[0].message}`);
    if (doc.contents && !isMap(doc.contents))
        throw new Error('Front matter must be a YAML mapping.');
    return doc;
}
export function readProperties(text: string): Record<string, unknown> {
    const p = splitNote(text);
    if (!p.prefix)
        return {};
    return document(p.yaml).toJS({ maxAliasCount: 50 }) || {};
}
export function articleBody(text: string): string { return splitNote(text).body; }
/** Edit selected CST value spans; leave all other source bytes alone. */
export function patchProperties(text: string, values: Record<string, unknown>): string {
    const p = splitNote(text), doc = document(p.yaml);
    const edits: Array<{
        start: number;
        end: number;
        value: string;
    }> = [];
    const additions: string[] = [];
    for (const [key, value] of Object.entries(values)) {
        if (!/^[a-zA-Z_][\w-]*$/.test(key))
            throw new Error(`Unsafe property key: ${key}`);
        if (value === undefined)
            continue;
        const pair = isMap(doc.contents) ? doc.contents.items.find(item => isScalar(item.key) && item.key.value === key) : undefined;
        const serialized = JSON.stringify(value);
        if (serialized === undefined)
            throw new Error(`Unsupported property value: ${key}`);
        if (pair?.value) {
            const node = pair.value;
            if ('anchor' in node && node.anchor || isAlias(node))
                throw new Error(`Cannot safely edit anchored/aliased property: ${key}`);
            const current = doc.get(key);
            if (JSON.stringify(current) === serialized)
                continue;
            if (!node.range)
                throw new Error(`Cannot locate property: ${key}`);
            const [start, end] = node.range;
            const old = p.yaml.slice(start, end);
            edits.push({ start, end, value: serialized + (old.endsWith('\n') ? p.newline : '') });
        }
        else
            additions.push(`${key}: ${serialized}${p.newline}`);
    }
    let yaml = p.yaml;
    for (const e of edits.sort((a, b) => b.start - a.start))
        yaml = yaml.slice(0, e.start) + e.value + yaml.slice(e.end);
    if (additions.length)
        yaml += (yaml && !yaml.endsWith('\n') ? p.newline : '') + additions.join('');
    const result = p.prefix ? p.prefix + yaml + p.closing + p.body : `---${p.newline}${yaml}---${p.newline}${p.body}`;
    readProperties(result);
    return result;
}
export function truthy(value: unknown): boolean {
    return ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
export interface PublicationState {
    public: boolean;
    reasons: string[];
}
export function publicationState(meta: Record<string, unknown>, policies: Array<{
    path: string;
    hidden: boolean;
}>): PublicationState {
    const reasons: string[] = [];
    if (truthy(meta.draft))
        reasons.push('draft: true（草稿）');
    if (meta.publish != null && String(meta.publish).trim() !== '' && !truthy(meta.publish))
        reasons.push('publish: false（未准备发表）');
    if (truthy(meta.hidden))
        reasons.push('hidden: true（文章隐藏）');
    if (truthy(meta.private))
        reasons.push('private: true（静态站点不导出）');
    for (const policy of policies)
        if (policy.hidden)
            reasons.push(`${policy.path}: hidden: true`);
    return { public: reasons.length === 0, reasons };
}
