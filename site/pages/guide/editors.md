---
title: &title "Sources and editor adapters"
description: &description "Pass a string, bind an element, or attach Ace or CodeMirror."
menus:
  docs:
    weight: &weight 60
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
| Code already on the page   | `source: createCodeBlockAdapter(block)`, below               |

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

## Code already on the page

`createCodeBlockAdapter` debugs a code block your page already shows, as its highlighter left it: highlight.js's `<pre><code class="hljs">`, Pandoc's `<div class="sourceCode">` (the blocks SMGen builds), or a plain `<pre><code>`. Each line gets a number to click for a breakpoint, and the line where execution pauses is marked. It imports no highlighter; the colours stay the ones already there.

```javascript
import {createCodeBlockAdapter} from 'php-dbg-component/adapters/code-block';

const adapter = createCodeBlockAdapter(document.querySelector('#example'), {
  // Optional: colour the block again after setCode().
  highlight: code => hljs.highlightElement(code)
});

new PhpDebugger({runtimeBaseUrl: './runtime/', source: adapter, breakpoints: [5]})
  .mount(document.querySelector('#example-debugger'));
```

Pass the block's `<pre>`, its `<code>`, or Pandoc's `div.sourceCode`. Highlight the block before making the adapter. `setCode()` replaces its text, and `highlight`, when given, colours it again. The numbers are drawn, not text, so copying the code copies the code alone; `dispose()` gives the block back as it was.

This block is Pandoc's, as SMGen built this page. Click a line number, then **Run**:

```{#code-block-example .php}
<?php
$prices = ['pen' => 2, 'notebook' => 8, 'backpack' => 30];
$total = 0;
foreach ($prices as $name => $price) {
    $total += $price;
}
echo "Total: $total\n";
```

<div id="code-block-debugger"></div>
<script type="module" src="../demo.mjs"></script>

## Where the editor goes

Make the editor inside the element you pass to `mount()`, and it moves into the debugger, under the toolbar where the textarea would be. `destroy()` puts it back. Made anywhere else on the page, it stays where you put it.

```javascript
const host = document.querySelector('#debugger');
const editor = ace.edit(host.appendChild(document.createElement('div')));

editor.container.style.height = '20rem';

new PhpDebugger({source: createAceAdapter(editor)}).mount(host);
```

Either way the editor keeps its own theme, and the height you give it: Ace needs one, CodeMirror 5 defaults to 300px and CodeMirror 6 grows with its text. The debugger's stylesheet leaves everything inside the editor alone.

## Colours of the markers

The markers sit inside your editor, with its theme. Their default colours show on light and dark themes alike. To change them, set `--php-debugger-active`, `--php-debugger-paused` and `--php-debugger-error` on the editor's container. See [CSS and themes](../reference/styling.html).
