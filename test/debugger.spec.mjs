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
