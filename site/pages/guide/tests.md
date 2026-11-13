---
title: &title "Run PHP tests"
description: &description "Check output and exit codes with the same controller, with or without the interface."
menus:
  docs:
    weight: &weight 50
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

# Run PHP tests

A controller runs PHP without mounting anything. In test mode it skips breakpoints and resolves to the output, the exit code and whether your expectations held:

```javascript
import {PhpDebugger} from 'php-dbg-component';

const test = new PhpDebugger({
  runtimeBaseUrl: './runtime/',
  code: '<?php echo 6 * 7, "\n";'
});

try {
  const result = await test.run({
    mode: 'test',
    expect: {stdout: '42\n', stderr: '', exitCode: 0},
    timeoutMs: 5000
  });

  console.log(result.test.status); // "passed"
} finally {
  await test.destroy();
}
```

That code, run here:

<div class="try-result"><button id="run-test" type="button" class="btn">Run PHP assertion</button><output id="test-result" aria-live="polite">Not run</output></div>
<script type="module" src="../demo.mjs"></script>

## Expectations

`expect` takes exact strings or regular expressions for `stdout`, `stderr` and the diagnostic `error`, and an `exitCode`. Whitespace counts. With expectations, exit code 0 is required unless you name another. `assert(result)` is an optional function of your own; returning false or throwing fails the test.

`result.test.status` is `passed`, `failed`, or `unchecked` when there was nothing to check. `result.test.failures` lists what did not match.

## The result

`run()` resolves to:

```javascript
{
  runId, version,
  status,       // "completed", "cancelled", "timed-out" or "error"
  exitCode,
  stdout, stderr,
  diagnostics,  // PHP errors and uncaught exceptions
  durationMs,
  test          // {status, failures}
}
```

A PHP failure is a result, not an exception: the promise still resolves. It rejects only for a misuse of the API, such as starting a run while one is active.

## Time limits and cancelling

`timeoutMs` counts time spent running PHP, not downloading it or sitting at a breakpoint. Pass an `AbortSignal` as `signal` to cancel.

Each run starts with fresh memory and files. Await runs one after another, or give each test its own controller and run them together; they share the downloaded runtime.

## In the page

The [custom element](custom-element.html) runs a test when it connects, with the expectations in a nested script.
