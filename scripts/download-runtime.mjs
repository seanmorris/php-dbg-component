import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const archive=path.join(root,'runtime-bundle.tar.gz'),output=path.join(root,'runtime-bundle');
const lock=JSON.parse(await fs.readFile(new URL('../runtime-lock.json',import.meta.url),'utf8'));
const response=await fetch(lock.url);if(!response.ok)throw Error(`Runtime download failed (${response.status})`);
const bytes=Buffer.from(await response.arrayBuffer());
if(createHash('sha256').update(bytes).digest('hex')!==lock.sha256)throw Error('Runtime bundle checksum mismatch');
await fs.writeFile(archive,bytes);await fs.mkdir(path.join(root,'.cache'),{recursive:true});
const staging=await fs.mkdtemp(path.join(root,'.cache/runtime-'));
try {
  execFileSync('tar',['-xzf',archive,'-C',staging]);
  const metadata=JSON.parse(await fs.readFile(path.join(staging,'build.json'),'utf8'));
  if(metadata.commit!==lock.sourceCommit || metadata.bridgeVersion!==1)throw Error('Runtime provenance mismatch');
  await fs.rm(output,{recursive:true,force:true});await fs.rename(staging,output);
  console.log('Verified runtime bundle from php-wasm '+metadata.commit);
} finally {await fs.rm(staging,{recursive:true,force:true});}
