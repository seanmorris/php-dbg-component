import {test, expect} from '@playwright/test';

const setup = async page => {
  await page.goto('/test/harness.html');
  await page.waitForFunction(() => window.PhpDebugger);
};
const version = process.env.PHP_VERSION || '8.4';
const create = (page, options = {}) => page.evaluate(({options, version}) => {
  window.dbg = new window.PhpDebugger({runtimeBaseUrl: '/runtime/', version, ...options});
  window.dbg.mount(document.querySelector('#host'));
}, {options, version});

test('lazy loading, clean program output, expectations, shared downloads and isolation', async ({page}) => {
  await setup(page);
  await create(page, {code: '<?php echo "ok\\n"; fwrite(STDERR, "err");', expect: {stdout: 'ok\n', stderr: 'err', exitCode: 0}});
  expect(await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /\.wasm|\.so(?:$|\?)/.test(r.name)).length)).toBe(0);
  const results = await page.evaluate(async () => {
    const second = new window.PhpDebugger({...dbg.options, code: '<?php echo isset($foo) ? "leak" : "clean";', expect: {stdout: 'clean'}});
    const result = await Promise.all([dbg.run({mode: 'test'}), second.run({mode: 'test'})]);
    await second.destroy(); return result;
  });
  expect(results.map(r => r.test.status)).toEqual(['passed', 'passed']);
  await expect(page.locator('#host [data-test-status]')).toHaveAttribute('data-test-status', 'passed');
});

test('break, edit locals and nested values, step, caller frame and stale references', async ({page}) => {
  await setup(page);
  await create(page, {code: '<?php\nfunction outer() {\n $outer = 2;\n return inner();\n}\nfunction inner() {\n $n = 3;\n $a = ["x" => 4];\n $o = (object)["x" => 5];\n $n += 1;\n echo "$n:{$a["x"]}:{$o->x}";\n}\nouter();', breakpoints: [10]});
  const result = await page.evaluate(async () => {
    const done = dbg.run(); await dbg.whenPaused();
    const locals = await dbg.inspect('variables');
    const n = locals.find(v => v.name === 'n');
    await dbg.setVariable(n.reference, '9');
    await dbg.evaluate('$a["x"] = 20'); await dbg.evaluate('$o->x = 30');
    await dbg.selectFrame(1);
    const caller = await dbg.inspect('variables');
    await dbg.setVariable(caller.find(v => v.name === 'outer').reference, '77');
    const editedCaller = await dbg.evaluate('$outer');
    await dbg.selectFrame(0); await dbg.stepOver();
    let stale = false; try {await dbg.setVariable(n.reference, '1');} catch {stale = true;}
    await dbg.continue();
    return {result: await done, editedCaller, stale};
  });
  expect(result.result.stdout).toBe('10:20:30'); expect(result.stale).toBe(true);
  expect(result.editedCaller.value).toBe(77);
});

test('errors, nonzero exits and output without a trailing newline are distinct', async ({page}) => {
  await setup(page); await create(page);
  const results = await page.evaluate(async () => {
    const results = [];
    for(const code of ['<?php echo "[Script ended normally]";', '<?php exit(7);', '<?php throw new RuntimeException("bad");', '<?php invalid syntax here']) {
      dbg.setCode(code); results.push(await dbg.run({mode:'test'}));
    } return results;
  });
  expect(results[0].stdout).toBe('[Script ended normally]');
  expect(results[1].exitCode).toBe(7); expect(results[2].exitCode).not.toBe(0); expect(results[3].exitCode).not.toBe(0);
});

test('worker timeouts and cancellation settle, and the component can run again', async ({page}) => {
  await setup(page); await create(page, {code: '<?php while(true) {}'});
  const result = await page.evaluate(async () => {
    const timeout = await dbg.run({mode:'test', timeoutMs:300});
    const done = dbg.run(); await new Promise(resolve => setTimeout(resolve, 300)); await dbg.stop();
    const cancelled = await done; dbg.setCode('<?php echo "again";');
    return [timeout, cancelled, await dbg.run({mode:'test'})];
  });
  expect(result.map(r => r.status)).toEqual(['timed-out','cancelled','completed']);
  expect(result[2].stdout).toBe('again');
});

test('main-thread mode exposes the page DOM through vrzno', async ({page}) => {
  await setup(page); await create(page, {execution:'main', code:'<?php vrzno_eval("document.body.dataset.php = 42"); echo "dom";'});
  expect((await page.evaluate(() => dbg.run({mode:'test'}))).stdout).toBe('dom');
  await expect(page.locator('body')).toHaveAttribute('data-php','42');
});

test('worker pauses a running loop, edits it and resumes to completion',async({page})=>{
  await setup(page);await create(page,{code:'<?php\n$keep = true;\nwhile($keep) { $tick = ($tick ?? 0) + 1; }\necho "stopped";'});
  const result=await page.evaluate(async()=>{
    const running=new Promise(resolve=>dbg.addEventListener('statechange',function onState(e){if(e.detail.state==='running'){dbg.removeEventListener('statechange',onState);resolve();}}));
    const done=dbg.run();await running;await dbg.pause();await dbg.evaluate('$keep = false');await dbg.continue();return done;
  });
  expect(result.status).toBe('completed');expect(result.stdout).toBe('stopped');
});

