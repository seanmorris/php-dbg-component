---
title: "Custom element"
description: "The debugger as an HTML tag, with the PHP in a textarea inside it."
menus:
  docs:
    weight: 20
---

# Custom element

`<php-debugger>` is the same debugger written as HTML. Put the PHP in a `<textarea>` inside it:

```html
<php-debugger runtime-base-url="./runtime/" breakpoints="[3]">
  <textarea><?php
$n = 2;
$n += 3;
echo $n;
</textarea>
</php-debugger>

<script type="module">
  import {definePhpDebugger} from 'php-dbg-component/element';

  definePhpDebugger();
</script>
```

The textarea becomes the editor. It moves into the interface, gets line numbers that set breakpoints, and shows the line where execution is paused. It stays the source: what the reader types is what runs next. When the debugger is destroyed the textarea goes back where it was, as it was.

Registration is explicit: importing the module defines nothing until you call `definePhpDebugger()`. Pass a name to register the element under another tag, `definePhpDebugger('my-debugger')`.

## Attributes

<div class="table-scroll">

| Attribute          | Meaning                                                                 |
|--------------------|-------------------------------------------------------------------------|
| `runtime-base-url` | Where the runtime files are served.                                     |
| `version`          | PHP version, `8.0` to `8.5`. Default `8.4`. Changing it later selects the version for the next run. |
| `breakpoints`      | A JSON array of line numbers, or of `{file, line, enabled}` objects.    |
| `source`           | A CSS selector for the element holding the code, when it is not a child. |
| `extensions`       | Extension names separated by commas, for example `curl,dom`.            |
| `execution`        | `worker` (default) or `main`.                                           |
| `autorun`          | Run as soon as the element is connected.                                |
| `mode`             | `debug` (default) or `test`, for `autorun`.                             |

</div>

Only `version` is watched after the element is connected. For anything else, use the controller.

## From JavaScript

Set `.options`, `.source`, `.code` or `.expect` on the element before it is inserted for values that do not fit in an attribute. After that:

- `element.debugger` is the controller, with everything in the [API reference](../reference/api.html).
- The element forwards the controller's methods: `run()`, `stop()`, `continue()`, `stepOver()`, `inspect()`, `evaluate()`, `setBreakpoints()` and the rest. `children()` is `inspectChildren()` here, because every element already has a `children` property.
- The controller's events bubble from the element with a `phpdbg-` prefix: `phpdbg-pause`, `phpdbg-output`, `phpdbg-complete`.

```javascript
const element = document.querySelector('php-debugger');

element.addEventListener('phpdbg-complete', event => {
  console.log(event.detail.stdout);
});
```

Removing the element from the page destroys its controller. Moving it within the page does not.

## A test that runs when the page loads

```html
<php-debugger runtime-base-url="./runtime/" autorun mode="test">
  <textarea><?php echo "ok";</textarea>
  <script type="application/json" data-expect>
    {"stdout": "ok", "exitCode": 0}
  </script>
</php-debugger>
```

The nested script holds the [expectations](tests.html). Listen for `phpdbg-testresult` on the element for the outcome.

## Layout

The element is a block and fills the width it is given. The textarea is adopted only when it is inside the element (or inside whatever element you pass to `mount()`); a textarea elsewhere on the page, named with `source`, is yours to lay out and stays where it is, without line numbers.
