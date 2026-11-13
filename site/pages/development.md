---
title: "Work on this repository"
description: "Clone, run the example server, run the tests and build this site."
menus:
  docs:
    weight: 90
---

# Work on this repository

```bash
git clone https://github.com/seanmorris/php-dbg-component.git
cd php-dbg-component
npm ci
npm start
```

Open <http://localhost:9120/>. Click **Run** to stop at line 3, then **Continue** to print `Result: 5`.

The server uses an installed `php-dbg-wasm` package if it has the debugger bridge. Otherwise it downloads the preview build recorded in [`runtime-lock.json`](https://github.com/seanmorris/php-dbg-component/blob/main/runtime-lock.json), which pins a build artifact, its checksum and its source commit.

## Tests

```bash
npm run lint
npm test
npm run test:types
npm run test:browser
```

The browser tests drive real PHP in Chromium, Firefox and WebKit. Install the browsers once with `npx playwright install`.

## This site

The site is an [SMGen](https://seanmorris.github.io/smgen/) project in `site/`: Markdown pages in `site/pages/`, three templates in `site/templates/` and one stylesheet in `site/static/`. Building it needs PHP 8.1 or newer with the YAML extension, and Pandoc.

```bash
npm run setup:runtime
RUNTIME_BUNDLE=./runtime-bundle npm run build:docs
npm start
```

Open <http://localhost:9120/docs/>.

`npm run build:docs` does three things:

1. Copies the component, the editors and the PHP runtimes the pages load into `site/static/assets/`.
2. Fetches SMGen at the commit in `site/smgen-lock.json` into `.cache/smgen/`, the first time.
3. Runs `smgen build` in `site/`, which writes `docs/`.

Both `docs/` and `site/static/assets/` are generated and not committed.

<div class="table-scroll">

| Variable            | Effect                                                                              |
|---------------------|-------------------------------------------------------------------------------------|
| `RUNTIME_BUNDLE`    | An unpacked runtime bundle to stage.                                                |
| `PHP_WASM_ROOT`     | Or a php-wasm checkout to stage from, with `DOCS_PHP_VERSIONS=8.3,8.4` to choose versions. |
| `DOCS_BASE_URL`     | The path the site is served under. Default `/docs`, which suits `npm start`.        |
| `SMGEN`             | An SMGen command to use instead of the pinned one.                                  |

</div>

Once the assets are staged you can also run SMGen yourself in `site/`, for example `BASE_URL=/docs smgen build`.

## Publishing

The **Publish documentation** workflow builds the site on every push to `main` with `DOCS_BASE_URL` set to the path GitHub Pages serves it under, runs the browser tests against it, and deploys `docs/`. It downloads the pinned runtime bundle and verifies its checksum; a runtime is never taken from an unpinned `latest`.

To publish a new runtime, build every version, package it with `scripts/package-runtime.mjs`, upload the archive as a release asset, and record its URL, checksum and source commit in `runtime-lock.json`.
