import {PhpDebugger} from './assets/component/index.mjs';
const $=selector=>document.querySelector(selector);
const runtimeBaseUrl=new URL('./assets/runtime/',import.meta.url).href;
const code=`<?php
function total(array $cart) {
    $sum = 0;
    foreach ($cart as $item) {
        $sum += $item['price'] * $item['quantity'];
    }
    return $sum;
}
$cart = [['name' => 'Notebook', 'price' => 8, 'quantity' => 3]];
$total = total($cart);
echo "Cart total: $total\\n";`;
let dbg,adapter,editor,kind='textarea';
const versions=await fetch(new URL('./assets/versions.json',import.meta.url)).then(r=>{if(!r.ok)throw Error('Runtime assets have not been staged. Run npm run build:docs.');return r.json();}).catch(error=>{$('#asset-status').textContent=error.message;return [];});
const scripts=new Map();
function script(name){if(!scripts.has(name))scripts.set(name,new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=new URL('./assets/editors/'+name,import.meta.url);el.onload=resolve;el.onerror=()=>reject(Error('Editor failed to load'));document.head.append(el);}));return scripts.get(name);}
async function mount(reset=false){
  const savedCode=reset?code:await dbg?.readCode()||code;const version=dbg?.options.version|| (versions.includes('8.4')?'8.4':versions[0]);
  if(dbg)await dbg.destroy();adapter?.dispose();if(kind!=='codemirror5')editor?.destroy?.();adapter=null;editor=null;
  $('#editor-host').replaceChildren();$('#debugger-host').replaceChildren();kind=$('#editor-kind').value;
  if(kind==='ace'){
    await script('ace.js');editor=ace.edit(document.createElement('div'));$('#editor-host').append(editor.container);editor.setValue(savedCode,-1);editor.setOptions({fontSize:14,showPrintMargin:false});
    adapter=(await import('./assets/component/adapters/ace.mjs')).createAceAdapter(editor);
  }else if(kind==='codemirror5'){
    await script('codemirror5.js');if(!$('#cm5-style')){const link=document.createElement('link');link.id='cm5-style';link.rel='stylesheet';link.href=new URL('./assets/editors/codemirror5.css',import.meta.url);document.head.append(link);}
    editor=CodeMirror($('#editor-host'),{value:savedCode,lineNumbers:true});adapter=(await import('./assets/component/adapters/codemirror5.mjs')).createCodeMirror5Adapter(editor);
  }else if(kind==='codemirror6'){
    const {EditorState,EditorView,lineNumbers,createCodeMirror6Adapter}=await import('./assets/editors/codemirror6.mjs');editor=new EditorView({state:EditorState.create({doc:savedCode,extensions:[lineNumbers()]}),parent:$('#editor-host')});adapter=createCodeMirror6Adapter(editor);
  }
  dbg=new PhpDebugger({runtimeBaseUrl,version,versions,code:savedCode,source:adapter,breakpoints:[5]});dbg.mount($('#debugger-host'));window.phpDebuggerDemo=dbg;
  $('#asset-status').textContent=`Ready · PHP ${version} · WASM loads when you press Run.`;
  dbg.addEventListener('statechange',e=>{if(e.detail.state==='loading')$('#asset-status').textContent='Loading the selected runtime…';else if(e.detail.state==='paused')$('#asset-status').textContent=`Paused · ${dbg.location.file}:${dbg.location.line} · expand or edit a value below.`;else if(e.detail.state==='completed')$('#asset-status').textContent='Complete. Change the source or version and run again.';});
  dbg.addEventListener('complete',e=>{if(e.detail.status==='error')$('#asset-status').textContent=e.detail.diagnostics.map(d=>d.message).join('\n');});
}
async function change(reset=false){$('#editor-kind').disabled=true;$('#reset').disabled=true;try{await mount(reset);}catch(error){$('#asset-status').textContent=error.message;}finally{$('#editor-kind').disabled=false;$('#reset').disabled=false;}}
$('#editor-kind').addEventListener('change',()=>void change());$('#reset').addEventListener('click',()=>void change(true));$('#theme').addEventListener('change',event=>{document.documentElement.dataset.theme=event.target.value;});
async function runExample(button,output,options){button.disabled=true;output.textContent='Running…';const test=new PhpDebugger({runtimeBaseUrl,version:dbg?.options.version||'8.4',...options});try{const result=await test.run({mode:'test',timeoutMs:5000});output.dataset.status=result.test.status;output.textContent=`${result.test.status} · ${result.stdout.trim() || result.diagnostics.map(d=>d.message).join(' ')} · ${Math.round(result.durationMs)} ms`;}finally{await test.destroy();button.disabled=false;}}
$('#run-test').addEventListener('click',event=>void runExample(event.currentTarget,$('#test-result'),{code:'<?php echo 6 * 7, "\\n";',expect:{stdout:'42\n',exitCode:0}}));
$('#run-curl').addEventListener('click',event=>void runExample(event.currentTarget,$('#curl-result'),{extensions:['curl'],code:'<?php echo extension_loaded("curl") ? "curl ready" : "curl missing";',expect:{stdout:'curl ready',exitCode:0}}));
if(versions.length)await change(true);
