import fs from 'node:fs/promises';
import path from 'node:path';

/** Stage an explicit runtime/extension set; no unrelated native binaries. */
export async function stageRuntime(root, output, versions, extensions=['curl']) {
  const source=path.join(root,'packages/php-dbg-wasm');const target=path.join(output,'runtime');await fs.mkdir(target,{recursive:true});
  for(const name of await fs.readdir(source)) if(name.endsWith('.mjs')&&!/^php8\./.test(name))await fs.copyFile(path.join(source,name),path.join(target,name));
  for(const name of ['LICENSE','LICENSE-GPL','NOTICE'])await fs.copyFile(path.join(root,name),path.join(target,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  for(const version of versions)for(const environment of ['worker','web']) {
    const loader=`php${version}-dbg-${environment}.mjs`;const manifest=JSON.parse(await fs.readFile(path.join(source,loader+'.assets.json'),'utf8'));
    if(manifest.bridgeVersion!==1)throw Error('Expected debugger bridge v1');
    for(const name of [loader,loader+'.assets.json',manifest.wasm,...manifest.data])await fs.copyFile(path.join(source,name),path.join(target,name));
    if(manifest.libraries.length)throw Error('The docs runtime bundle requires the dynamic build profile without linked support libraries');
  }
  for(const extension of extensions) {
    const packageRoot=path.join(root,'packages',extension==='yaml'?'libyaml':extension);const destination=path.join(output,`php-wasm-${extension}`);await fs.mkdir(destination,{recursive:true});
    for(const name of await fs.readdir(packageRoot))if(name.endsWith('.mjs')||/^LICENSE|^NOTICE/.test(name))await fs.copyFile(path.join(packageRoot,name),path.join(destination,name));
    // The demo selects curl only. Its browser implementation has no native support-library dependencies.
    for(const version of versions)await fs.copyFile(path.join(packageRoot,`php${version}-${extension}.so`),path.join(destination,`php${version}-${extension}.so`));
  }
  await fs.writeFile(path.join(output,'versions.json'),JSON.stringify(versions)+'\n');
}
