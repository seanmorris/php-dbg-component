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
# The top band: the debugger at working size, and what to try with it underneath. The body
# follows beside the contents.
hero: |
  # Add a PHP debugger to your page

  ::: {.lede}
  Let readers step through examples and edit variables as PHP runs in their browser. Embed it with vanilla JavaScript, or connect an existing editor.
  :::

  <div class="demo">
  <div class="demo-bar">
  <label class="field">Source editor <select id="editor-kind" class="field-select"><option value="textarea">Textarea</option><option value="ace">Ace</option><option value="codemirror5">CodeMirror 5</option><option value="codemirror6" selected>CodeMirror 6</option></select></label>
  <button id="reset" type="button" class="btn">Reset example</button>
  <div id="demo-problem" class="demo-problem" role="alert"></div>
  </div>
  <div id="debugger-host"></div>
  </div>
  <script type="module" src="demo.mjs"></script>

  ::: {.try}
  ## Try it here {#try}

  Click **Run** to pause on line 8, at the first item in the cart. Open `item` and change `price` to `10`, then click **Continue**. It pauses on line 8 again for the pen and the backpack, with `sum` growing each time; click **Continue** until it finishes. The notebook's line comes to `30`, the discount to `7`, and the total to `63` instead of `58`.
  :::
---

## Use it with your own code

Pass a PHP string, put a `<textarea>` inside the custom element, or attach an Ace or CodeMirror adapter. The interface is plain HTML with its own stylesheet, and takes its colours from a handful of CSS variables.

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

[Get started](guide/getting-started.html) · [Custom element](guide/custom-element.html) · [Editor adapters](guide/editors.html)

## Run PHP tests from the page

The same controller checks output and exit codes without showing an interface. Await each result, or run separate controllers side by side.

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

<div class="try-result"><button id="run-test" type="button" class="btn">Run PHP assertion</button><output id="test-result" aria-live="polite">Not run</output></div>

[Running tests](guide/tests.html)
