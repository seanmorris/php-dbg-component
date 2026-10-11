import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Stage an explicit runtime/extension set; no unrelated native binaries. */
export async function stageRuntime(root, output, versions, extensions=['curl','dom']) {
  const source=path.join(root,'packages/php-dbg-wasm');const target=path.join(output,'runtime');await fs.mkdir(target,{recursive:true});
  for(const name of await fs.readdir(source)) if(name.endsWith('.mjs')&&!/^php8\./.test(name))await fs.copyFile(path.join(source,name),path.join(target,name));
  for(const name of ['LICENSE','LICENSE-GPL','NOTICE'])await fs.copyFile(path.join(root,name),path.join(target,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  await fs.copyFile(path.join(root,`third_party/php${versions[0]}-src/LICENSE`),path.join(target,'LICENSE-PHP'));
  for(const version of versions)for(const environment of ['worker','web']) {
    const loader=`php${version}-dbg-${environment}.mjs`;const manifest=JSON.parse(await fs.readFile(path.join(source,loader+'.assets.json'),'utf8'));
    if(manifest.bridgeVersion!==1)throw Error('Expected debugger bridge v1');
    const glue=await fs.readFile(path.join(source,loader),'utf8'),bytes=await fs.readFile(path.join(source,manifest.wasm));
    if(!glue.includes('dbgManagedShutdown'))throw Error(`Rebuild ${loader} with complete managed request shutdown`);
    if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw Error(`Stale binary manifest for ${loader}`);
    if(!glue.includes(manifest.wasm))throw Error(`Loader and manifest disagree: ${loader}`);
    const name=manifest.sha256+'.wasm';
    await fs.writeFile(path.join(target,name),bytes);
    await fs.writeFile(path.join(target,loader),glue.replaceAll(manifest.wasm,name));
    await fs.writeFile(path.join(target,loader+'.assets.json'),JSON.stringify({...manifest,wasm:name},null,2)+'\n');
    for(const data of manifest.data)await fs.copyFile(path.join(source,data),path.join(target,data));
    if(manifest.libraries.length)throw Error('The docs runtime bundle requires the dynamic build profile without linked support libraries');
  }
  for(const extension of extensions) {
    const packageRoot=path.join(root,'packages',extension==='yaml'?'libyaml':extension);const destination=path.join(output,`php-wasm-${extension}`);await fs.mkdir(destination,{recursive:true});
    for(const name of await fs.readdir(packageRoot))if(name.endsWith('.mjs')||/^LICENSE|^NOTICE/.test(name))await fs.copyFile(path.join(packageRoot,name),path.join(destination,name));
    for(const version of versions)await fs.copyFile(path.join(packageRoot,`php${version}-${extension}.so`),path.join(destination,`php${version}-${extension}.so`));
  }
  if(extensions.includes('dom'))await fs.cp(path.join(root,'packages/libxml'),path.join(output,'php-wasm-libxml'),{recursive:true,filter:filename=>!path.extname(filename)||/\.(mjs|so)$/.test(filename)||/LICENSE|NOTICE/.test(path.basename(filename))});
  await fs.writeFile(path.join(output,'versions.json'),JSON.stringify(versions)+'\n');
}
