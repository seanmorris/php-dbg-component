---
title: "Host runtime files"
description: "What to serve, where it comes from, and how the files stay together."
menus:
  docs:
    weight: 40
---

# Host runtime files

The runtime is `php-dbg-wasm` with its debugger bridge. Serve the whole runtime directory as it is: the wrapper modules, the `.mjs` loaders, the `.wasm` binaries, the `.assets.json` manifests and any `.data` files. The manifests name the binaries, their checksums and what they depend on, so the files must stay together.

```text
public/
  runtime/           from runtime-bundle/runtime/
  php-wasm-curl/     from runtime-bundle/php-wasm-curl/
  php-wasm-dom/      from runtime-bundle/php-wasm-dom/
  php-wasm-libxml/   from runtime-bundle/php-wasm-libxml/
```

A page at that root sets `runtimeBaseUrl: './runtime/'`. Add the directory of each extension you load, and of the extensions those need.

## Where the files come from

Until `php-dbg-wasm` publishes a release with the bridge, `npm run setup:runtime` in a clone of this repository downloads a preview build into `runtime-bundle/` and checks it against the checksum in `runtime-lock.json`.

To use your own build of php-wasm, start the example server with `PHP_WASM_ROOT=/path/to/php-wasm npm start`. The [README](https://github.com/seanmorris/php-dbg-component#runtime-assets-versions-and-extensions) has the build commands.

## What the server must do

- Send `.mjs` as JavaScript, `.wasm` as `application/wasm` and the manifests as JSON.
- Serve over HTTPS or from `localhost`. Checksums cannot be verified otherwise, and `file://` cannot start a worker.

## When it does not load

A 404 for `php8.4-dbg-worker.mjs.assets.json` means `runtimeBaseUrl` does not point at a directory holding that version's manifest. Check the path and the version.

`This php-dbg-wasm build lacks debugger bridge v1` means the files are from a build without the bridge. Use the preview runtime or a newer build.
