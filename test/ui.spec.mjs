import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{await page.addInitScript(version=>{window.phpVersionUnderTest=version;},process.env.PHP_VERSION||'8.4');});

test('declarative autorun, CSS overrides, and generic element/variable sources',async({page})=>{
  await page.goto('/test/harness.html');await page.waitForFunction(()=>window.PhpDebugger);
  await page.addStyleTag({content:'.php-debugger { --php-debugger-bg: rgb(7, 8, 9); border-radius: 19px; } .php-debugger-button { font-family: serif; }'});
  const results=await page.evaluate(async()=>{
    const element=document.createElement('php-debugger');element.setAttribute('runtime-base-url','/runtime/');element.setAttribute('version',window.phpVersionUnderTest);element.setAttribute('autorun','');element.setAttribute('mode','test');element.code='<?php echo "auto";';element.expect={stdout:'auto'};
    const done=new Promise(resolve=>element.addEventListener('phpdbg-complete',event=>resolve(event.detail),{once:true}));document.body.append(element);
    const result=await done;
    const source=document.createElement('pre');source.textContent='<?php echo "pre";';document.body.append(source);
    const fromElement=new PhpDebugger({source,version:window.phpVersionUnderTest,runtimeBaseUrl:'/runtime/'});const second=await fromElement.run({mode:'test'});await fromElement.destroy();
    let code='<?php echo "first";';const fromVariable=new PhpDebugger({code:()=>code,version:window.phpVersionUnderTest,runtimeBaseUrl:'/runtime/'});code='<?php echo "second";';const third=await fromVariable.run({mode:'test'});await fromVariable.destroy();
    return [result,second,third];
  });
  expect(results[0].test.status).toBe('passed');expect(results.slice(1).map(r=>r.stdout)).toEqual(['pre','second']);
  await expect(page.locator('php-debugger .php-debugger')).toHaveCSS('background-color','rgb(7, 8, 9)');
  await expect(page.locator('php-debugger .php-debugger')).toHaveCSS('border-radius','19px');
});

for(const kind of ['ace','codemirror5','codemirror6'])test(`${kind}: existing editor, breakpoints, edits, highlighting and cleanup`,async({page})=>{
  await page.goto('/test/harness.html');await page.waitForFunction(()=>window.PhpDebugger);
  if(kind==='ace')await page.addScriptTag({url:'/node_modules/ace-builds/src-noconflict/ace.js'});
  if(kind==='codemirror5'){await page.addScriptTag({url:'/node_modules/codemirror/lib/codemirror.js'});await page.addStyleTag({url:'/node_modules/codemirror/lib/codemirror.css'});}
  const result=await page.evaluate(async kind=>{
    const host=document.createElement('div');host.style.height='200px';document.body.append(host);
    const code='<?php\n$n = 2;\n$n += 3;\necho $n;';let editor,adapter;
    if(kind==='ace'){editor=ace.edit(host);editor.setValue(code);adapter=(await import('/src/adapters/ace.mjs')).createAceAdapter(editor);}
    else if(kind==='codemirror5'){editor=CodeMirror(host,{value:code,lineNumbers:true});adapter=(await import('/src/adapters/codemirror5.mjs')).createCodeMirror5Adapter(editor);}
    else {const {EditorState,EditorView,lineNumbers,createCodeMirror6Adapter}=await import('/editors.mjs');editor=new EditorView({state:EditorState.create({doc:code,extensions:[lineNumbers()]}),parent:host});adapter=createCodeMirror6Adapter(editor);}
    const dbg=new PhpDebugger({source:adapter,version:window.phpVersionUnderTest,runtimeBaseUrl:'/runtime/',breakpoints:[3]});dbg.mount(document.querySelector('#host'));
    const done=dbg.run();await dbg.whenPaused();const values=await dbg.inspect('variables');await dbg.setVariable(values.find(v=>v.name==='n').reference,'10');await dbg.continue();const result=await done;
    await dbg.destroy();adapter.dispose();const text=adapter.getCode();if(kind!=='codemirror5')editor.destroy();return {result,text};
  },kind);
  expect(result.result.stdout).toBe('13');expect(result.text).toContain('$n = 2;');
});

test('GUI edits a live value and exposes symbols, globals, constants and frames',async({page})=>{
  await page.goto('/test/harness.html');await page.waitForFunction(()=>window.PhpDebugger);
  await page.evaluate(()=>{
    window.dbg=new PhpDebugger({version:window.phpVersionUnderTest,runtimeBaseUrl:'/runtime/',code:'<?php\nconst EXAMPLE = 7;\nclass Example {}\n$globalValue = 5;\nfunction example() {\n $n = 2;\n echo $n;\n}\nexample();',breakpoints:[7]});dbg.mount(document.querySelector('#host'));
  });
  await page.getByRole('button',{name:'Run',exact:true}).click();await expect(page.getByRole('status')).toHaveText('paused');
  await page.getByRole('button',{name:'Edit n',exact:true}).click();await page.getByRole('textbox',{name:'New PHP expression for n',exact:true}).fill('42');await page.getByRole('button',{name:'Apply',exact:true}).click();await expect(page.locator('.php-debugger-value-preview')).toContainText('42');
  await page.getByRole('button',{name:'globals',exact:true}).click();await expect(page.locator('.php-debugger-values')).toContainText('globalValue');
  await page.getByRole('button',{name:'constants',exact:true}).click();await expect(page.locator('.php-debugger-values')).toContainText('EXAMPLE');await expect(page.locator('.php-debugger-values').getByRole('button',{name:/^Edit /})).toHaveCount(0);
  await page.getByRole('button',{name:'functions',exact:true}).click();await expect(page.locator('.php-debugger-values')).toContainText('example');
  await page.getByRole('button',{name:'classes',exact:true}).click();await expect(page.locator('.php-debugger-values')).toContainText('Example');
  await page.getByRole('button',{name:'files',exact:true}).click();await expect(page.locator('.php-debugger-values')).toContainText('/main.php');
  await page.getByRole('button',{name:'frames',exact:true}).click();await expect(page.locator('.php-debugger-values')).toContainText('Frame 0');
  await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('status')).toHaveText('completed');expect(await page.evaluate(()=>dbg.result.stdout)).toBe('42');
});