test('inspection pagination, cycles, readonly edit failure and multiline expressions',async({page})=>{
  await setup(page);await create(page,{code:'<?php\nclass Box { public int $n = 2; }\n$o = new Box;\n$cycle = new stdClass; $cycle->self = $cycle;\n$a = range(1, 205);\necho $o->n;',breakpoints:[6]});
  const values=await page.evaluate(async()=>{
    const done=dbg.run();await dbg.whenPaused();const vars=await dbg.inspect();
    const array=vars.find(v=>v.name==='a');const chunk=await dbg.children(array.reference,{offset:100,limit:100});
    const cycle=await dbg.children(vars.find(v=>v.name==='cycle').reference);
    let rejected=false;try {await dbg.evaluate('$o->n = "invalid"');}catch {rejected=true;}
    const valid=await dbg.evaluate('(\n  6 * 7\n)');await dbg.continue();return {chunk,cycle,rejected,valid,result:await done};
  });
  expect(values.chunk.total).toBe(205);expect(values.chunk.values).toHaveLength(100);
  expect(values.cycle.values[0].circular).toBe(true);expect(values.rejected).toBe(true);expect(values.valid.value).toBe(42);expect(values.result.stdout).toBe('2');
});

test('shared binary download is fetched once despite disabled HTTP cache',async({page,request})=>{
  await setup(page);const before=await (await request.get('/__requests')).json();
  const results=await page.evaluate(async version=>{
    const components=Array.from({length:3},(_,i)=>new PhpDebugger({runtimeBaseUrl:'/runtime/',version,code:`<?php file_put_contents('/own.txt', '${i}'); echo file_get_contents('/own.txt');`}));
    const results=await Promise.all(components.map(d=>d.run({mode:'test'})));await Promise.all(components.map(d=>d.destroy()));return results;
  },version);
  expect(results.map(r=>r.stdout)).toEqual(['0','1','2']);
  const after=await (await request.get('/__requests')).json();const wasm=Object.keys(after).filter(k=>k.endsWith('.wasm') && (after[k]-(before[k]||0))>0);
  expect(wasm).toHaveLength(1);expect(after[wasm[0]]-(before[wasm[0]]||0)).toBe(1);
});

test('explicit extension selection loads just the requested package and retries failed manifests',async({page})=>{
  await setup(page);
  const requests=[];page.on('request',r=>requests.push(new URL(r.url()).pathname));let attempts=0;
  await page.route(`**/php${version}-dbg-worker.mjs.assets.json`,route=>++attempts===1?route.fulfill({status:503,body:'retry'}):route.continue());
  const results=await page.evaluate(async version=>{
    const d=new PhpDebugger({runtimeBaseUrl:'/runtime/',version,extensions:['curl'],code:'<?php echo extension_loaded("curl") ? "curl" : "missing";'});
    const first=await d.run({mode:'test'});const second=await d.run({mode:'test'});await d.destroy();return [first,second];
  },version);
  expect(results[0].status).toBe('error');expect(results[1].stdout).toBe('curl');
  const libraries=[...new Set(requests.filter(p=>p.endsWith('.so')))];expect(libraries).toEqual([`/php-wasm-curl/php${version}-curl.so`]);
});

test('cancel during loading and disconnect a custom element without leaving a run alive',async({page})=>{
  await setup(page);
  await page.route('**/*.assets.json',async route=>{await new Promise(r=>setTimeout(r,250));await route.continue();});
  const result=await page.evaluate(async()=>{
    const element=document.createElement('php-debugger');element.options={runtimeBaseUrl:'/runtime/',code:'<?php while(true) {}'};document.body.append(element);
    const controller=element.debugger;const done=element.run();element.remove();const result=await done;await new Promise(r=>setTimeout(r,400));return {result,state:controller.state};
  });
  expect(result.result.status).toBe('cancelled');expect(result.state).toBe('destroyed');
});

test('run joins an in-flight prepare and cancelled async source never starts a runtime',async({page})=>{
  await setup(page);
  const result=await page.evaluate(async version=>{
    const d=new PhpDebugger({runtimeBaseUrl:'/runtime/',version,code:'<?php echo "prepared";'});
    const prepared=d.prepare();const done=d.run({mode:'test'});await prepared;const result=await done;await d.destroy();
    let release;const loading=new PhpDebugger({runtimeBaseUrl:'/runtime/',version,code:()=>new Promise(r=>release=r)});
    const states=[];loading.addEventListener('statechange',e=>states.push(e.detail.state));const cancelled=loading.run();await loading.stop();release('<?php echo "late";');await new Promise(r=>setTimeout(r,300));await loading.destroy();
    return {result,cancelled:await cancelled,states};
  },version);
  expect(result.result.stdout).toBe('prepared');expect(result.cancelled.status).toBe('cancelled');expect(result.states).not.toContain('loading');
});

test('selected extension native dependencies are discovered without loading unrelated packages',async({page})=>{
  await setup(page);const requests=[];page.on('request',r=>requests.push(new URL(r.url()).pathname));
  const result=await page.evaluate(async version=>{
    const d=new PhpDebugger({runtimeBaseUrl:'/runtime/',version,extensions:['dom'],code:'<?php $doc=new DOMDocument(); $doc->loadXML("<root>yes</root>"); echo $doc->documentElement->textContent;'});
    const result=await d.run({mode:'test'});await d.destroy();return result;
  },version);
  expect(result.stdout).toBe('yes');expect(requests.filter(p=>p.endsWith('.so')).sort()).toEqual([`/php-wasm-dom/php${version}-dom.so`,'/php-wasm-libxml/libxml2.so'].sort());
});
