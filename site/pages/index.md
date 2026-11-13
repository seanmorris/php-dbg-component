---
title: "Add a PHP debugger to your page"
pagetitle: "Embed a PHP debugger"
description-meta: &description "Embed a PHP debugger in your page. Try live breakpoints, variable editing, and PHP tests with a vanilla JavaScript component."
template: templates/home.php
TOC: false
# llms.txt introduces the project in its own summary.
llms: false
# The site and the component. The other pages point at both by their @id.
jsonld:
  "@context": https://schema.org
  "@graph":
    - "@type": WebSite
      "@id": https://seanmorris.github.io/php-dbg-component/#website
      url: https://seanmorris.github.io/php-dbg-component/
      name: php-dbg-component
      description: *description
    - "@type": SoftwareSourceCode
      "@id": https://seanmorris.github.io/php-dbg-component/#software
      name: php-dbg-component
      description: "Let readers step through examples and edit variables as PHP runs in their browser. Embed it with vanilla JavaScript, or connect an existing editor."
      codeRepository: https://github.com/seanmorris/php-dbg-component
      programmingLanguage: JavaScript
      runtimePlatform: Web browser
---

:::: {.hero}
# Add a PHP debugger to your page

Let readers step through examples and edit variables as PHP runs in their browser. Embed it with vanilla JavaScript, or connect an existing editor.

[Try the debugger](#try){.btn .btn-primary} [Get started](guide/getting-started.html){.btn}
::::

:::: {.band #try}
## Try it here

Click **Run** to pause on line 5. Open `item` and change `price` to `10`, then click **Continue**. The total changes from `24` to `30`.

<div class="demo">
<div class="demo-bar">
<label class="field">Source editor <select id="editor-kind" class="field-select"><option value="textarea">Textarea</option><option value="ace">Ace</option><option value="codemirror5">CodeMirror 5</option><option value="codemirror6">CodeMirror 6</option></select></label>
<button id="reset" type="button" class="btn">Reset example</button>
<div id="demo-problem" class="demo-problem" role="alert"></div>
</div>
<div id="debugger-host"></div>
</div>
<script type="module" src="demo.mjs"></script>

[PHP 8.0 to 8.5 run in a worker in your browser. The selected version downloads on its first run; debuggers on the same page share the download.]{.note}
::::

:::: {.band .split}
::: {.split-text}
## Use it with your own code

Pass a PHP string, put a `<textarea>` inside the custom element, or attach an Ace or CodeMirror adapter. The interface is plain HTML with its own stylesheet, and takes its colours from a handful of CSS variables.

[Get started](guide/getting-started.html) · [Custom element](guide/custom-element.html) · [Editor adapters](guide/editors.html)
:::

```javascript
import {PhpDebugger} from 'php-dbg-component';
import 'php-dbg-component/styles.css';

const dbg = new PhpDebugger({
  runtimeBaseUrl: './runtime/',
  code: '<?php\n$n = 2;\n$n += 3;\necho $n;',
  breakpoints: [3]
});

dbg.mount(document.querySelector('#debugger'));
```
::::

:::: {.band .split}
::: {.split-text}
## Run PHP tests from the page

The same controller checks output and exit codes without showing an interface. Await each result, or run separate controllers side by side.

<div class="try-result"><button id="run-test" type="button" class="btn">Run PHP assertion</button><output id="test-result" aria-live="polite">Not run</output></div>

[Running tests](guide/tests.html)
:::

```javascript
const test = new PhpDebugger({
  runtimeBaseUrl: './runtime/',
  code: '<?php echo 6 * 7, "\n";'
});

try {
  const result = await test.run({
    mode: 'test',
    expect: {stdout: '42\n', exitCode: 0}
  });

  console.log(result.test.status); // "passed"
} finally {
  await test.destroy();
}
```
::::
