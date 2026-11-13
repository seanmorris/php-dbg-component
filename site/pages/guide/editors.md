---
title: "Sources and editor adapters"
description: "Pass a string, bind an element, or attach Ace or CodeMirror."
menus:
  docs:
    weight: 60
---

# Sources and editor adapters

The controller reads its source at the start of each run. Give it a string or a function with `code`, or an element or an adapter with `source`.

<div class="table-scroll">

| Source                     | Option                                                       |
|----------------------------|--------------------------------------------------------------|
| A string                   | `code: '<?php echo 42;'`                                     |
| A variable, or a loader    | `code: () => currentPhpCode`, which may be async             |
| A textarea or input        | `source: document.querySelector('textarea')`                 |
| Any other element          | `source: document.querySelector('pre')` reads its text       |
| An editor you already have | `source: adapter`                                            |

</div>

With a string, `mount()` builds its own editor with line numbers. A textarea inside the mounted element is taken over as that editor; see the [custom element](custom-element.html).

## Ace and CodeMirror

An adapter connects an editor that is already on your page. Import only the one you use:

```javascript
import {PhpDebugger} from 'php-dbg-component';
import {createAceAdapter} from 'php-dbg-component/adapters/ace';

const adapter = createAceAdapter(existingAceEditor);
const dbg = new PhpDebugger({runtimeBaseUrl: './runtime/', source: adapter});

dbg.mount(document.querySelector('#controls'));

// When removing the integration:
await dbg.destroy();
adapter.dispose();
```

<div class="table-scroll">

| Editor       | Import                                                                             |
|--------------|------------------------------------------------------------------------------------|
| Ace          | `createAceAdapter` from `'php-dbg-component/adapters/ace'`                         |
| CodeMirror 5 | `createCodeMirror5Adapter` from `'php-dbg-component/adapters/codemirror5'`         |
| CodeMirror 6 | `createCodeMirror6Adapter` from `'php-dbg-component/adapters/codemirror6'`         |

</div>

The CodeMirror 6 adapter needs `@codemirror/state` and `@codemirror/view`, from the same copies your editor uses.

An adapter adds a breakpoint gutter you can click, marks the paused line, and makes the editor read-only while PHP runs. The editor stays yours: you create it, theme it and destroy it. The component itself depends on neither Ace nor CodeMirror.

## Colours of the markers

The markers sit inside your editor, with its theme. Their default colours show on light and dark themes alike. To change them, set `--php-debugger-active`, `--php-debugger-paused` and `--php-debugger-error` on the editor's container. See [CSS and themes](../reference/styling.html).
