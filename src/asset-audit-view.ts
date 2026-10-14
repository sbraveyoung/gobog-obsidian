import { AssetAudit } from './asset-audit';
export function mountAssetAuditView(root: HTMLElement, audit: AssetAudit, exportReport: () => void, clean: (paths: string[]) => Promise<void>, close: () => void, preview: (path: string) => string | undefined): () => void {
    root.replaceChildren();
    root.classList.add('gobog-assets');
    const doc = root.ownerDocument;
    const selected = new Set<string>();
    let disposed = false, limit = 100;
    const el = (tag: string, parent: HTMLElement, text = '') => { const e = doc.createElement(tag); e.textContent = text; parent.append(e); return e; };
    el('h2', root, '图片引用扫描');
    const candidates = audit.images.filter(i => i.state === 'candidate');
    el('p', root, `${audit.images.length} 张图片 · 疑似未引用 ${candidates.length} 张 · ${audit.complete ? '扫描完成' : '扫描不完整，禁止清理'}`);
    el('p', root, '草稿、隐藏文章与其他笔记引用也会保留。清理会移到 .trash；Git 历史不会自动减少。');
    for (const error of audit.errors)
        el('p', root, error);
    const controls = el('div', root);
    const search = el('input', controls) as HTMLInputElement;
    search.type = 'search';
    search.placeholder = '搜索图片路径';
    search.setAttribute('aria-label', '搜索图片');
    const filter = el('select', controls) as HTMLSelectElement;
    for (const [value, label] of [['all', '全部状态'], ['candidate', '疑似未引用'], ['uncertain', '无法确认'], ['referenced', '被引用']]) {
        const option = el('option', filter, label) as HTMLOptionElement;
        option.value = value;
    }
    filter.value = 'all';
    const list = el('div', root);
    list.className = 'gobog-assets-list';
    const detail = el('section', root);
    const status = el('p', root);
    status.setAttribute('role', 'status');
    const footer = el('footer', root);
    const button = (parent: HTMLElement, action: string, text: string, fn: () => void) => { const b = el('button', parent, text) as HTMLButtonElement; b.type = 'button'; b.dataset.action = action; b.addEventListener('click', fn); return b; };
    button(footer, 'close', '关闭', close);
    button(footer, 'export', '导出清单', exportReport);
    const cleanButton = button(footer, 'clean', '清理选中项', () => {
        if (!audit.complete || !selected.size)
            return;
        const confirm = el('section', root);
        confirm.setAttribute('role', 'alertdialog');
        confirm.setAttribute('aria-label', '确认移入回收站');
        const bytes = audit.images.filter(i => selected.has(i.path)).reduce((n, i) => n + i.bytes, 0);
        el('p', confirm, `确认将 ${selected.size} 张图片（${(bytes / 1048576).toFixed(2)} MiB）移入库外侧 .trash？清理前会再次检查引用。`);
        button(confirm, 'cancel-clean', '取消', () => confirm.remove());
        const yes = button(confirm, 'confirm-clean', '确认移入回收站', () => { yes.disabled = true; cleanButton.disabled = true; void clean([...selected]).then(() => { if (!disposed)
            status.textContent = '清理已完成，可从 .trash 恢复；Push 前仍需审阅删除。'; selected.clear(); confirm.remove(); render(); }).catch(e => { if (!disposed)
            status.textContent = String(e); yes.disabled = false; update(); }); });
    });
    function update() { cleanButton.disabled = !audit.complete || !selected.size; cleanButton.textContent = `清理选中项（${selected.size}）`; }
    function render() {
        list.replaceChildren();
        const items = [...audit.images].filter(i => i.path.toLowerCase().includes(search.value.toLowerCase()) && ((filter.value || 'all') === 'all' || i.state === filter.value)).sort((a, b) => b.bytes - a.bytes);
        for (const i of items.slice(0, limit)) {
            const row = el('div', list);
            row.className = 'gobog-assets-row';
            const checkbox = el('input', row) as HTMLInputElement;
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(i.path);
            checkbox.disabled = !audit.complete || i.state !== 'candidate';
            checkbox.setAttribute('aria-label', '选择 ' + i.path);
            checkbox.addEventListener('change', () => { if (checkbox.checked)
                selected.add(i.path);
            else
                selected.delete(i.path); update(); });
            button(row, 'image', `${i.state === 'candidate' ? '疑似未引用' : i.state === 'referenced' ? '被引用' : '无法确认'} · ${(i.bytes / 1048576).toFixed(2)} MiB · ${i.path}`, () => {
                detail.replaceChildren();
                el('h3', detail, i.path);
                const url = preview(i.path);
                if (url) {
                    const img = el('img', detail) as HTMLImageElement;
                    img.src = url;
                    img.alt = i.path;
                    img.loading = 'lazy';
                }
                for (const r of i.references)
                    el('p', detail, `${r.source}（${r.evidence}）`);
                for (const reason of i.reasons)
                    el('p', detail, reason);
            });
        }
        if (items.length > limit)
            button(list, 'more', `继续显示（还有 ${items.length - limit} 张）`, () => { limit += 100; render(); });
        update();
    }
    search.addEventListener('input', () => { limit = 100; render(); });
    filter.addEventListener('change', () => { limit = 100; render(); });
    render();
    return () => { disposed = true; root.replaceChildren(); };
}
