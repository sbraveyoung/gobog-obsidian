import { readProperties, splitNote } from './article-properties';
import { imagePattern } from './vault-path';
export interface LinkReference {
    link: string;
    evidence: string;
    start?: number;
    end?: number;
    kind?: 'markdown' | 'wiki' | 'html' | 'yaml' | 'css' | 'canvas' | 'text';
}
/** Preserve lexical spans for exact attachment link edits; audit also keeps conservative textual evidence. */
export function extractReferences(source: string, text: string): LinkReference[] {
    const refs: LinkReference[] = [];
    const add = (link: string, evidence: string, start?: number, end?: number, kind?: LinkReference['kind']) => { if (link.trim())
        refs.push({ link: link.trim(), evidence, start, end, kind }); };
    const p = /\.md$/i.test(source) ? splitNote(text) : { prefix: '', yaml: '', body: text, closing: '' };
    const body = p.body, offset = p.prefix.length + p.yaml.length + p.closing.length;
    for (const m of body.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
        const link = m[1].split('|')[0];
        add(link, 'wiki', offset + m.index! + m[0].indexOf(m[1]), offset + m.index! + m[0].indexOf(m[1]) + link.length, 'wiki');
    }
    for (const m of body.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:[^\s()\\]|\\.|\([^\n]*?\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
        const raw = m[1], link = raw.startsWith('<') ? raw.slice(1, -1) : raw;
        const start = offset + m.index! + m[0].indexOf(raw) + (raw.startsWith('<') ? 1 : 0);
        add(link, 'Markdown', start, start + link.length, 'markdown');
    }
    for (const m of body.matchAll(/^\s*\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm)) {
        const raw = m[1], link = raw.startsWith('<') ? raw.slice(1, -1) : raw;
        const start = offset + m.index! + m[0].lastIndexOf(raw) + (raw.startsWith('<') ? 1 : 0);
        add(link, 'Markdown 引用定义', start, start + link.length, 'markdown');
    }
    for (const m of body.matchAll(/\b(?:src|href|poster|srcset)\s*=\s*(["'])(.*?)\1/gi)) {
        const value = m[2], srcset = /^srcset/i.test(m[0]);
        if (srcset) {
            for (const part of value.split(','))
                add(part.trim().split(/\s+/)[0], 'HTML srcset', undefined, undefined, 'html');
        }
        else {
            const start = offset + m.index! + m[0].indexOf(value);
            add(value, 'HTML', start, start + value.length, 'html');
        }
    }
    for (const m of body.matchAll(/\burl\(\s*["']?([^\)"']+)["']?\s*\)/gi))
        add(m[1].trim(), 'CSS url', undefined, undefined, 'css');
    if (/\.canvas$/i.test(source)) {
        const data = JSON.parse(text);
        for (const node of data.nodes || [])
            if (typeof node.file === 'string')
                add(node.file, 'Canvas 文件', undefined, undefined, 'canvas');
    }
    if (p.prefix) {
        const props = readProperties(text);
        const walk = (v: unknown, key: string) => { if (typeof v === 'string' && (imagePattern.test(v) || ['cover', 'image', 'banner', 'thumbnail', 'typora-root-url'].includes(key)))
            add(v, `属性 ${key}`, undefined, undefined, 'yaml');
        else if (Array.isArray(v))
            v.forEach(x => walk(x, key));
        else if (v && typeof v === 'object')
            Object.entries(v).forEach(([k, x]) => walk(x, k)); };
        walk(props, '');
    }
    // Unknown HTML/template/code constructs: an image name is retention evidence, never deletion evidence.
    for (const m of text.matchAll(/(?:[^\s"'<>`\[\](){}]+)\.(?:png|jpe?g|gif|svg|webp|avif|bmp|heic|ico|tiff?)(?:\?[^\s"'<>]*)?/gi))
        add(m[0], '文本中的资源路径', undefined, undefined, 'text');
    return refs;
}
/** Fenced and inline code are retention evidence in audits, but never attachment edits. */
export function markdownCodeRanges(text: string): Array<[
    number,
    number
]> {
    const ranges: Array<[
        number,
        number
    ]> = [];
    let offset = 0, fence: {
        char: string;
        length: number;
        start: number;
    } | undefined;
    for (const line of (text.match(/[^\n]*\n|[^\n]+$/g) || [])) {
        const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (match && match[1][0] === fence.char && match[1].length >= fence.length && line.slice(match[0].length).trim() === '') {
                ranges.push([fence.start, offset + line.length]);
                fence = undefined;
            }
        }
        else if (match)
            fence = { char: match[1][0], length: match[1].length, start: offset };
        else {
            let pos = 0;
            while (pos < line.length) {
                const start = line.indexOf('`', pos);
                if (start < 0)
                    break;
                let count = 1;
                while (line[start + count] === '`')
                    count++;
                const marker = '`'.repeat(count), end = line.indexOf(marker, start + count);
                if (end < 0)
                    break;
                ranges.push([offset + start, offset + end + count]);
                pos = end + count;
            }
        }
        offset += line.length;
    }
    if (fence)
        ranges.push([fence.start, text.length]);
    return ranges;
}
