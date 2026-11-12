import {test} from 'node:test';
import assert from 'node:assert/strict';

test('asset requests coalesce, failed requests retry, consumers cannot detach shared bytes', async () => {
  const {AssetRegistry} = await import('../src/assets.mjs');
  let requests = 0;
  const registry = new AssetRegistry({fetch: async () => {
    requests++;
    if(requests === 1) throw Error('offline');
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(new Uint8Array([1, 2, 3]));
  }});
  await assert.rejects(registry.bytes('https://example.test/a.wasm'), /offline/);
  const [a, b] = await Promise.all([registry.bytes('https://example.test/a.wasm'), registry.bytes('https://example.test/a.wasm')]);
  assert.equal(requests, 2);
  structuredClone(a, {transfer: [a]});
  assert.equal(b.byteLength, 3);
  assert.equal((await registry.bytes('https://example.test/a.wasm')).byteLength, 3);
});

test('test expectations preserve whitespace, handle regex state, and never pass an aborted run', async () => {
  const {checkExpectations} = await import('../src/expectations.mjs');
  const result = {status: 'completed', stdout: 'ok\n', stderr: '', exitCode: 0, diagnostics: []};
  assert.equal((await checkExpectations(result, {stdout: 'ok\n'})).status, 'passed');
  assert.equal((await checkExpectations(result, {stdout: 'ok'})).status, 'failed');
  const expected = {stdout: /ok/g};
  assert.equal((await checkExpectations(result, expected)).status, 'passed');
  assert.equal((await checkExpectations(result, expected)).status, 'passed');
  assert.equal((await checkExpectations({...result, status: 'cancelled'}, expected)).status, 'failed');
  assert.equal((await checkExpectations({...result, exitCode: 7}, {exitCode: 7})).status, 'passed');
  assert.equal((await checkExpectations(result)).status, 'unchecked');
});

test('source paths and breakpoints have unambiguous command boundaries', async () => {
  const {normalizeBreakpoints, normalizePath} = await import('../src/model.mjs');
  assert.deepEqual(normalizeBreakpoints([3, 3, {file: '/other.php', line: 4, enabled: false}], '/main.php').map(b => [b.file,b.line,b.enabled]), [['/main.php',3,true],['/other.php',4,false]]);
  assert.throws(() => normalizeBreakpoints([0], '/main.php'));
  assert.throws(() => normalizePath('/foo\nrun'));
  assert.throws(() => normalizePath('/../php.ini'));
});

test('controller import and construction are DOM-free and do not load a runtime', async () => {
  const {PhpDebugger} = await import('../src/index.mjs');
  const dbg = new PhpDebugger({code: '<?php echo 1;'});
  assert.equal(dbg.state, 'idle');
  await dbg.destroy();
  assert.equal(dbg.state, 'destroyed');
});

test('verified identical binaries share compilation and downloads across loader URLs', async()=>{
  const {AssetRegistry}=await import('../src/assets.mjs');
  const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  let fetched=0;const registry=new AssetRegistry({fetch:async()=>{fetched++;return new Response(bytes);}});
  const [worker,main]=await Promise.all([registry.module('https://example.test/worker.wasm',hash),registry.module('https://example.test/web.wasm',hash)]);
  assert.equal(worker,main);assert.equal(fetched,1);
});

test('engine lists frames from the top, labels unset variables and classifies debugger output', async () => {
  const {DebugEngine} = await import('../src/engine.mjs');
  const events = []; const engine = new DebugEngine(event => events.push(event));
  // A runtime whose backtrace starts at the selected frame, as vrzno_dbg_dump_backtrace does.
  const stack = [10, 4, 13]; let selected = 0;
  engine.php = {
    async switchFrame(frame) {if(frame >= stack.length) return -1; const previous = selected; selected = frame; return previous;},
    async dumpBacktrace() {return stack.slice(selected).map((lineNo, frame) => ({filename:'/main.php', lineNo, frame}));},
  };
  engine.paused = true;
  await engine.selectFrame(1);
  const frames = await engine.inspect('frames');
  assert.deepEqual(frames.map(frame => [frame.frame, frame.lineNo, frame.selected]), [[0, 10, false], [1, 4, true], [2, 13, false]]);
  assert.equal(selected, 1, 'listing restores the selected frame');

  const unset = engine.describe('later', undefined, "${'later'}");
  assert.deepEqual([unset.type, unset.displayValue, unset.writable, unset.expandable], ['unset', 'unset', true, false]);

  const bytes = text => new TextEncoder().encode(text);
  events.length = 0;
  engine.output({type:0, bytes:bytes('Breakpoint #0 added'), evaluating:false});
  engine.output({type:3, bytes:bytes('Uncaught Exception'), evaluating:false});
  engine.output({type:1, bytes:bytes('42'), evaluating:true});
  engine.output({type:1, bytes:bytes('hello'), evaluating:false});
  assert.deepEqual(events.filter(event => event.type === 'output'), [
    {type:'output', channel:'debug', kind:'notice', text:'Breakpoint #0 added'},
    {type:'output', channel:'debug', kind:'error', text:'Uncaught Exception'},
    {type:'output', channel:'debug', kind:'evaluation', text:'42'},
    {type:'output', channel:'stdout', text:'hello'},
  ]);
});

