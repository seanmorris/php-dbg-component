import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createRequire} from 'node:module';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const require=createRequire(import.meta.url);
const installedPackage=name=>{try{return path.dirname(require.resolve(name+'/package.json'));}catch{return null;}};
const runtimeRoot=process.env.PHP_WASM_ROOT && path.resolve(process.env.PHP_WASM_ROOT);
const localBundle=path.join(root,'runtime-bundle');
const compatible=async directory=>{
  if(!directory)return false;
  try {const manifest=JSON.parse(await fs.readFile(path.join(directory,'php8.4-dbg-worker.mjs.assets.json')));return manifest.bridgeVersion===1;}
  catch{return false;}
};
let bundle=process.env.RUNTIME_BUNDLE ? path.resolve(process.env.RUNTIME_BUNDLE) : null;
let nativeDirectory=bundle?path.join(bundle,'runtime'):runtimeRoot?path.join(runtimeRoot,'packages/php-dbg-wasm'):installedPackage('php-dbg-wasm');
if(!await compatible(nativeDirectory)) {
  if(process.env.RUNTIME_BUNDLE || runtimeRoot)throw Error('Compatible php-dbg-wasm assets are missing from '+nativeDirectory+'. Build the debugger worker/web targets described in README.md.');
  bundle=localBundle;nativeDirectory=path.join(bundle,'runtime');
  if(!await compatible(nativeDirectory)) {
    console.log('No compatible installed php-dbg-wasm package; downloading the pinned demo build…');
    await import('../scripts/download-runtime.mjs');
  }
}
const counts=new Map();
await fs.mkdir(path.join(root,'.cache'),{recursive:true});
await build({stdin:{contents:`export {EditorState} from '@codemirror/state'; export {EditorView, lineNumbers} from '@codemirror/view'; export {createCodeMirror6Adapter} from './src/adapters/codemirror6.mjs';`,resolveDir:root},bundle:true,format:'esm',outfile:path.join(root,'.cache/editors.mjs')});
const types={'.mjs':'text/javascript','.js':'text/javascript','.json':'application/json','.html':'text/html','.css':'text/css','.wasm':'application/wasm','.so':'application/wasm'};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/__requests'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(Object.fromEntries(counts)));return;}
    let pathname=decodeURIComponent(url.pathname);let base=root;
    if(pathname.startsWith('/runtime/')){base=nativeDirectory;pathname=pathname.slice('/runtime'.length);}
    const extension=pathname.match(/^\/php-wasm-([a-z0-9-]+)\//);
    if(extension){base=bundle?path.join(bundle,`php-wasm-${extension[1]}`):runtimeRoot?path.join(runtimeRoot,'packages',extension[1]==='yaml'?'libyaml':extension[1]):installedPackage(`php-wasm-${extension[1]}`);
      if(!base)throw Error('Extension package is not installed');pathname=pathname.slice(extension[0].length-1);}
    if(pathname==='/')pathname='/examples/index.html';
    else if(pathname.endsWith('/'))pathname+='index.html';
    if(pathname==='/editors.mjs')pathname='/.cache/editors.mjs';
    if(pathname.split('/').some(part=>part==='..'||part==='.git'||part==='.env'))throw Error('Invalid path');
    const filename=path.resolve(base,'.'+pathname);
    if(!filename.startsWith(base+path.sep))throw Error('Invalid path');
    const bytes=await fs.readFile(filename);counts.set(url.pathname,(counts.get(url.pathname)||0)+1);
    res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');
    res.setHeader('Cache-Control','no-store');res.end(bytes);
  } catch {res.statusCode=404;res.end('Not found');}
});
server.listen(Number(process.env.PORT||9120),'127.0.0.1',()=>console.log('Debugger examples: http://127.0.0.1:'+(process.env.PORT||9120)));
