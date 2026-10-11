# Building and publishing the docs

`docs/` is the GitHub Pages root. All links and runtime paths are relative, so the site also works under `/php-dbg-component/` or a custom domain. No server-side PHP is needed.

1. Build matching php-wasm debugger worker and web artifacts (bridge v1) as described in the root README.
2. Run `npm ci` in this repository.
3. Run `PHP_WASM_ROOT=/path/to/php-wasm DOCS_PHP_VERSIONS=8.0,8.1,8.2,8.3,8.4,8.5 npm run build:docs`. Omit `DOCS_PHP_VERSIONS` to stage only 8.4.
4. Serve the repository over HTTP (`npm start`) and visit `/docs/index.html`, or serve `docs/` directly. Opening `file://` cannot load module workers.
5. Publish the built `docs/` directory with GitHub Pages using the included workflow, or any static host.

`docs/assets/` contains generated component/editor/runtime assets and is ignored by Git. The build copies only the selected versions and the curl extension used by the demo. Editor JS loads when selected; PHP downloads only on Run. Licenses accompany staged third-party files.

For CI, `RUNTIME_BUNDLE=/path/to/unpacked/bundle npm run build:docs` uses an existing verified bundle with `runtime/`, `php-wasm-curl/`, and `versions.json`. The Pages workflow downloads the pinned release bundle, verifies its SHA-256, validates the component, builds docs, runs browser tests, and deploys `docs/`. The bundle's metadata records the exact php-wasm source commit and build profile; it must be regenerated when the native bridge changes.

To regenerate a bundle locally, use `scripts/package-runtime.mjs` after building all selected versions. Upload the resulting archive as a GitHub release asset, and update `runtime-lock.json` with its URL, digest, and native source commit. Never point Pages at an unpinned `latest` runtime.
