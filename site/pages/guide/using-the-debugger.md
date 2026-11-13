---
title: &title "Using the debugger"
description: &description "What your readers see: the controls, the keys, breakpoints, values and output."
menus:
  docs:
    weight: &weight 30
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

# Using the debugger

This is the interface `mount()` builds, from top to bottom. The [example on the home page](../index.html#try) is a live one.

## Controls

<div class="table-scroll">

| Button    | Key         | What it does                                                        |
|-----------|-------------|---------------------------------------------------------------------|
| Run       | F8          | Start the program.                                                  |
| Continue  | F8          | Resume until the next breakpoint.                                   |
| Pause     |             | Pause the running program at its next line.                         |
| Step over | F10         | Run this line; a call it makes runs whole.                          |
| Step into | F11         | Run this line, entering a call it makes.                            |
| Step out  | Shift+F11   | Run until this function has returned to its caller.                 |
| Until     |             | Run until execution is past this line; at the end of a loop, finish the loop. |
| Leave     |             | Run to the end of this function and pause before it returns.        |
| Restart   |             | End this run and start again.                                       |
| Stop      |             | End this run.                                                       |

</div>

The button to press next is filled: **Run** before a run, **Continue** during a pause. The keys work while focus is anywhere inside the debugger, the source included. The **PHP** list picks the version for the next run; choosing another one during a run ends that run, and the status line says so.

## Status

The line under the controls says where things stand: `Paused at line 5 of /main.php, on a breakpoint.`, `Finished with exit code 0.`, `Loading PHP 8.4: 40% of 16.6 MB`. Screen readers hear it change.

## Breakpoints

Click a line number to set a breakpoint, and again to clear it. Or type a line in the **Line** box and press Enter. Each breakpoint is listed beside the box; untick one to keep it without stopping there.

From the keyboard, the line numbers are one tab stop: the arrow keys move along them, and Enter sets or clears the breakpoint on the line in focus.

When execution pauses, the line is marked across the whole editor and scrolled into view.

## Values

The tabs on the right show what is in scope while paused. **Variables**, **Frames** and **Watches** come first, each with a count of what it holds. After them come the whole program's **Globals**, **Constants**, **Functions**, **Classes** and **Files**. When the row is too narrow for every tab, the last ones move into **More**.

- An array or object opens when you click its name, and closes again. What you opened stays open as you step.
- **Edit** opens a box for a PHP expression. Enter applies it, Escape cancels. A value PHP refuses is explained under the box.
- **Frames** lists the call stack. Choosing a frame shows that call's variables and moves the marker to its line.

## Expressions

Type any PHP expression in the box at the bottom and press Enter. It is evaluated in the selected frame and can assign: `$total * 2`, `$item['price'] = 10`. **Watch** adds the expression to the Watches tab, where it is evaluated again at every pause.

A mistake in an expression is reported under the box and does not disturb the program: it runs on to its own exit code.

## Output

The left panel shows what the program prints, and each evaluated expression with its result. It starts empty for every run. **Debugger log** adds phpdbg's own messages; **Clear** empties the panel.

## On a phone

The controls become one row that scrolls sideways and stays at the top of the screen while the debugger is in view, so **Continue** and the step buttons are in reach from the values. Buttons and boxes are sized for a finger.
