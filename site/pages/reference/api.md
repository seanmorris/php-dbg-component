---
title: "API reference"
description: "Options, methods, events and state of the controller."
menus:
  docs:
    weight: 10
---

# API reference

```javascript
import {PhpDebugger} from 'php-dbg-component';

const dbg = new PhpDebugger(options);
```

## Options

<div class="table-scroll">

| Option            | Meaning                                                                                   |
|-------------------|-------------------------------------------------------------------------------------------|
| `runtimeBaseUrl`  | Where the runtime files are served. See [Host runtime files](hosting.html).               |
| `version`         | PHP version, `'8.0'` to `'8.5'`. Default `'8.4'`.                                         |
| `code`            | The PHP to run: a string, or a function returning one (it may be async).                  |
| `source`          | Instead of `code`: an element or an [editor adapter](../guide/editors.html).              |
| `breakpoints`     | Line numbers, or `{file, line, enabled}` objects. Lines start at 1.                       |
| `files`           | More files for the run, by absolute path: `{'/helpers.php': '<?php …'}`.                  |
| `expect`, `assert` | What a [test](../guide/tests.html) should produce.                                       |
| `timeoutMs`       | A limit on time spent running PHP. Default none.                                          |
| `execution`       | `'worker'` (default) or `'main'`. See [versions and extensions](versions-and-extensions.html). |
| `sharedLibs`, `extensions` | PHP extensions to load. See [versions and extensions](versions-and-extensions.html). |

</div>

The [TypeScript declarations](https://github.com/seanmorris/php-dbg-component/blob/main/src/index.d.ts) list every option, event and result type.

## Methods

Methods that run PHP return promises. `run()` resolves when the run ends, so keep its promise and carry on when you want to act during the run:

```javascript
const done = dbg.run();

await dbg.whenPaused();
await dbg.stepOver();
await dbg.continue();

const result = await done;
```

<div class="table-scroll">

| Method                                                        | What it does                                                                               |
|---------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| `mount(element)`                                              | Build the interface inside an element. Optional.                                           |
| `prepare()`                                                   | Download and start the selected runtime without running the source.                        |
| `run(options)`, `restart(options)`                            | Run PHP and resolve to its [result](../guide/tests.html). Restart ends an active run first. |
| `pause()`, `whenPaused()`                                     | Ask for a pause; wait for the next breakpoint, step or exception.                          |
| `continue()`                                                  | Resume until the next pause or the end.                                                    |
| `stepInto()`, `stepOver()`, `stepOut()`, `until()`, `leave()` | Step, as the [buttons of the same names](../guide/using-the-debugger.html) do.             |
| `inspect(scope, {frame})`                                     | List `variables`, `globals`, `constants`, `functions`, `classes`, `files` or `frames`.     |
| `children(reference, {offset, limit})`                        | List what an array or object holds. 100 entries by default, 1000 at most.                  |
| `selectFrame(index)`                                          | Choose the call to inspect and evaluate in. 0 is the innermost.                            |
| `evaluate(expression, {frame})`                               | Evaluate a PHP expression in a paused frame.                                               |
| `setVariable(reference, expression)`                          | Assign a PHP expression to a variable or to a child of one.                                |
| `setBreakpoints([...])`                                       | Replace the breakpoints, while idle or paused.                                             |
| `setCode(code)`                                               | Set the string or function for the next run.                                               |
| `setVersion(version)`                                         | End any run and select the version for the next.                                           |
| `stop()`                                                      | End the run.                                                                               |
| `destroy()`                                                   | End the run and remove the interface and its listeners.                                    |

</div>

## Values

`inspect()` and `children()` describe each value as:

```javascript
{
  name,          // "price"
  type,          // "int", "string", "array", "object", "unset", …
  displayValue,  // "8", "\"Notebook\"", "array(3)"
  value,         // the value itself, for scalars
  reference,     // pass to children() and setVariable()
  expandable,    // true for arrays and objects
  writable,
  className, count, visibility  // where they apply
}
```

A reference is good until execution resumes or ends. PHP types, class names and counts come from a runtime with debugger API 2; an older runtime reports JavaScript's types (`number`, `boolean`) and lists only public properties.

## Events

Each event is a `CustomEvent` with its data in `detail`:

```javascript
dbg.addEventListener('output', ({detail}) => {
  console.log(detail.channel, detail.text);
});

dbg.addEventListener('complete', ({detail}) => {
  console.log(detail.status, detail.exitCode);
});
```

<div class="table-scroll">

| Event              | When                                                                               |
|--------------------|------------------------------------------------------------------------------------|
| `statechange`      | The state changed. `detail.state` is the new one.                                  |
| `progress`         | The runtime is downloading: `loaded` and `total` bytes (`total` may be `null`).    |
| `output`           | PHP printed something. `channel` is `stdout`, `stderr` or `debug`.                 |
| `pause`            | Execution paused. `reason` is `breakpoint`, `step`, `pause` or `exception`.        |
| `locationchange`   | The file, line or frame being shown changed.                                       |
| `framechange`      | Another frame was selected.                                                        |
| `variablechange`   | A variable was set.                                                                |
| `breakpointchange` | The breakpoints changed.                                                           |
| `versionchange`    | Another PHP version was selected.                                                  |
| `sourcechange`     | `setCode()` was called.                                                            |
| `diagnostic`       | PHP reported an error or an uncaught exception.                                    |
| `testresult`       | A test's expectations were checked.                                                |
| `complete`         | The run ended. `detail` is the result.                                             |

</div>

## State

Read `dbg.state`, `dbg.location`, `dbg.breakpoints` and `dbg.result` at any time. `state` is one of `idle`, `loading`, `ready`, `running`, `paused`, `completed`, `stopped`, `error` or `destroyed`. The interface puts it on its root element as `data-state`, for CSS.