test('downloads report progress and still deliver every byte', async () => {
  const {AssetRegistry} = await import('../src/assets.mjs');
  const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
  const body = () => new ReadableStream({start(controller) {for(const part of parts) controller.enqueue(part); controller.close();}});
  const sized = new AssetRegistry({fetch:async () => new Response(body(), {headers:{'content-length':'6'}})});
  const seen = []; const stop = sized.onProgress(progress => seen.push(progress));
  assert.deepEqual([...new Uint8Array(await sized.bytes('https://example.test/php.wasm'))], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(seen.at(-1), {url:'https://example.test/php.wasm', loaded:6, total:6});
  assert.ok(seen.every((progress, index) => !index || progress.loaded > seen[index - 1].loaded));
  stop(); await sized.bytes('https://example.test/other.wasm');
  assert.equal(seen.at(-1).url, 'https://example.test/php.wasm', 'a stopped listener hears nothing more');
  // A compressed transfer declares the compressed size, which is not the size of these bytes.
  const compressed = new AssetRegistry({fetch:async () => new Response(body(), {headers:{'content-length':'4', 'content-encoding':'gzip'}})});
  const totals = []; compressed.onProgress(progress => totals.push(progress.total));
  await compressed.bytes('https://example.test/php.wasm');
  assert.deepEqual([...new Set(totals)], [null]);
});

test('engine uses the runtime\'s own types, frame names and globals when it provides debugger API 2', async () => {
  const {DebugEngine} = await import('../src/engine.mjs');
  const engine = new DebugEngine(() => {}); engine.paused = true; engine.dbgApi = 2;
  const list = {0:'a', 1:'b'}, item = {label:'x', ratio:2};
  const scalar = value => ({type:typeof value === 'string' ? 'string' : Number.isInteger(value) ? 'int' : 'float', className:null, count:null, reference:false, value});
  const calls = [];
  engine.php = {
    async describeVars() {calls.push('vars'); return [
      {name:'count', type:'int', className:null, count:null, reference:false, value:3},
      {name:'ratio', type:'float', className:null, count:null, reference:false, value:3},
      {name:'later', type:'undefined', className:null, count:null, reference:false, value:undefined},
      {name:'list', type:'array', className:null, count:2, reference:false, value:list},
      {name:'item', type:'object', className:'App\\Item', count:null, reference:false, value:item}];},
    async describeGlobals(options) {calls.push(['globals', options]); return [{name:'config', type:'string', className:null, count:2, reference:false, value:'on'}];},
    async describeConstants() {return [{name:'LIMIT', type:'int', className:null, count:null, reference:false, value:9}];},
    async describeChild(parent, key) {return key === 'ratio' ? {...scalar(parent[key]), type:'float'} : scalar(parent[key]);},
    async dumpBacktrace() {calls.push('frames'); return [{filename:'/main.php', lineNo:7, frame:0, selected:true, functionName:'inner', className:''}];},
    async switchFrame() {throw new Error('an API 2 runtime lists frames without switching');},
  };
  const locals = await engine.inspect('variables');
  assert.deepEqual(locals.map(v => [v.name, v.type, v.displayValue, v.expandable]), [
    ['count', 'int', '3', false], ['ratio', 'float', '3.0', false], ['later', 'unset', 'unset', false],
    ['list', 'array', 'array(2)', true], ['item', 'object', 'App\\Item', true]]);
  assert.deepEqual([locals[4].className, locals[3].count], ['App\\Item', 2]);
  const globals = await engine.inspect('globals');
  assert.deepEqual([globals[0].name, globals[0].displayValue, globals[0].writable], ['config', '"on"', true]);
  assert.deepEqual(calls.find(call => call[0] === 'globals')[1], {user:true});
  assert.equal((await engine.inspect('constants'))[0].writable, false);
  const properties = await engine.children(locals[4].reference);
  assert.deepEqual(properties.values.map(v => [v.name, v.type, v.displayValue]), [['label', 'string', '"x"'], ['ratio', 'float', '2.0']]);
  assert.deepEqual((await engine.inspect('frames'))[0].functionName, 'inner');
});

test('two debuggers that load the identical binary from different URLs both see its progress', async () => {
  const {AssetRegistry, prepareAssets} = await import('../src/assets.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path'); const {pathToFileURL} = await import('node:url');
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'php-debugger-assets-'));
  try {
    // prepareAssets imports the runtime's dependency resolver from the runtime directory.
    const bases = ['worker-host', 'page-host'].map(name => {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'resolveDependencies.mjs'), 'export const resolveDependencies = () => ({files:[], libs:[], urlLibs:{}});\n');
      return pathToFileURL(path.join(root, name) + path.sep).href;
    });
    const fetched = [];
    const registry = new AssetRegistry({fetch:async url => {
      if(url.endsWith('.assets.json')) {
        const environment = url.includes('-dbg-worker.') ? 'worker' : 'web';
        return new Response(JSON.stringify({schemaVersion:1, bridgeVersion:1, version:'8.4', environment, wasm:'php.wasm', sha256}));
      }
      fetched.push(url);
      const body = new ReadableStream({async start(controller) {
        for(const part of [bytes.slice(0, 3), bytes.slice(3)]) {await new Promise(resolve => setTimeout(resolve, 5)); controller.enqueue(part);}
        controller.close();
      }});
      return new Response(body, {headers:{'content-length':String(bytes.length)}});
    }});
    const seen = [[], []];
    const [worker, page] = await Promise.all(bases.map((runtimeBaseUrl, index) => prepareAssets({
      version:'8.4', execution:index ? 'main' : 'worker', runtimeBaseUrl, assetRegistry:registry, onProgress:progress => seen[index].push(progress),
    })));
    assert.equal(worker.module, page.module);
    assert.equal(fetched.length, 1, 'the binary is downloaded once');
    for(const progress of seen) assert.deepEqual(progress.at(-1), {loaded:bytes.length, total:bytes.length});
    assert.equal(registry.moduleSource(new URL('php.wasm', bases[1]), sha256), fetched[0]);
  } finally {fs.rmSync(root, {recursive:true, force:true});}
});

