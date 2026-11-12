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
