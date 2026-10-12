class Plugin{};class FileSystemAdapter{constructor(root){this.root=root}getBasePath(){return this.root}}
class TFile{};class TAbstractFile{};class TFolder{};class Notice{};class Modal{};class PluginSettingTab{};class Setting{};
function parseYaml(s){const out={};for(const l of s.split('\n')){const m=/^([\w-]+):\s*(.*)$/.exec(l);if(m){try{out[m[1]]=JSON.parse(m[2])}catch{out[m[1]]=m[2]}}}return out}
module.exports={Plugin,FileSystemAdapter,TFile,TAbstractFile,TFolder,Notice,Modal,PluginSettingTab,Setting,parseYaml,requestUrl:async args=>{if(global.__gobogRequest)return global.__gobogRequest(args);throw new Error('unexpected API request')}};
