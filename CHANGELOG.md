# php-dbg-component

Changes

## v0.1.0 (unreleased)

* First release: a PHP debugger for the browser. It is a scriptable controller (`PhpDebugger`), an optional interface (`mount()`) and a custom element (`<php-debugger>`), in vanilla JavaScript with no editor dependency in the core. It runs real PHP 8.0 to 8.5 through `php-dbg-wasm`, phpdbg compiled to WebAssembly, in a worker by default or on the main thread. The runtime artifacts must provide debugger bridge v1.

* Execution: `run()`, `restart()`, `stop()`, `pause()`, `continue()`, `stepInto()`, `stepOver()`, `stepOut()`, `until()` and `leave()`, with `whenPaused()` to wait for the next pause. A run takes a timeout, a load timeout, an `AbortSignal` and an output limit, and resolves with its status, exit code, output and diagnostics.

* Breakpoints by file and line. A breakpoint may carry a `condition`, a PHP expression that must be true for it to stop, and a `log`, a PHP expression whose value is printed instead of stopping. A breakpoint acts once each time execution reaches its line, and not again when a call made on the line returns.

* Inspection while paused: `inspect()` lists variables, globals, constants, functions, classes, files and frames; `children()` expands arrays and objects; `selectFrame()` moves between frames; `evaluate()` and `setVariable()` take PHP expressions in the selected frame; `opcodes()` lists the ops of the paused function, the main script, a function or a class, with the op execution stands on.

* Test runs: `run({mode: 'test'})` checks `expect` (`stdout`, `stderr`, `exitCode`, `error` and `logs`, as strings or patterns) and an optional `assert(result)`. A test run skips breakpoints except logpoints, whose messages are in the result's `logs`.

* The interface: a source editor with line numbers to click for breakpoints, a toolbar with keyboard shortcuts, the program's output, and an inspector with tabs for Variables, Frames, Opcodes, Watches, Breakpoints, Globals, Constants, Functions, Classes and Files. It is light DOM with namespaced classes, follows the page's colour scheme, and is restyled through CSS variables.

* Sources: a string, a getter, a textarea or any element, or an adapter for an editor the page already has. Adapters ship for Ace, CodeMirror 5, CodeMirror 6, and code blocks as highlight.js or Pandoc leave them. An editor made inside the mount point moves into the interface.

* The custom element takes its options from attributes or properties, uses a nested `<textarea>` as its editor, forwards the controller's methods, and dispatches its events with a `phpdbg-` prefix.

* Runtime assets: nothing is downloaded until the first run or `prepare()`. Downloads and compiled modules are shared between debuggers on a page and reported through `progress` events. `setVersion()` changes the PHP version, and `sharedLibs` and `extensions` load PHP extensions as php-wasm does.

* TypeScript declarations for the controller, the custom element and the adapters.
