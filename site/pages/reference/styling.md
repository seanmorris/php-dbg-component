---
title: "CSS and themes"
description: "Variables, light and dark, and how to restyle a part."
menus:
  docs:
    weight: 30
---

# CSS and themes

The interface is ordinary HTML in your page, not a shadow root. Its root is `.php-debugger`, and every class inside starts with `php-debugger-`. Load its stylesheet, then change what you need.

```javascript
import 'php-dbg-component/styles.css';
```

## Variables

Set these on `.php-debugger` from any rule, in a stylesheet loaded before or after the component's:

```css
.php-debugger {
  --php-debugger-bg: #131b27;
  --php-debugger-fg: #e7edf5;
  --php-debugger-accent: #8ce4cb;
  --php-debugger-border: #35465c;
  --php-debugger-radius: 12px;
}
```

<div class="table-scroll">

| Variable                      | Used for                                                          |
|-------------------------------|-------------------------------------------------------------------|
| `--php-debugger-bg`           | Background.                                                       |
| `--php-debugger-fg`           | Text.                                                             |
| `--php-debugger-muted`        | Secondary text: status, line numbers, types.                      |
| `--php-debugger-border`       | Borders.                                                          |
| `--php-debugger-accent`       | The primary button, the selected tab, focus rings.                |
| `--php-debugger-error`        | Errors and breakpoints.                                           |
| `--php-debugger-success`      | A passed test.                                                    |
| `--php-debugger-active`       | The band across the line where execution is paused.               |
| `--php-debugger-paused`       | The bar at the left edge of that band.                            |
| `--php-debugger-radius`       | Corner radius.                                                    |
| `--php-debugger-font`         | The monospace font of the source, values and output.              |
| `--php-debugger-line-height`  | The line pitch the source and its line numbers share. A length.   |
| `--php-debugger-sticky-top`   | On a phone, how far below the top of the screen the controls stick. |

</div>

Text takes the font and size of the element the debugger is mounted in.

## Light and dark

The default colours come in a light and a dark set and follow the page's `color-scheme`. A dark page that has not declared one says so on the root or on the debugger, and every variable it leaves alone takes its dark default:

```css
.php-debugger {
  color-scheme: dark;
}
```

## Your page's other rules stay out

A reset such as `* { padding: 0 }`, a framework's `button` rule or a typography wrapper's `.prose pre` does not restyle the debugger. It looks the same on any page until you change it on purpose.

## Restyling a part

Select the part inside the root, in a stylesheet loaded after the component's:

```css
.php-debugger .php-debugger-button {
  font-family: inherit;
  text-transform: uppercase;
}
```

If your stylesheet loads first, put one more class in front: `.my-page .php-debugger .php-debugger-button`. A `.php-debugger` rule loaded after the component's restyles the root itself.

The root carries `data-state` (`idle`, `loading`, `ready`, `running`, `paused`, `completed`, `stopped`, `error`) and `data-test-status` (`passed`, `failed`, `unchecked`):

```css
.php-debugger[data-state=paused] {
  border-color: var(--php-debugger-paused);
}
```

## What cannot be changed

The line height, padding and borders of the source and of its line numbers are fixed with `!important`, and so is `display: none` on hidden output. With either one off, the debugger would point at the wrong line. Change the pitch with `--php-debugger-line-height`.

## Markers in Ace and CodeMirror

The paused-line and breakpoint markers an [adapter](../guide/editors.html) adds sit inside your editor, outside `.php-debugger`. Their default colours show on light and dark editor themes. Set `--php-debugger-active`, `--php-debugger-paused` and `--php-debugger-error` on the editor's container to change them.
