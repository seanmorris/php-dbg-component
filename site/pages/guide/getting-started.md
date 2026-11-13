---
title: &title "Get started"
description: &description "Install the component, serve a runtime and mount the debugger on a page."
menus:
  docs:
    weight: &weight 10
llms:
  section: guide
  weight: *weight
jsonld:
  "@context": https://schema.org
  "@type": TechArticle
  headline: *title
  description: *description
  about:
    "@id": https://seanmorris.github.io/php-dbg-component/#software
  isPartOf:
    "@id": https://seanmorris.github.io/php-dbg-component/#website
---

# Get started

Three things make a working debugger: the component, a PHP runtime it can download, and an element to mount it in.

## 1. Install the component

The component is installed from GitHub until its first npm release:

```bash
npm install github:seanmorris/php-dbg-component
```

## 2. Serve a runtime

The debugger runs real PHP, compiled to WebAssembly, and downloads it from your site when a reader first clicks **Run**. Until `php-dbg-wasm` publishes a release with the debugger bridge, take the preview runtime from a clone of this repository:

```bash
git clone https://github.com/seanmorris/php-dbg-component.git
cd php-dbg-component
npm ci
npm run setup:runtime
```

Copy `runtime-bundle/runtime/` to your site as `runtime/`, and keep its files together. [Host runtime files](../reference/hosting.html) covers extensions, native builds and what the server must send.

## 3. Mount it

```javascript
import {PhpDebugger} from 'php-dbg-component';
import 'php-dbg-component/styles.css';

const dbg = new PhpDebugger({
  runtimeBaseUrl: './runtime/',
  version: '8.4',
  code: '<?php\n$n = 2;\n$n += 3;\necho $n;',
  breakpoints: [3]
});

dbg.mount(document.querySelector('#debugger'));
```

`mount()` builds the editor and the controls inside the element. Nothing is downloaded until the reader clicks **Run** or your code calls `run()` or `prepare()`. Breakpoint lines start at 1. Call `await dbg.destroy()` when you remove the debugger.

Serve the page over HTTPS or from `localhost`. A page opened from `file://` cannot start the worker PHP runs in.

## Without a bundler

Every example in these pages imports from `'php-dbg-component'`. A bundler resolves that name. A page with no build step tells the browser where the files are with an import map, and loads the stylesheet with a link:

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>PHP debugger</title>
<link rel="stylesheet" href="./node_modules/php-dbg-component/src/styles.css">

<script type="importmap">
{
  "imports": {
    "php-dbg-component": "./node_modules/php-dbg-component/src/index.mjs",
    "php-dbg-component/element": "./node_modules/php-dbg-component/src/element.mjs",
    "php-dbg-component/adapters/ace": "./node_modules/php-dbg-component/src/adapters/ace.mjs"
  }
}
</script>

<div id="debugger"></div>

<script type="module">
  import {PhpDebugger} from 'php-dbg-component';

  const dbg = new PhpDebugger({
    runtimeBaseUrl: './runtime/',
    code: '<?php\n$n = 2;\n$n += 3;\necho $n;',
    breakpoints: [3]
  });

  dbg.mount(document.querySelector('#debugger'));
</script>
</html>
```

List only the entries the page imports. With a bundler, keep the module worker as its own file; if your build puts it at a different URL, pass that URL as `workerUrl`.

## Next

- Put the code in the page itself with the [custom element](custom-element.html).
- See [what your readers get](using-the-debugger.html).
- Give it [your site's colours](../reference/styling.html).
