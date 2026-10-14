class Plugin{};class FileSystemAdapter{constructor(root){this.root=root}getBasePath(){return this.root}}
class TFile{};class TAbstractFile{};class TFolder{};class Notice{};class Modal{};class PluginSettingTab{};class Setting{};
const {parse:parseYaml,stringify:stringifyYaml}=require('yaml');
module.exports={Platform:{isMobile:false,isDesktop:true},Plugin,FileSystemAdapter,TFile,TAbstractFile,TFolder,Notice,Modal,PluginSettingTab,Setting,parseYaml,stringifyYaml,requestUrl:async args=>{if(global.__gobogRequest)return global.__gobogRequest(args);throw new Error('unexpected API request')}};
