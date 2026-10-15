/** Standalone, mocked settings preview. No server, profile install or real OAuth requests. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const read = name => readFile(resolve(root, name), 'utf8')
const [react, dom, jsx, client] = await Promise.all([
  read('node_modules/react/umd/react.production.min.js'),
  read('node_modules/react-dom/umd/react-dom.production.min.js'),
  read('node_modules/react/cjs/react-jsx-runtime.production.min.js'),
  read('lib/client.cjs'),
])
const encode = value => JSON.stringify(value).replace(/</g, '\\u003c')
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grok settings · isolated preview</title>
<style>
:root { --dsw-alias-bg-base:#f4f5f6; --dsw-alias-bg-module-platform:#fff; --dsw-alias-bg-layer-1:#f7f8fa; --dsw-alias-border-l2:#dce0e5; --dsw-alias-label-primary:#181b20; --dsw-alias-label-secondary:#555b65; --dsw-alias-label-tertiary:#747b85; --dsw-alias-brand-primary:#1467d2; --dsw-alias-label-primary-foreground:#fff; --dsw-alias-state-success-primary:#1d8755; --dsw-alias-state-error-primary:#b92323; }
:root[data-theme=dark] { color-scheme:dark; --dsw-alias-bg-base:#141619; --dsw-alias-bg-module-platform:#202329; --dsw-alias-bg-layer-1:#2a2e35; --dsw-alias-border-l2:#414751; --dsw-alias-label-primary:#f2f3f5; --dsw-alias-label-secondary:#c0c5cd; --dsw-alias-label-tertiary:#989faa; --dsw-alias-brand-primary:#ebedf0; --dsw-alias-label-primary-foreground:#17191d; }
* { box-sizing:border-box } body { margin:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-family:system-ui,sans-serif; } #toolbar { padding:12px 20px; display:flex; gap:10px; flex-wrap:wrap } #app { height:calc(100vh - 58px); overflow:auto; padding:0 20px 20px } button,input,select { font:inherit } #toolbar button { padding:6px 10px }
</style><div id="toolbar"><strong>隔离设置预览 · 全部数据为模拟</strong><button id="theme">浅/深色</button><button id="lang">中/英文</button><button id="account">切换登录状态</button><button id="failure">额度失败/成功</button></div><main id="app"></main>
<script>
new Function(${encode(react)})(); new Function(${encode(dom)})();
const runtime={exports:{}};
new Function('require','module','exports','process',${encode(jsx)})(name=>{if(name==='react')return window.React;throw Error(name)},runtime,runtime.exports,{env:{NODE_ENV:'production'}});
const client={exports:{}};
new Function('require','module','exports',${encode(client)})(name=>{if(name==='react')return window.React;if(name==='react/jsx-runtime')return runtime.exports;throw Error(name)},client,client.exports);
const registrations=[],copies={}; let language='zh',signedIn=true,quotaError=false,generation=0; const options={backendSearch:false,nestedSearchTools:true,statefulResponses:false,imagineTool:false,editTool:false,videoTool:false,mediaRiskAcknowledged:false,videoModel:'grok-imagine-video-1.5',videoMaxBytes:104857600,searchModel:'grok-build-0.1',searchMaxResults:8,webSearchTimeoutMs:60000,xSearchTimeoutMs:120000}; let stored={}; let proxy='';
window.__previewRequests=[];
window.fetch=async (input,init={})=>{
 const path=typeof input==='string'?input:input.url; window.__previewRequests.push({path,method:init.method??'GET'}); if(init.signal?.aborted)throw init.signal.reason;
 let data;
 if(path.endsWith('/auth/status'))data=signedIn?{status:'signed-in',models:['grok-4.6'],available:['grok-4.6','grok-4.1'],selected:['grok-4.6'],catalogSource:'live'}:{status:'signed-out'};
 else if(path.endsWith('/auth/options')){if(init.method==='POST'){const patch=JSON.parse(init.body);for(const [key,value]of Object.entries(patch)){if(value===null)delete stored[key];else stored[key]=value;}}data={effective:{...options,...stored},stored};}
 else if(path.endsWith('/auth/proxy')){if(init.method==='POST')proxy=JSON.parse(init.body).proxyUrl??'';data={proxyUrl:proxy};}
 else if(path.endsWith('/quota'))data=quotaError?{state:'error',reason:'temporary'}:{state:'available',usedPercent:42,remainingPercent:58,period:'week',plan:'SuperGrok',prepaidBalanceUsd:0,checkedAt:'2026-10-13T06:00:00.000Z',resetAt:'2026-10-14T11:18:57.966Z'};
 else if(path.endsWith('/capabilities'))data={features:['video','voice','code','image-generation'].map(id=>({id,state:'unverified'})),videoEnabled:false,quota:{state:'unavailable',message:''}};
 else if(path.endsWith('/video/tasks'))data={tasks:[]};
 else if(path.endsWith('/auth/logout')){signedIn=false;data={status:'signed-out'};}
 else return new Response(JSON.stringify({error:'Preview blocks this action'}),{status:409});
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
};
const ctx={locale:{register(_ns,defs){Object.assign(copies,defs);return()=>{}},bind(){return key=>copies[language]?.[key]??key}},effect(setup,label){if(label==='dsh-grok-kit: settings copy')return setup()},slots:{inject(_name,setup){setup()},entries(){return[]},register(spec,component){registrations.push({spec,component});return()=>{}}},inject(){}};
client.exports.apply(ctx); const entry=registrations.find(x=>x.spec.name==='settings.section');const root=ReactDOM.createRoot(document.getElementById('app'));
function render(){root.render(React.createElement(entry.component,{...entry.spec.inject(),key:generation}))}
document.getElementById('theme').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'};
document.getElementById('lang').onclick=()=>{language=language==='zh'?'en':'zh';render()};
document.getElementById('account').onclick=()=>{signedIn=!signedIn;generation++;render()};
document.getElementById('failure').onclick=()=>{quotaError=!quotaError;generation++;render()};
render();
</script></html>`
const destination = resolve(root, 'dist/settings-preview.html')
await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(destination, html)
console.log('Standalone preview generated: dist/settings-preview.html (mock data only)')
