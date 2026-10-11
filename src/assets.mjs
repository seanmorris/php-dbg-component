const registryKey = Symbol.for('php-dbg-component.assets.v1');

/** Immutable, shared downloads. Callers receive copies, never the cached buffer. */
export class AssetRegistry {
  constructor({fetch: fetcher = (...args) => globalThis.fetch(...args)} = {}) {
    this.fetch = fetcher; this.downloads = new Map(); this.modules = new Map(); this.urls = new Map();
  }
  async _bytes(url) {
    const key = String(url);
    if(!this.downloads.has(key)) {
      const task = Promise.resolve().then(async () => {
        const response = await this.fetch(key);
        if(!response.ok) throw new Error(`Asset request failed (${response.status}): ${key}`);
        return response.arrayBuffer();
      });
      this.downloads.set(key, task);
      task.catch(() => { if(this.downloads.get(key) === task) this.downloads.delete(key); });
    }
    return this.downloads.get(key);
  }
  async bytes(url) { return (await this._bytes(url)).slice(0); }
  async json(url) {
    try {return JSON.parse(new TextDecoder().decode(await this._bytes(url)));}
    catch(error) {this.downloads.delete(String(url)); throw error;}
  }
  async module(url, sha256) {
    // Web and worker loaders may use different URLs for the identical binary.
    const key = sha256 ? `sha256:${sha256}` : String(url);
    if(!this.modules.has(key)) {
      const task = this._bytes(url).then(async bytes => {
        if(sha256) {
          if(!globalThis.crypto?.subtle)throw new Error('WASM integrity verification requires HTTPS or localhost.');
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
          if(digest !== sha256) {this.downloads.delete(String(url)); throw new Error(`WASM integrity mismatch: ${url}`);}
        }
        return WebAssembly.compile(bytes);
      });
      this.modules.set(key, task);
      task.catch(() => {if(this.modules.get(key) === task) this.modules.delete(key);});
    }
    return this.modules.get(key);
  }
  async objectUrl(url) {
    const key = String(url);
    if(!this.urls.has(key)) {
      const task = this._bytes(key).then(bytes => URL.createObjectURL(new Blob([bytes], {type:'application/octet-stream'})));
      this.urls.set(key, task);
      task.catch(() => {if(this.urls.get(key) === task) this.urls.delete(key);});
    }
    return this.urls.get(key);
  }
  /** Clear between sessions only; active runtimes may still use these URLs. */
  async clear() {
    const urls = [...this.urls.values()]; this.downloads.clear(); this.modules.clear(); this.urls.clear();
    for(const task of urls) {try {URL.revokeObjectURL(await task);} catch { /* failed downloads have no URL */ }}
  }
}

export function sharedAssets() { return globalThis[registryKey] ??= new AssetRegistry(); }

export async function prepareAssets(options) {
  const registry = options.assetRegistry || sharedAssets();
  const base = new URL(options.runtimeBaseUrl || '/node_modules/php-dbg-wasm/', globalThis.location?.href || 'http://localhost/');
  const sourceBase = globalThis.location?.href || base;
  const environment = options.execution === 'main' ? 'web' : 'worker';
  const manifestUrl = new URL(`php${options.version}-dbg-${environment}.mjs.assets.json`, base);
  const manifest = await registry.json(manifestUrl);
  if(manifest.schemaVersion !== 1 || manifest.bridgeVersion !== 1 || manifest.version !== options.version || manifest.environment !== environment)
    throw new Error('The runtime asset manifest is incompatible with this debugger. Build the matching php-dbg-wasm worker/web artifacts.');
  const [{resolveDependencies}, modules] = await Promise.all([
    import(/* webpackIgnore: true */ new URL('resolveDependencies.mjs', base).href),
    Promise.all((options.extensions || []).map(async extension => {
      const url = typeof extension === 'string'
        ? options.extensionUrls?.[extension] || new URL(`../php-wasm-${extension}/${['libxml','zlib'].includes(extension)?'index':options.version}.mjs`, base).href
        : extension.module;
      if(!url) throw new TypeError('An extension needs a name or module URL');
      const module = await import(/* webpackIgnore: true */ new URL(url, sourceBase).href);
      return module.default || module;
    }))
  ]);
  const wrapper = {phpVersion:options.version, phpArgs:{...options.runtimeArgs, version:options.version}};
  // Module namespaces and their hooks cannot be posted to a worker. Ask the
  // runtime's own resolver for plain definitions, then pass those through.
  const shared = resolveDependencies([...(options.runtimeArgs?.sharedLibs || []), ...(options.sharedLibs || []), ...modules], wrapper);
  const dynamic = resolveDependencies([...(options.runtimeArgs?.dynamicLibs || []), ...(options.dynamicLibs || [])], wrapper);
  const files = [...(options.runtimeArgs?.files || []), ...shared.files, ...dynamic.files];
  const urls = {...dynamic.urlLibs, ...shared.urlLibs};
  for(const name of [...(manifest.libraries || []), ...shared.libs, ...dynamic.libs]) {
    if(typeof name === 'string' && !(name in urls)) urls[name] = new URL(name, base).href;
  }
  const assets = {base:base.href, environment, module:null,
    sharedLibs:shared.libs, dynamicLibs:dynamic.libs, libraryUrls:{}, files:[], data:{}};
  await Promise.all([
    registry.module(new URL(manifest.wasm, base), manifest.sha256).then(module => {assets.module = module;}),
    ...Object.entries(urls).map(async ([name, url]) => {
      assets.libraryUrls[name] = await registry.objectUrl(new URL(options.libraryUrls?.[name] || url, sourceBase));
    }),
    ...files.map(async (file, index) => {
      assets.files[index] = {...file, url:await registry.objectUrl(new URL(file.url, sourceBase))};
    }),
    ...(manifest.data || []).map(async name => {assets.data[name] = await registry.bytes(new URL(name, base));})
  ]);
  return assets;
}
