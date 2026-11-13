---
title: &title "PHP versions and extensions"
description: &description "Choose a PHP version, load extensions, and pick worker or main-thread execution."
menus:
  docs:
    weight: &weight 20
llms:
  section: reference
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

# PHP versions and extensions

## Versions

PHP 8.0 to 8.5 are supported, and 8.4 is the default. Host the files for every version you offer.

```javascript
const dbg = new PhpDebugger({runtimeBaseUrl: './runtime/', version: '8.3'});

await dbg.setVersion('8.5');
```

`setVersion()` ends a run in progress and selects the version for the next one. Nothing is downloaded until that run starts.

## Extensions

Extensions are loaded with `sharedLibs`, as in php-wasm. Pass the extension's package module; it picks the binary for the PHP version in use:

```javascript
import * as curl from 'php-wasm-curl';

const dbg = new PhpDebugger({
  runtimeBaseUrl: './runtime/',
  sharedLibs: [curl],
  code: '<?php echo extension_loaded("curl") ? "yes" : "no";'
});
```

This button loads curl and asks PHP whether it is there:

<div class="try-result"><button id="run-curl" type="button" class="btn">Check curl extension</button><output id="curl-result" aria-live="polite">Not loaded</output></div>
<script type="module" src="../demo.mjs"></script>

Requests made through curl still follow the browser's cross-origin rules.

`sharedLibs` also accepts:

- a URL string or a `URL` object for one binary;
- a definition such as `{url: './php-wasm-curl/php8.4-curl.so', ini: true}`. A URL to one binary is tied to that PHP version;
- several modules, when one extension needs another: `sharedLibs: [dom, libxml]`.

`ini: false`, and the `dynamicLibs` option, load a library without enabling it as a PHP extension. The runtime has no `dl()`, so extensions are enabled at startup or not at all.

The shorthand `extensions: ['curl']` finds the module at `../php-wasm-curl/` beside the runtime directory. Point it elsewhere with `extensionUrls: {curl: 'https://example.test/curl/8.4.mjs'}`.

## Worker or main thread

`execution: 'worker'` is the default. PHP runs in a worker, and **Stop** ends it at once whatever it is doing.

`execution: 'main'` runs PHP in the page, which lets it reach the page's DOM through vrzno. There, pause and stop wait for PHP to reach a point where it can yield, and a native call that blocks will block the page. `dbg.capabilities.hardStop` says which you have.

## Run code you trust

The PHP runs in your page's origin. From a worker it can still make network requests and use browser APIs.
