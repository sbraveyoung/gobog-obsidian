import { parsePatch, ReviewFile, ReviewSnapshot, PatchLine } from "./review";

function element<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const el = parent.ownerDocument.createElement(tag); el.className=cls;el.textContent=text;parent.appendChild(el);return el;
}
const statusNames: Record<string,string>={A:"新增",M:"修改",D:"删除",R:"重命名",T:"类型变化",C:"复制"};
const kindNames={article:"文章",folder:"目录开关",image:"图片",file:"文件"};
const gateKeys=new Set(["draft","publish","hidden","private"]);

/** DOM-only view also used in browser verification; host owns Git and modal lifetime. */
export function mountReviewView(root: HTMLElement, review: ReviewSnapshot, message: string,
  loadPatch: (file: ReviewFile, fullContext: boolean)=>Promise<string>, cancel: ()=>void, confirm: ()=>void): ()=>void {
  root.replaceChildren();root.classList.add("gobog-review");let generation=0,disposed=false;
  const header=element(root,"header","gobog-review-header");
  element(header,"h2","","检查本次推送");
  const summary=element(header,"p","gobog-review-summary");
  const kinds=Object.entries(kindNames).map(([kind,label])=>[review.files.filter(f=>f.kind===kind).length,label] as const).filter(([n])=>n);
  summary.textContent=`${review.files.length} 个文件 · ${kinds.map(([n,label])=>`${n} ${label}`).join("，")} · 新增 ${review.files.filter(f=>f.status==="A").length} / 修改 ${review.files.filter(f=>!["A","D"].includes(f.status)).length} / 删除 ${review.files.filter(f=>f.status==="D").length}`;
  const commit=element(header,"details","gobog-review-commit");element(commit,"summary","","提交说明");element(commit,"pre","",message);
  const workspace=element(root,"div","gobog-review-workspace");
  const nav=element(workspace,"nav","gobog-review-files");nav.setAttribute("aria-label","待推送文件");
  const search=element(nav,"input","gobog-review-search");search.type="search";search.placeholder="搜索标题或路径";search.setAttribute("aria-label","搜索待推送文件");
  const list=element(nav,"div","gobog-review-file-list");
  const detail=element(workspace,"section","gobog-review-detail");detail.setAttribute("aria-label","文件改动");
  const footer=element(root,"footer","gobog-review-footer");element(footer,"span","gobog-review-footnote","提交并推送全部已暂存文件；网站部署随后进行。");
  const cancelBtn=element(footer,"button","","取消");cancelBtn.type="button";cancelBtn.addEventListener("click",cancel);
  const confirmBtn=element(footer,"button","mod-cta","提交并推送");confirmBtn.type="button";confirmBtn.addEventListener("click",confirm);
  const buttons=new Map<ReviewFile,HTMLButtonElement>();
  function select(file:ReviewFile) {
    for(const [f,b] of buttons){b.classList.toggle("is-active",f===file);b.setAttribute("aria-current",String(f===file));}
    detail.replaceChildren();detail.scrollTop=0;
    element(detail,"h3","gobog-review-title",file.title);
    element(detail,"p","gobog-review-path",file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
    element(detail,"p","gobog-review-type",`${statusNames[file.status] || file.status} · ${kindNames[file.kind]}${file.binary ? " · 二进制" : ` · +${file.additions} / −${file.deletions} 行`}`);
    for(const text of file.notices){const notice=element(detail,"div","gobog-review-notice",text);notice.setAttribute("role","note");}
    if(file.properties.length) {
      element(detail,"h4","","属性变化");
      const scroll=element(detail,"div","gobog-review-properties");const table=element(scroll,"table");
      const head=element(table,"thead");const tr=element(head,"tr");for(const label of ["属性","修改前","修改后"])element(tr,"th","",label).scope="col";
      const body=element(table,"tbody");
      for(const p of file.properties){const row=element(body,"tr",gateKeys.has(p.key)?"is-publication":"");element(row,"th","",p.key).scope="row";element(row,"td","gobog-review-old",p.before);element(row,"td","gobog-review-new",p.after);}
    }
    const canSplit=file.beforeBody!==undefined && file.afterBody!==undefined && !file.metadataError;
    const controls=element(detail,"div","gobog-review-controls");
    const heading=element(controls,"h4","",canSplit?"正文变化":"文件差异");
    const modeLabel=element(controls,"label","gobog-review-toggle");
    const mode=element(modeLabel,"input");mode.type="checkbox";mode.disabled=!canSplit;element(modeLabel,"span","","包含属性原文");
    const contextLabel=element(controls,"label","gobog-review-toggle");const context=element(contextLabel,"input");context.type="checkbox";element(contextLabel,"span","","展开全部上下文");
    const patchRoot=element(detail,"div","gobog-review-patch");
    let patches=new Map<boolean,Promise<string>>();
    async function renderPatch() {
      const token=++generation;patchRoot.replaceChildren();
      heading.textContent=canSplit && !mode.checked ? "正文变化" : "文件差异";
      if(file.binary){element(patchRoot,"p","gobog-review-empty","二进制附件无法显示文本差异。此文件仍会随本次推送同步。");context.disabled=true;return;}
      if(canSplit && !mode.checked && file.beforeBody===file.afterBody){element(patchRoot,"p","gobog-review-empty","正文未修改，仅属性或文件路径发生变化。");return;}
      const loading=element(patchRoot,"p","gobog-review-empty","正在读取此文件的差异…");
      try {
        const full=context.checked;if(!patches.has(full)) patches.set(full,loadPatch(file,full));
        const patch=await patches.get(full)!;
        if(disposed || token!==generation)return;
        loading.remove();
        const beforeStart=file.beforeBody===undefined ? 1 : countLinesPrefix(file,"before");
        const afterStart=file.afterBody===undefined ? 1 : countLinesPrefix(file,"after");
        let hunks=parsePatch(patch);
        if(canSplit && !mode.checked) hunks=hunks.map(h=>({...h,lines:h.lines.filter(l=>l.kind==="note" || l.old!==undefined && l.old>=beforeStart || l.next!==undefined && l.next>=afterStart)})).filter(h=>h.lines.some(l=>l.kind==="add" || l.kind==="delete"));
        if(!hunks.length){element(patchRoot,"p","gobog-review-empty","没有文本行变化（可能仅重命名、权限或文件类型改变）。");return;}
        for(const h of hunks) {
          const section=element(patchRoot,"section","gobog-review-hunk");element(section,"div","gobog-review-hunk-heading",h.heading);
          const lines=element(section,"div","gobog-review-lines");let shown=0;
          const more=element(section,"button","gobog-review-more");more.type="button";
          const append=()=>{
            const limit=Math.min(shown+400,h.lines.length);
            while(shown<limit){const i=shown++;drawLine(lines,h.lines[i],h.lines[i-1],h.lines[i+1]);}
            more.hidden=shown===h.lines.length;more.textContent=`继续显示（还有 ${h.lines.length-shown} 行）`;
          };
          more.addEventListener("click",append);append();
        }
      } catch {
        if(disposed || token!==generation)return;patchRoot.replaceChildren();element(patchRoot,"p","gobog-review-empty","读取差异失败，请取消后重试。");
      }
    }
    mode.addEventListener("change",()=>void renderPatch());context.addEventListener("change",()=>void renderPatch());void renderPatch();
  }
  for(const f of review.files) {
    const b=element(list,"button","gobog-review-file");b.type="button";buttons.set(f,b);
    const top=element(b,"span","gobog-review-file-top");element(top,"span",`gobog-review-status status-${f.status}`,statusNames[f.status]||f.status);element(top,"span","gobog-review-count",f.binary?"附件":`+${f.additions} −${f.deletions}`);
    element(b,"span","gobog-review-file-title",f.title);element(b,"span","gobog-review-file-path",f.path);
    if(f.notices.length)element(b,"span","gobog-review-file-notice",f.kind==="folder"?"目录开关变化":f.metadataError?"属性需要检查":"发表状态需关注");
    b.addEventListener("click",()=>select(f));
  }
  const noMatch=element(list,"p","gobog-review-empty","没有匹配的文件。");noMatch.hidden=true;
  search.addEventListener("input",()=>{const q=search.value.toLowerCase();let found=0;for(const[f,b]of buttons){b.hidden=!`${f.title}\n${f.path}`.toLowerCase().includes(q);if(!b.hidden)found++;}noMatch.hidden=found>0;});
  if(review.files.length)select(review.files[0]);
  else element(detail,"p","gobog-review-empty","没有待提交文件。");
  return ()=>{disposed=true;generation++;};
}
function countLinesPrefix(f:ReviewFile, side:"before"|"after"):number {
  return side==="before" ? f.beforeBodyLine || 1 : f.afterBodyLine || 1;
}
function drawLine(parent:HTMLElement,line:PatchLine,prev:PatchLine|undefined,next:PatchLine|undefined) {
  const row=element(parent,"div",`gobog-review-line line-${line.kind}`);
  const numbers=element(row,"span","gobog-review-line-numbers",`${line.old ?? ""}\t${line.next ?? ""}`);numbers.setAttribute("aria-hidden","true");
  element(row,"span","gobog-review-line-sign",line.kind==="add"?"+":line.kind==="delete"?"−":" ");
  const code=element(row,"code");
  const partner=line.kind==="delete" && next?.kind==="add" ? next : line.kind==="add" && prev?.kind==="delete" ? prev : undefined;
  if(!partner){code.textContent=line.text || " ";return;}
  let start=0,end=0;while(start<Math.min(line.text.length,partner.text.length) && line.text[start]===partner.text[start])start++;
  while(end<Math.min(line.text.length,partner.text.length)-start && line.text[line.text.length-end-1]===partner.text[partner.text.length-end-1])end++;
  code.appendChild(parent.ownerDocument.createTextNode(line.text.slice(0,start)));
  element(code,"mark","",line.text.slice(start,line.text.length-end));
  code.appendChild(parent.ownerDocument.createTextNode(end?line.text.slice(-end):""));
}
