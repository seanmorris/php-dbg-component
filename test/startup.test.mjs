import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';

// Exercise the user's exact startup path without a php-wasm checkout or cache.
test('npm start bootstraps pinned runtime assets in a fresh checkout and rejects bad downloads',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'php-debugger-start-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of ['scripts','test','fixture/runtime'])await fs.mkdir(path.join(root,dir),{recursive:true});
  await fs.cp('src',path.join(root,'src'),{recursive:true});
  await fs.symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'dir');
  await fs.copyFile('test/server.mjs',path.join(root,'test/server.mjs'));
  await fs.copyFile('scripts/download-runtime.mjs',path.join(root,'scripts/download-runtime.mjs'));
  await fs.writeFile(path.join(root,'fixture/build.json'),JSON.stringify({commit:'fixture',bridgeVersion:1}));
  const manifest={schemaVersion:1,bridgeVersion:1,version:'8.4',wasm:'fixture.wasm'};
  await fs.writeFile(path.join(root,'fixture/runtime/php8.4-dbg-worker.mjs.assets.json'),JSON.stringify(manifest));
  execFileSync('tar',['-czf',path.join(root,'fixture.tar.gz'),'-C',path.join(root,'fixture'),'.']);
  let bytes=await fs.readFile(path.join(root,'fixture.tar.gz'));
  const assets=http.createServer((req,res)=>res.end(bytes));assets.listen(0,'127.0.0.1');await once(assets,'listening');
  t.after(()=>assets.close());
  await fs.writeFile(path.join(root,'runtime-lock.json'),JSON.stringify({url:`http://127.0.0.1:${assets.address().port}/runtime.tar.gz`,sha256:createHash('sha256').update(bytes).digest('hex'),sourceCommit:'fixture'}));
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const env={...process.env,PORT:String(port)};delete env.PHP_WASM_ROOT;delete env.RUNTIME_BUNDLE;
  async function start() {
    const child=spawn(process.execPath,['test/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    t.after(()=>child.kill());let output='';
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Startup timed out: '+output));},15000);
      child.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${output}`));});
      child.stderr.on('data',chunk=>output+=chunk);
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('Debugger examples:')){clearTimeout(timer);resolve();}});
    });
    return {child,output};
  }
  const {child,output}=await start();
  const response=await fetch(`http://127.0.0.1:${port}/runtime/php8.4-dbg-worker.mjs.assets.json`);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),manifest);
  assert.match(output,/Verified runtime bundle/);
  const stopped=once(child,'exit');child.kill();await stopped;
  // A corrupted response must never replace the previously verified installation.
  bytes=Buffer.from('corrupted archive');
  const retry=spawn(process.execPath,['scripts/download-runtime.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let error='';retry.stderr.on('data',chunk=>error+=chunk);const [exitCode]=await once(retry,'exit');
  assert.notEqual(exitCode,0);assert.match(error,/checksum mismatch/);
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'runtime-bundle/build.json'))).commit,'fixture');
  // A compatible installed php-dbg-wasm package needs neither lockfile nor download.
  await fs.unlink(path.join(root,'node_modules'));await fs.mkdir(path.join(root,'node_modules'));
  for(const name of await fs.readdir('node_modules'))if(name!=='php-dbg-wasm')await fs.symlink(path.resolve('node_modules',name),path.join(root,'node_modules',name));
  const installed=path.join(root,'node_modules/php-dbg-wasm');await fs.cp(path.join(root,'fixture/runtime'),installed,{recursive:true});
  await fs.writeFile(path.join(installed,'package.json'),JSON.stringify({name:'php-dbg-wasm',version:'0.2.0'}));
  await fs.rm(path.join(root,'runtime-lock.json'));await fs.rm(path.join(root,'runtime-bundle'),{recursive:true});
  const fromPackage=await start();
  const packaged=await fetch(`http://127.0.0.1:${port}/runtime/php8.4-dbg-worker.mjs.assets.json`);
  assert.equal(packaged.status,200);assert.deepEqual(await packaged.json(),manifest);
  assert.doesNotMatch(fromPackage.output,/Downloading|downloading|Verified runtime bundle/);
  const ended=once(fromPackage.child,'exit');fromPackage.child.kill();await ended;

});
