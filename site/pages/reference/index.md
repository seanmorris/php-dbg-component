---
title: &title "Reference"
description: &description "Every option, method, event and file."
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

# Reference

- [API reference](api.html): options, methods, events and state.
- [PHP versions and extensions](versions-and-extensions.html): versions 8.0 to 8.5, extensions, worker or main thread.
- [CSS and themes](styling.html): variables, light and dark, restyling a part.
- [Host runtime files](hosting.html): what to serve and how the files stay together.
