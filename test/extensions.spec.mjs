import {test,expect} from '@playwright/test';

const version=process.env.PHP_VERSION||'8.4';
test.beforeEach(async({page})=>{
  await page.goto('/test/harness.html');await page.waitForFunction(()=>window.PhpDebugger);
});

for(const execution of ['worker','main'])test(`${execution}: sharedLibs accepts package modules, dependencies and preload files`,async({page})=>{
  const requests=[];page.on('request',request=>requests.push(new URL(request.url()).pathname));
  const results=await page.evaluate(async({version,execution})=>{
    const curl=await import('/php-wasm-curl/index.mjs');
    const dom=await import('/php-wasm-dom/index.mjs');
    const libxml=await import('/php-wasm-libxml/index.mjs');
    const fileUrl=URL.createObjectURL(new Blob(['preloaded']));
    const helper={getLibs:()=>[],getFiles:()=>[{url:fileUrl,path:'/preload/helper/data.txt'}]};
    try {
      return await Promise.all([1,2].map(async id=>{
        const d=new PhpDebugger({version,execution,runtimeBaseUrl:'/runtime/',sharedLibs:[curl,dom,libxml,helper],
          libraryUrls:{'unused.so':'/unused.so'},
          runtimeArgs:{files:[{parent:'/preload/',name:'manual.txt',url:fileUrl}]},
          code:`<?php $doc=new DOMDocument; $doc->loadXML('<root>yes</root>'); echo extension_loaded('curl') ? 'curl:' : 'missing:'; echo $doc->documentElement->textContent, ':', file_get_contents('/preload/helper/data.txt'), ':', file_get_contents('/preload/manual.txt'); file_put_contents('/preload/helper/data.txt', '${id}');`});
        try{return await d.run({mode:'test'});}finally{await d.destroy();}
      }));
    }finally{URL.revokeObjectURL(fileUrl);}
  },{version,execution});
  expect(results.map(result=>result.stdout)).toEqual(['curl:yes:preloaded:preloaded','curl:yes:preloaded:preloaded']);
  expect(results.every(result=>result.status==='completed'&&result.exitCode===0)).toBe(true);
  expect(requests.filter(path=>path.endsWith('.so')).sort()).toEqual([`/php-wasm-curl/php${version}-curl.so`,`/php-wasm-dom/php${version}-dom.so`,'/php-wasm-libxml/libxml2.so'].sort());
});

test('sharedLibs handles URL strings, URL objects, definitions and runtimeArgs modules',async({page})=>{
  const results=await page.evaluate(async version=>{
    const module=await import('/php-wasm-curl/index.mjs');
    const url=new URL(`/php-wasm-curl/php${version}-curl.so`,location.href);
    const inputs=[{sharedLibs:[url.href]},{sharedLibs:[url]},{sharedLibs:[[{name:`php${version}-curl.so`,url,ini:true}]]},
      {runtimeArgs:{sharedLibs:[module]}},{sharedLibs:[module.default]},
      {sharedLibs:[`php${version}-curl.so`],libraryUrls:{[`php${version}-curl.so`]:url}}];
    const results=[];
    for(const input of inputs){
      const d=new PhpDebugger({version,runtimeBaseUrl:'/runtime/',...input,code:'<?php echo extension_loaded("curl") ? "curl" : "missing";'});
      try{results.push(await d.run({mode:'test'}));}finally{await d.destroy();}
    }
    return results;
  },version);
  expect(results.map(result=>result.stdout)).toEqual(Array(6).fill('curl'));
});

for(const execution of ['worker','main'])test(`${execution}: ini false and dynamicLibs resolve assets without registering PHP extensions`,async({page})=>{
  const requests=[];page.on('request',request=>requests.push(new URL(request.url()).pathname));
  const results=await page.evaluate(async({version,execution})=>{
    const module=await import('/php-wasm-curl/index.mjs');
    const definition={url:new URL(`/php-wasm-curl/php${version}-curl.so`,location.href),ini:false};
    const results=[];
    for(const input of [{sharedLibs:[definition]},{dynamicLibs:[module]},{runtimeArgs:{dynamicLibs:[module]}}]){
      const d=new PhpDebugger({version,execution,runtimeBaseUrl:'/runtime/',...input,
        code:'<?php echo extension_loaded("curl") ? "unexpected" : "not registered";'});
      try{results.push(await d.run({mode:'test'}));}finally{await d.destroy();}
    }
    return results;
  },{version,execution});
  expect(results.map(result=>result.stdout)).toEqual(Array(3).fill('not registered'));
  expect(results.every(result=>result.exitCode===0)).toBe(true);
  expect(requests.filter(path=>path.endsWith('.so'))).toEqual([`/php-wasm-curl/php${version}-curl.so`]);
});

test('package modules select the active PHP version without downloading other binaries',async({page})=>{
  const requests=[];page.on('request',request=>requests.push(new URL(request.url()).pathname));
  const other=version==='8.4'?'8.0':'8.4';
  const first=await page.evaluate(async version=>{
    const curl=await import('/php-wasm-curl/index.mjs');
    window.extensionsDebugger=new PhpDebugger({version,runtimeBaseUrl:'/runtime/',sharedLibs:[curl],code:'<?php echo PHP_MAJOR_VERSION,".",PHP_MINOR_VERSION,extension_loaded("curl") ? ":curl" : ":missing";'});
    return extensionsDebugger.run({mode:'test'});
  },version);
  expect(first.stdout).toBe(`${version}:curl`);
  await page.evaluate(other=>extensionsDebugger.setVersion(other),other);
  expect(requests.filter(path=>path.endsWith('.so'))).toEqual([`/php-wasm-curl/php${version}-curl.so`]);
  const second=await page.evaluate(async()=>{try{return await extensionsDebugger.run({mode:'test'});}finally{await extensionsDebugger.destroy();}});
  expect(second.stdout).toBe(`${other}:curl`);
  expect(requests.filter(path=>path.endsWith('.so'))).toEqual([`/php-wasm-curl/php${version}-curl.so`,`/php-wasm-curl/php${other}-curl.so`]);
});
