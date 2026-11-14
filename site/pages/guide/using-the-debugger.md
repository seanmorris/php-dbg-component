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

The line at the bottom of the debugger says where things stand: `Paused at line 5 of /main.php, on a breakpoint.`, `Finished with exit code 0.`, `Loading PHP 8.4: 40% of 16.6 MB`. Screen readers hear it change.

## Breakpoints

Click a line number to set a breakpoint, and again to clear it. Or open the **Breakpoints** tab on the right, type a line in the **Line** box and press Enter. The tab lists every breakpoint, before a run as well as during one. Untick a breakpoint to keep it without stopping there, or remove it with ×.

From the keyboard, the line numbers are one tab stop: the arrow keys move along them, and Enter sets or clears the breakpoint on the line in focus.

**Edit** on a breakpoint's row takes two PHP expressions, each optional. A **Condition** must be true for the breakpoint to act, so `$i === 3` stops a loop on its fourth time round. A **Log message** makes it a logpoint: execution goes on, and the value is printed in the output, after the line it came from. With both, it logs only when the condition holds. A sentence under the boxes says what the breakpoint will do as you type. Enter applies, Escape cancels. A logpoint's mark beside the line number is a diamond, and a breakpoint with a condition is drawn hollow.

When execution pauses, the line is marked across the whole editor and scrolled into view.

## Values

The tabs on the right show what is in scope while paused. **Variables**, **Frames**, **Opcodes**, **Watches** and **Breakpoints** come first; all but Opcodes count what they hold. After them come the whole program's **Globals**, **Constants**, **Functions**, **Classes** and **Files**. When the row is too narrow for every tab, the last ones move into **More**. The panel under the tabs is always as tall as the output beside it.

- An array or object opens when you click its name, and closes again. What you opened stays open as you step.
- **Edit** opens a box for a PHP expression. Enter applies it, Escape cancels. A value PHP refuses is explained under the box.
- **Frames** lists the call stack, a row per call. Choosing a frame shows that call's variables and moves the marker to its line.
- **Frames**, **Functions**, **Classes** and **Files** are lists of rows. Click a row, or reach the list with Tab, move along it with the arrow keys and press Enter. A function, class or file shows where it is in the source.
- **Opcodes** shows what PHP compiled the paused function to, as phpdbg's `print` command lists it, with the op the frame stands on marked like the paused line. Each op's number comes first; where an op can jump, its target is a link to that op. Choose a frame to see its function, or pick the main script, a function or a class from the list above the table.

## Expressions

Type any PHP expression in the box at the bottom and press Enter. It is evaluated in the selected frame and can assign: `$total * 2`, `$item['price'] = 10`. **Watch** adds the expression to the Watches tab, where it is evaluated again at every pause.

A mistake in an expression is reported under the box and does not disturb the program: it runs on to its own exit code.

## Output

The left panel shows what the program prints, and each evaluated expression with its result. It starts empty for every run. **Debugger log** adds phpdbg's own messages; **Clear** empties the panel.

## On a phone

The controls become one row that scrolls sideways and stays at the top of the screen while the debugger is in view, so **Continue** and the step buttons are in reach from the values. Buttons and boxes are sized for a finger.
