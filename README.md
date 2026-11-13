# php-dbg-component

A vanilla JavaScript PHP debugger you can embed in a page or drive from a script. It runs real PHP through [php-dbg-wasm](https://github.com/seanmorris/php-wasm), with a worker per execution, shared downloads, and an optional, fully styleable interface.

[Live demo](https://seanmorris.github.io/php-dbg-component/) · [Get started](https://seanmorris.github.io/php-dbg-component/guide/getting-started.html) · [API](https://seanmorris.github.io/php-dbg-component/reference/api.html) · [Source](src/index.mjs)

- PHP 8.0–8.5, selected at runtime; default 8.4.
- Breakpoints, pause/continue, stepping, frames, locals, globals, constants, functions, classes, and files.
- Edit variables and evaluate PHP expressions in the selected frame while paused. Expand arrays and objects; add watches in the UI.
- Textarea, arbitrary DOM element, string, async getter, or an existing Ace / CodeMirror 5 / CodeMirror 6 editor.
- Awaitable run results, output events, cancellation, timeouts, and optional test expectations.
- Light DOM, namespaced classes, optional CSS, and no editor dependency in the core.

## Quick start

Install from this repository until an npm release is published:

```sh
npm install github:seanmorris/php-dbg-component
```

Serve matching **bridge v1** runtime artifacts from `php-dbg-wasm` (see below). The older published php-dbg-wasm package does not contain the required bridge or worker wrapper.

```html
<link rel="stylesheet" href="./node_modules/php-dbg-component/src/styles.css">
<div id="debugger"></div>
<script type="module">
  import {PhpDebugger} from './node_modules/php-dbg-component/src/index.mjs';
  const dbg = new PhpDebugger({
    runtimeBaseUrl: './runtime/',
    code: '<?php\n$n = 2;\n$n += 3;\necho $n;',
    breakpoints: [3]
  });
  dbg.mount(document.querySelector('#debugger'));
  // Nothing executes or downloads WASM until Run, run(), or prepare().
</script>
```

For a bundler, import from `php-dbg-component` and `php-dbg-component/styles.css`. Preserve the module worker and the runtime's relative file layout. `workerUrl` can override the worker entry URL.

## Source and editors

`code` accepts a string or a function returning a string (or a promise). `source` accepts a textarea/input, any element (`textContent`), a getter, or an adapter. The source is read once at the start of each run. `setCode()` changes the next run, not an already executing script. Without a supplied source, mounting creates a textarea for string code. Source getters remain authoritative and do not create an editor.

```js
const dbg = new PhpDebugger({source: document.querySelector('textarea'), runtimeBaseUrl: './runtime/'});
// Or: code: () => currentPhpCode

import {createAceAdapter} from 'php-dbg-component/adapters/ace';
import {createCodeMirror5Adapter} from 'php-dbg-component/adapters/codemirror5';
import {createCodeMirror6Adapter} from 'php-dbg-component/adapters/codemirror6';
const adapter = createAceAdapter(existingAceEditor);
const editorDebugger = new PhpDebugger({source: adapter, runtimeBaseUrl: './runtime/'});
editorDebugger.mount(document.querySelector('#controls'));
// When the integration is removed:
await editorDebugger.destroy();
adapter.dispose(); // Detach markers/listeners; the host still owns the editor.
```

Make the editor inside the element you pass to `mount()` and it moves into the interface, under the toolbar where the textarea would be, until `destroy()` hands it back; made anywhere else, it stays where the page put it. Either way it keeps its own theme and the height you give it. Use just the adapter matching your editor. Ace and CodeMirror 5 import no editor library. CodeMirror 6 has optional `@codemirror/state` and `@codemirror/view` peers. Adapters add breakpoint gutters, current-line highlights, and temporary read-only state. Set `{file:'/example.php'}` on an adapter if the controller uses that entrypoint.

## Debugging from JavaScript

```js
const done = dbg.run();                    // Resolves only when this run ends.
const {location} = await dbg.whenPaused(); // A breakpoint or step.
const locals = await dbg.inspect('variables');
const n = locals.find(value => value.name === 'n');
await dbg.setVariable(n.reference, '40 + 2');
await dbg.evaluate('$settings["enabled"] = true');
await dbg.stepOver();
await dbg.continue();
const result = await done;
```

| Operation | Meaning |
| --- | --- |
| `prepare()` | Download and initialize the selected runtime, without executing user code. |
| `run(options)` / `restart(options)` | Start execution; restart first cancels the previous run. |
| `pause()` / `whenPaused()` | Request a cooperative pause / wait for the next pause. |
| `continue()`, `stepInto()`, `stepOver()`, `stepOut()`, `until()`, `leave()` | phpdbg execution controls. |
| `inspect(scope, {frame})` | `variables`, `globals`, `constants`, `functions`, `classes`, `files`, or `frames`. Frames are `{frame, filename, lineNo, selected}` and are always listed from the innermost frame. A variable the frame has not assigned yet has type `unset`. With a runtime that provides debugger API 2, frames also carry `functionName` and `className`, and values carry PHP types (`int`, `float`, `bool`, `string`, `array`, `object`, `null`), `className` and `count`; older runtimes report JavaScript-derived types (`number`, `boolean`, …). |
| `selectFrame(index)` | Change the inspected/evaluated frame. Zero is the innermost frame. |
| `children(reference, {offset, limit})` | Expand a value, default 100 entries; maximum page size 1000. A property of an object carries `visibility`. With a runtime that provides debugger API 2, private and protected properties are listed as well, read-only; older runtimes list public properties only. |
| `evaluate(expression, {frame})` | Evaluate a PHP expression, including assignments and multiline expressions. A syntax error or an uncaught exception rejects with a message about the expression (`syntax error, unexpected end of expression`, `Error: Call to undefined function nope()`) and leaves the run and its exit code as they were. |
| `setVariable(reference, expression)` | Assign a PHP expression to a variable or child value. |
| `opcodes(target)` | The ops phpdbg's `print` lists: `{functions: [{name, file, start, end, info, ops: [{line, index, result, opcode, operands, jumps}]}], current}`; `jumps` lists the indexes of the ops an op can jump to. With no target, the selected frame's function, and `current` is the op that frame stands on (`{line, index}`); `{script: true}`, `{function: name}` or `{class: name}` list the main script, a function or every method of a class. The main script is named `{main}`. Reads PHP 8.0's phpdbg layout and the dump PHP 8.1 and later print. |
| `setBreakpoints([...])` | Replace breakpoints while idle or paused. Integers or `{file,line,enabled}`. |
| `setVersion('8.5')` | Stop execution and select a version. Downloads begin on the next run. |
| `stop()` / `destroy()` | Cancel execution / also remove the view and component listeners. |

References are opaque and valid only during their pause. Continuing, stepping, restarting, or ending invalidates them. Constants are read-only. PHP enforces visibility, types, and readonly properties; a failed edit reports the PHP error. Evaluations can call functions and have side effects. Debug code you trust.

Paths must be absolute, without whitespace, quotes, colons, backslashes, or `.`/`..` segments; `/.php-debugger` is reserved. Additional virtual files can be supplied as `files: {'/helpers.php': '<?php ...'}`. Source breakpoints are one-based and may target those files.

## Page-driven PHP tests

```js
const test = new PhpDebugger({
  runtimeBaseUrl: './runtime/', code: '<?php echo "ok\\n";',
  expect: {stdout: 'ok\n', stderr: '', exitCode: 0}
});
const result = await test.run({mode: 'test', timeoutMs: 5000});
console.log(result.test.status); // passed, failed, or unchecked
```

`run()` returns `{runId,version,status,exitCode,stdout,stderr,diagnostics,durationMs,test}`. Status is `completed`, `cancelled`, `timed-out`, or `error`; a completed PHP process can still have a nonzero exit code. The promise resolves with failures as data. Invalid API arguments and overlapping runs throw.

Expectations accept exact strings or RegExp for `stdout`, `stderr`, and diagnostic `error`, plus an explicit `exitCode`. Output whitespace is preserved, including output from shutdown functions, destructors, and output handlers. With expectations, successful exit zero is required by default; specify the expected nonzero code for negative tests. An optional async `assert(result)` may return false or throw to fail the test. With no expectations/assertion, status is `unchecked`. Test mode skips breakpoints and continues through exception stops. Cancellation, timeouts, and infrastructure errors cannot pass expectations.

`timeoutMs` counts time running PHP, excluding loading and time paused. `loadTimeoutMs` defaults to 120 seconds. `signal` accepts an AbortSignal. `outputLimit` defaults to 10 million characters. A run gets fresh runtime memory and virtual files; downloads and compiled modules are shared. Put your own sequential or batch scheduler around `await run()` / `Promise.all()`.

## Custom element

```html
<php-debugger runtime-base-url="./runtime/" breakpoints="[3]">
  <textarea><?php
$n = 2;
echo $n;
</textarea>
</php-debugger>
<script type="module">
  import {definePhpDebugger} from './node_modules/php-dbg-component/src/element.mjs';
  definePhpDebugger();
</script>
```

A `<textarea>` inside the element becomes the editor: it moves into the interface, gets line numbers you can click for breakpoints, and shows the paused line. It is handed back as it was when the debugger is destroyed. (The same holds for a textarea inside any element passed to `mount()`; one elsewhere on the page, passed as `source`, stays where it is.) The element is a block; the stylesheet covers the default `php-debugger` name and any name you register.

Registration is explicit. Supported attributes: `version`, `execution`, `runtime-base-url`, `source` (CSS selector), `breakpoints` (JSON), `extensions` (comma-separated), `mode`, and `autorun`. Only `version` is observed after connection; use controller methods for other changes. Set `.options`, `.source`, `.code`, or `.expect` before insertion for richer inputs. A nested `<script type="application/json" data-expect>` supplies JSON expectations. **Autorun is opt-in**; use `autorun mode="test"` for page-driven tests. Removing the element destroys its controller; moving it in the same document preserves it.

The element exposes `.debugger` and forwards execution/inspection methods. `inspectChildren()` corresponds to the controller's `children()` because DOM elements already have a `children` property.

## Events and styling

Controller events are `CustomEvent`s with `.detail`: `statechange`, `progress` (`loaded`, `total` bytes of the interpreter download; `total` is `null` when the server does not say), `output` (`channel`, `text`), `pause`, `locationchange`, `framechange`, `variablechange`, `breakpointchange`, `versionchange`, `sourcechange`, `diagnostic`, `testresult`, and `complete`. Custom element events bubble with a `phpdbg-` prefix. `stdout` and `stderr` are program output; `debug` is debugger console output, and its `kind` is `notice` (phpdbg's own messages), `error`, or `evaluation`. The built-in view shows program output, errors and evaluation output, and keeps notices hidden until "Debugger log" is ticked. It echoes each evaluated expression before its result, and reports an expression's error beside the expression box. Its status line, at the bottom, is a sentence: `Paused at line 5 of /main.php, on a breakpoint.`, `Finished with exit code 0.` For state in code or CSS, use `dbg.state` or the root's `data-state`, not that text. While focus is inside the debugger, F8 runs or continues, F10 steps over, F11 steps into and Shift+F11 steps out. The line numbers are one tab stop (arrow keys move along them, Enter sets or clears a breakpoint), and so is the row of inspector tabs.

Output and inspector sit side by side, at one height, while the debugger is wide enough for both and stack otherwise, whatever the width of the page. The inspector's tabs are one row: Variables, Frames, Opcodes, Watches and Breakpoints first, all but Opcodes with counts, then the program's tables, and whatever does not fit moves into a More list. Breakpoints are listed and added in their tab at any time. Values, and the lists of frames, functions, classes and files, are rows across the panel; each list is one tab stop, worked with the arrow keys and Enter. On a phone the toolbar is one row that scrolls sideways and stays at the top of the screen while the debugger is in view; set `--php-debugger-sticky-top` to the height of a fixed page header. With a coarse pointer, controls are at least 44px and text boxes at least 16px.

```css
.my-page .php-debugger {
  color-scheme: dark;
  --php-debugger-bg: #131b27;
  --php-debugger-fg: #e7edf5;
  --php-debugger-accent: #8ce4cb;
  --php-debugger-border: #35465c;
  --php-debugger-radius: 12px;
}
.my-page .php-debugger .php-debugger-button { font-family: inherit; }
```

There is no shadow root. All classes start with `php-debugger-`; the root is `.php-debugger`. Rendered PHP strings use text nodes.

- **Variables** can be set from any rule, in a stylesheet loaded before or after the component's. Besides those above: `--php-debugger-muted`, `--php-debugger-error` (errors and breakpoints), `--php-debugger-success`, `--php-debugger-active` and `--php-debugger-paused` (the band across the line where execution is paused, and the bar at its left edge), `--php-debugger-font`, and `--php-debugger-line-height` (a length; the pitch the line numbers and the source share).
- **Light and dark.** The default colours follow the page's `color-scheme`. A page with a dark design that has not declared one sets `color-scheme: dark` on `:root` or on `.php-debugger`, as above, and the variables it leaves alone take their dark defaults.
- **Markers in Ace and CodeMirror** sit in an editor with a theme of its own, beside the debugger or moved into it, so their default colours are ones that show on light and dark themes. Set `--php-debugger-active`, `--php-debugger-paused` and `--php-debugger-error` on the editor's container to change them.
- **Page rules for bare elements stay out.** A reset (`* { padding: 0 }`), a classless framework's `button` rule or a typography wrapper's `.prose pre` does not restyle the debugger, so it looks the same on any page. Text takes the font and size of the element you mount it in.
- **To restyle a part**, select it inside the root, as above, in a stylesheet loaded after the component's or with one more class in front. A `.php-debugger` rule loaded after the component's restyles the root.
- **Editor geometry is fixed.** The line numbers' and the source's line height, padding and borders are `!important`, as is `display: none` on hidden console lines: with either changed the debugger points at the wrong line.
- Root `data-state` and `data-test-status` attributes support state styling.

## Runtime assets, versions, and extensions

The [pinned runtime bundle](runtime-lock.json) used by the live demo includes all six PHP versions and the curl, DOM, and libxml extensions. Run `node scripts/download-runtime.mjs` from this checkout to download and verify it, then deploy the resulting directories together. Downloads in your page remain lazy.

To build your own bridge v1 artifacts from the `feat/php-dbg-component` branch of php-wasm:

```sh
git clone --branch feat/php-dbg-component https://github.com/seanmorris/php-wasm.git
cd php-wasm
npm ci
make image
make worker-dbg-mjs web-dbg-mjs ENV_FILE=.github/.env_8.4.dynamic.ci PHP_VERSION=8.4
```

Repeat for the versions you offer. Serve `packages/php-dbg-wasm/` at `runtimeBaseUrl` with its `.mjs`, `.wasm`, `.assets.json`, and any `.data` assets. The manifest is generated during the build and includes the binary SHA-256 and required libraries. Keep matching wrapper/helper modules together. The component rejects artifacts without bridge v1.

Use the same `sharedLibs` inputs as php-wasm. With a bundler:

```js
import * as curl from 'php-wasm-curl';

const dbg = new PhpDebugger({
  runtimeBaseUrl: './runtime/',
  version: '8.4',
  sharedLibs: [curl],
  code: '<?php var_dump(extension_loaded("curl"));'
});
```

For a static site, replace the package import with `await import('./php-wasm-curl/index.mjs')`. Package index modules select binaries using the active PHP version, including after `setVersion()`. Importing the helper does not download its WASM binaries. Include supporting packages explicitly when the extension helper does not declare them, for example `sharedLibs: [dom, libxml]`.

`sharedLibs` also accepts library URL strings, `URL` objects, and `{name, url, ini}` definitions. URL strings and `URL` objects enable the PHP extension at startup; object definitions require `ini: true`. `ini: false` and `dynamicLibs` make libraries available without adding an `extension=` line. The preview phpdbg runtime does not expose PHP's `dl()` function, so enable PHP extensions at startup. Bare library filenames resolve relative to `runtimeBaseUrl`, with `libraryUrls` available for explicit mappings.

The component calls the runtime's `resolveDependencies()` on the page, including package `getLibs()` and `getFiles()` hooks. It passes cached URLs to the worker and preloads files before PHP initialization. Hooks receive `phpVersion` and `phpArgs`; they do not receive an initialized PHP runtime. Inputs under `runtimeArgs.sharedLibs`, `runtimeArgs.dynamicLibs`, and preload definitions under `runtimeArgs.files` use the same process. The top-level `files` option remains a map of virtual source files.

The existing `extensions:['curl','dom','libxml']` shorthand imports helpers and passes them to the same resolver. Versioned helpers use `../php-wasm-NAME/VERSION.mjs` relative to the runtime directory; libxml and zlib use `index.mjs`. Override with `extensionUrls: {curl:'https://example.test/curl/8.4.mjs'}` or `extensions:[{module:'https://example.test/custom/8.4.mjs'}]`. Include support libraries explicitly, as in php-wasm. The component does not inspect WASM dependency sections or guess package locations.

The default registry shares download promises, immutable bytes, blob URLs for shared libraries, and compiled WebAssembly modules across components on a page. Each worker instantiates its own memory. Failed downloads are evicted for retry. `assetRegistry` can supply a separate `AssetRegistry`. Call `sharedAssets().clear()` only after all components stop. Serve the component over HTTPS or localhost for browser checksum verification. Network access follows browser CORS and CSP rules; allow your asset origins, module workers, WASM compilation, and blob asset fetches. No SharedArrayBuffer or cross-origin isolation is required.

## Worker and main-thread execution

`execution:'worker'` is the default. It keeps the interface responsive and supports hard termination, even when PHP is stuck in a native call. PHP cannot access the page DOM there. `execution:'main'` enables direct DOM access through vrzno, but stopping and pausing are cooperative between PHP opcodes; a blocking native call can prevent timers and UI controls from running. `capabilities.hardStop` advertises the distinction. Both modes execute trusted code: a same-origin worker is **not a security sandbox** and may access network and browser APIs.

## Development and docs

```sh
npm ci
npm run setup:runtime
npm test
npm run test:types
npm run lint
RUNTIME_BUNDLE=./runtime-bundle npm run build:docs
PHP_VERSION=8.4 npm run test:browser
npm start
```

The development server first uses a compatible installed `php-dbg-wasm` package. Until its next npm release includes bridge v1, the server falls back to the pinned demo build in `runtime-bundle/`, downloading it if needed. To use local native builds instead, set `PHP_WASM_ROOT=/path/to/php-wasm`. An explicit path with missing assets produces a setup error at startup.

Install test browsers with `npx playwright install --with-deps`. Browser regressions exercise real native artifacts. The documentation and demo site is an [SMGen](https://seanmorris.github.io/smgen/) project in `site/`. `npm run build:docs` stages the component, the editors and matching runtime assets into it and builds it into `docs/`, which GitHub Pages publishes; it needs PHP 8.1 or newer with the YAML extension, and Pandoc, and fetches SMGen itself at the commit in `site/smgen-lock.json`. The site's own [Work on this repository](site/pages/development.md) page has the details. `docs/` and runtime binaries are build outputs and are not checked into source control.

Licensed under Apache-2.0 or GPL-2.0-only. PHP, php-wasm, and optional editor distributions retain their own licenses; see [NOTICE](NOTICE).
