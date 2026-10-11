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
  async json(url) { return JSON.parse(new TextDecoder().decode(await this._bytes(url))); }
  async module(url, sha256) {
    const key = String(url) + ':' + (sha256 || '');
    if(!this.modules.has(key)) {
      const task = this._bytes(url).then(async bytes => {
        if(sha256) {
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

const supportPackages = {libxml2:'libxml',libz:'zlib',libzip:'libzip',libfreetype:'gd',libjpeg:'gd',libpng:'gd',libwebp:'gd',libiconv:'iconv',libonig:'mbstring',libssl:'openssl',libcrypto:'openssl',libsqlite3:'sqlite',libyaml:'yaml',libtidy:'tidy'};

export async function prepareAssets(options) {
  const registry = options.assetRegistry || sharedAssets();
  const base = new URL(options.runtimeBaseUrl || '/node_modules/php-dbg-wasm/', globalThis.location?.href || 'http://localhost/');
  const environment = options.execution === 'main' ? 'web' : 'worker';
  const manifestUrl = new URL(`php${options.version}-dbg-${environment}.mjs.assets.json`, base);
  const manifest = await registry.json(manifestUrl);
  if(manifest.schemaVersion !== 1 || manifest.bridgeVersion !== 1 || manifest.version !== options.version || manifest.environment !== environment)
    throw new Error('The runtime asset manifest is incompatible with this debugger. Build the matching php-dbg-wasm worker/web artifacts.');
  const modules = await Promise.all((options.extensions || []).map(async extension => {
    const url = typeof extension === 'string'
      ? options.extensionUrls?.[extension] || new URL(`../php-wasm-${extension}/${options.version}.mjs`, base).href
      : extension.module;
    if(!url) throw new TypeError('An extension needs a name or module URL');
    return (await import(/* webpackIgnore: true */ String(url))).default;
  }));
  const wrapper = {phpVersion: options.version};
  const libraries = modules.flatMap(module => module.getLibs?.(wrapper) || []);
  const files = modules.flatMap(module => module.getFiles?.(wrapper) || []);
  for(const name of manifest.libraries || []) {
    if(libraries.some(lib => lib.name === name)) continue;
    const stem = name.replace(/\.so$/, '');
    const pkg = supportPackages[stem] || (stem.startsWith('libicu') ? 'intl' : null);
    if(!pkg) throw new Error(`No asset location for required library ${name}`);
    libraries.push({name, url: new URL(`../php-wasm-${pkg}/${name}`, base).href, ini:false});
  }
  const assets = {base:base.href, environment, module:null, libraries:[], files:[], data:{}};
  await Promise.all([
    registry.module(new URL(manifest.wasm, base), manifest.sha256).then(module => {assets.module = module;}),
    ...libraries.map(async lib => {
      const url = await registry.objectUrl(lib.url);
      assets.libraries.push({name:lib.name || String(lib.url).split('/').pop(), url, ini:!!lib.ini});
    }),
    ...files.map(async file => {
      assets.files.push({path:file.path || `${file.parent}/${file.name}`, bytes:await registry.bytes(file.url)});
    }),
    ...(manifest.data || []).map(async name => {assets.data[name] = await registry.bytes(new URL(name, base));})
  ]);
  return assets;
}
