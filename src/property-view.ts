import { PublicationState, truthy } from './article-properties';
const labels: Record<string, string> = { title: '标题', author: '作者', description: '摘要', category: '分类', tags: '标签（每行一个）', cover: '封面路径', order: '章节顺序', pin: '置顶', ai: 'AI 标记（false / assisted / generated / edited / 模型名）', draft: '草稿', publish: '准备发表', hidden: '隐藏文章', private: '私有文章', id: '固定标识', url: '永久 URL', create_time: '创建时间', updated_time: '更新时间' };
export function mountPropertyView(root: HTMLElement, meta: Record<string, unknown>, state: PublicationState, save: (values: Record<string, unknown>) => Promise<void>, cancel: () => void): () => void {
    root.replaceChildren();
    root.classList.add('gobog-properties');
    const doc = root.ownerDocument;
    const add = (tag: string, parent = root, text = '') => { const e = doc.createElement(tag); e.textContent = text; parent.append(e); return e; };
    add('h2', root, '文章属性');
    add('p', root, state.public ? '已满足发表条件；成功部署后公开' : `当前不会公开：${state.reasons.join('；')}`);
    const form = add('div');
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const dirty = new Set<string>();
    let disposed = false;
    for (const key of Object.keys(labels)) {
        const label = add('label', form, labels[key]);
        const input = doc.createElement(key === 'tags' || key === 'description' ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
        input.dataset.field = key;
        if (['draft', 'publish', 'hidden', 'private', 'pin'].includes(key)) {
            (input as HTMLInputElement).type = 'checkbox';
            (input as HTMLInputElement).checked = truthy(meta[key]);
        }
        else {
            input.value = Array.isArray(meta[key]) ? (meta[key] as unknown[]).join('\n') : String(meta[key] ?? '');
            if (key === 'order')
                (input as HTMLInputElement).type = 'number';
        }
        if (['id', 'url', 'create_time', 'updated_time'].includes(key))
            input.readOnly = true;
        input.addEventListener('input', () => dirty.add(key));
        input.addEventListener('change', () => dirty.add(key));
        label.append(input);
        inputs.set(key, input);
    }
    const error = add('p');
    error.setAttribute('role', 'status');
    const footer = add('footer');
    const buttons: HTMLButtonElement[] = [];
    const button = (action: string, text: string, fn: () => void) => { const b = add('button', footer, text) as HTMLButtonElement; b.type = 'button'; b.dataset.action = action; b.addEventListener('click', fn); buttons.push(b); return b; };
    async function submit(overrides: Record<string, unknown> = {}) {
        const values: Record<string, unknown> = {};
        for (const key of dirty) {
            const input = inputs.get(key)!;
            if (['draft', 'publish', 'hidden', 'private', 'pin'].includes(key))
                values[key] = (input as HTMLInputElement).checked;
            else if (key === 'tags')
                values[key] = [...new Set(input.value.split(/[\n,]/).map(x => x.trim()).filter(Boolean))];
            else if (key === 'order') {
                if (input.value !== '' && !/^-?\d+$/.test(input.value)) {
                    error.textContent = '章节顺序必须是整数';
                    return;
                }
                values[key] = input.value === '' ? null : Number(input.value);
            }
            else if (key === 'ai')
                values[key] = input.value === 'false' || input.value === '' ? false : input.value === 'true' ? true : input.value;
            else
                values[key] = input.value;
        }
        Object.assign(values, overrides);
        buttons.forEach(b => b.disabled = true);
        try {
            await save(values);
            if (!disposed)
                error.textContent = '属性已保存';
        }
        catch (e) {
            if (!disposed)
                error.textContent = String(e);
        }
        finally {
            buttons.forEach(b => b.disabled = false);
        }
    }
    button('cancel', '取消', cancel);
    button('draft', '转为草稿', () => void submit({ draft: true, publish: false }));
    button('publish', '准备发表', () => void submit({ draft: false, publish: true }));
    button('save', '保存属性', () => void submit());
    return () => { disposed = true; root.replaceChildren(); };
}
