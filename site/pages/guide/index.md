---
title: &title "Guide"
description: &description "From an empty page to a debugger your readers can step through."
menus:
  docs:
    weight: 0
    title: Overview
# llms.txt lists every page this one links to.
llms: false
jsonld:
  "@context": https://schema.org
  "@type": CollectionPage
  name: *title
  description: *description
  isPartOf:
    "@id": https://seanmorris.github.io/php-dbg-component/#website
---

# Guide

Start with [Get started](getting-started.html). It takes a page from empty to a working debugger: install, serve a runtime, mount.

Then pick what your page needs:

- [Custom element](custom-element.html): the same debugger as an HTML tag, with the code in a `<textarea>`.
- [Using the debugger](using-the-debugger.html): what your readers see, and the keys that drive it.
- [Edit variables from JavaScript](editing-variables.html) and continue with the new value.
- [Run PHP tests](tests.html), with or without the interface.
- [Sources and editor adapters](editors.html) for a string, an element, Ace or CodeMirror.
