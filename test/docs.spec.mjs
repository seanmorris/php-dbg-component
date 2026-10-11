import {test,expect} from '@playwright/test';
import fs from 'node:fs';

test('homepage demo runs and links to the guide with editors, tests and curl',async({page})=>{
  test.skip(!fs.existsSync('docs/assets/versions.json'),'Build docs before running the published-site regression');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/docs/index.html');await page.waitForFunction(()=>window.phpDebuggerDemo);
  await page.getByRole('button',{name:'Run',exact:true}).click();
  await page.evaluate(async()=>{
    const dbg=window.phpDebuggerDemo;await dbg.whenPaused();
    const item=(await dbg.inspect('variables')).find(value=>value.name==='item');
    const price=(await dbg.children(item.reference)).values.find(value=>value.name==='price');
    await dbg.setVariable(price.reference,'10');
  });
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.phpDebuggerDemo.result?.stdout)).toBe('Cart total: 30\n');
  await page.getByRole('button',{name:'Run PHP assertion',exact:true}).click();await expect(page.locator('#test-result')).toHaveAttribute('data-status','passed');
  await page.getByRole('link',{name:'Quickstart',exact:true}).click();await page.waitForFunction(()=>window.phpDebuggerDemo);
  await expect(page.getByRole('heading',{level:1})).toHaveText('Quickstart and API');
  await page.getByRole('button',{name:'Run PHP assertion',exact:true}).click();await expect(page.locator('#test-result')).toHaveAttribute('data-status','passed');
  await page.selectOption('#theme','dark');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  for(const kind of ['ace','codemirror5','codemirror6','textarea']){
    await page.selectOption('#editor-kind',kind);await expect(page.locator('#editor-kind')).toBeEnabled();
    const result=await page.evaluate(async()=>{const dbg=window.phpDebuggerDemo;const done=dbg.run();await dbg.whenPaused();await dbg.setBreakpoints([]);await dbg.continue();return done;});
    expect(result.stdout).toBe('Cart total: 24\n');
  }
  await page.getByText('Loading extensions',{exact:true}).click();await page.locator('#run-curl').click();await expect(page.locator('#curl-result')).toHaveAttribute('data-status','passed');
  expect(errors).toEqual([]);
});