test('an evaluated value keeps its PHP type when the runtime provides debugger API 2', async () => {
  const {DebugEngine} = await import('../src/engine.mjs');
  const evaluate = async (api, expression) => {
    const engine = new DebugEngine(() => {}); engine.paused = true; engine.dbgApi = api;
    const commands = [];
    // Stands in for PHP: a float of 3.0 reaches JavaScript as the number 3, alone or inside an array.
    engine.writeFile = () => {};
    engine.command = async line => {commands.push(line); engine.captured = {value:line.includes('capture([') ? {0:3} : 3};};
    engine.php = {
      async switchFrame() {return 0;},
      async describeValue(value) {return {type:Number.isInteger(value) ? 'int' : 'float', className:null, count:null, reference:false, value};},
      async describeChild(parent, key) {return {type:'float', className:null, count:null, reference:false, value:parent[key]};},
    };
    const value = await engine.evaluate(expression);
    return {value, command:commands[0], stored:engine.references.get(value.reference).value};
  };
  const typed = await evaluate(2, '3.0');
  assert.deepEqual([typed.value.type, typed.value.displayValue, typed.value.value, typed.stored], ['float', '3.0', 3, 3]);
  assert.match(typed.command, /capture\(\[eval\(.*\)\]\)$/);
  // An older runtime cannot describe values, so nothing is boxed and the type is JavaScript's.
  const plain = await evaluate(1, '3.0');
  assert.deepEqual([plain.value.type, plain.value.displayValue], ['number', '3']);
  assert.match(plain.command, /capture\(eval\(.*\)\)$/);
});
