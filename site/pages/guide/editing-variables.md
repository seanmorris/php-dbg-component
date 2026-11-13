---
title: "Edit variables from JavaScript"
description: "Change a value at a breakpoint and continue with it."
menus:
  docs:
    weight: 40
---

# Edit variables from JavaScript

Everything the interface does, your code can do. With the `dbg` from [Get started](getting-started.html), start a run without awaiting its end, wait for the breakpoint, then assign a PHP expression to a variable:

```javascript
const done = dbg.run();
await dbg.whenPaused();

const locals = await dbg.inspect('variables');
const n = locals.find(value => value.name === 'n');

await dbg.setVariable(n.reference, '40');

await dbg.setBreakpoints([]);
await dbg.continue();

const result = await done;
console.log(result.stdout); // "43"
```

## Inside arrays and objects

`children(reference)` lists what an array or object holds, a hundred entries at a time. Each child has its own reference, and the writable ones can be set the same way:

```javascript
const item = locals.find(value => value.name === 'item');
const {values} = await dbg.children(item.reference);
const price = values.find(value => value.name === 'price');

await dbg.setVariable(price.reference, '10');
```

## Expressions

`evaluate(expression)` runs any PHP expression in the paused frame and resolves to its value. It can assign: `await dbg.evaluate('$settings["enabled"] = true')`.

A syntax error or an uncaught exception rejects the promise with a message about the expression, such as `syntax error, unexpected end of expression` or `Error: Call to undefined function nope()`. The program is not affected.

## Frames

`selectFrame(index)` chooses the call that `inspect()` and `evaluate()` look at. Frame 0 is the innermost; `inspect('frames')` lists them.

## References expire

A reference is good for one pause. After a step, a continue or the end of the run, inspect again. PHP still enforces visibility, types and readonly properties; an edit it refuses rejects with PHP's own message.
