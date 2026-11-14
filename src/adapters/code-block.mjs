/**
 * Debug code already on the page, as a highlighter left it: highlight.js's <pre><code class=hljs>,
 * Pandoc's <div class=sourceCode> with a span for each line, as SMGen builds it, or a plain
 * <pre><code>. Each line gets a number to click for a breakpoint, and the line where execution
 * pauses is marked. Nothing is imported: the highlighting has already been done.
 */
export function createCodeBlockAdapter(block, {file = '/main.php', highlight = null} = {})
{
	const code = block.localName === 'code' ? block : block.querySelector('code') ?? block;
	const listeners = new Set();
	// What the block held, given back by dispose(): its nodes, and each line's classes as they
	// were. Nothing is set on the block itself.
	let original = [...code.childNodes];
	let classes = [];
	let lines = [];
	let buttons = [];
	let marked = [];
	let active = null;
	let disposed = false;

	/** Number the lines, a button before each, and mark the breakpoints set on them. */
	const build = () => {
		lines = lineElements(code);
		classes = lines.map(line => line.getAttribute('class'));

		// The numbers are as wide as the longest of them.
		const digits = String(String(lines.length).length);

		buttons = lines.map((line, index) => {
			const button = document.createElement('button');

			button.style.setProperty('--php-debugger-code-digits', digits);
			button.type = 'button';
			button.className = 'php-debugger-code-gutter';
			button.dataset.line = String(index + 1);
			button.tabIndex = index ? -1 : 0;
			button.setAttribute('aria-label', `Breakpoint on line ${index + 1}`);
			button.setAttribute('aria-pressed', 'false');
			line.classList.add('php-debugger-code-line');
			line.prepend(button);

			return button;
		});

		mark(marked);
	};

	/** Take the numbers and marks out, leaving the lines as the highlighter left them. */
	const unbuild = () => {
		for(const button of buttons)
		{
			button.remove();
		}

		lines.forEach((line, index) => restore(line, 'class', classes[index]));
	};

	/** Show which lines have breakpoints, and what kind. */
	const mark = breakpoints => {
		marked = breakpoints;

		buttons.forEach((button, index) => {
			const bp = breakpoints.find(b => b.line === index + 1);

			button.setAttribute('aria-pressed', String(!!bp));
			button.dataset.log = String(!!bp?.log);
			button.dataset.condition = String(!!bp?.condition);
		});
	};

	/** A click on a line's number sets or clears the breakpoint there. */
	const click = event => {
		const button = event.target.closest?.('.php-debugger-code-gutter');

		if(!button || !buttons.includes(button))
		{
			return;
		}

		const line = Number(button.dataset.line);
		const set = marked.map(bp => bp.line);
		const next = set.includes(line) ? set.filter(n => n !== line) : [...set, line];

		for(const listener of listeners)
		{
			listener(next.map(n => ({file, line: n})));
		}
	};

	/** The arrow keys, Home and End move along the numbers, which are one tab stop. */
	const keydown = event => {
		const at = buttons.indexOf(event.target);

		const to = {
			ArrowDown: at + 1
			, ArrowUp: at - 1
			, Home: 0
			, End: buttons.length - 1
		}[event.key];

		if(at < 0 || to === undefined || !buttons[to])
		{
			return;
		}

		event.preventDefault();

		for(const button of buttons)
		{
			button.tabIndex = button === buttons[to] ? 0 : -1;
		}

		buttons[to].focus();
	};

	code.addEventListener('click', click);
	code.addEventListener('keydown', keydown);
	build();

	return {
		element: code.closest('div.sourceCode') ?? code.closest('pre') ?? code

		, layout(){
			// The block measures itself; there is nothing to do when it moves.
		}

		/** The numbers hold no text of their own, so the block's text is the code. */
		, getCode: () => code.textContent

		, setCode(text){
			// New code replaces the block's text, and `highlight`, when given, colours it again.
			if(disposed)
			{
				return;
			}

			unbuild();
			code.textContent = text;
			delete code.dataset.highlighted;
			highlight?.(code);
			original = [...code.childNodes];
			build();
			this.showLocation(active);
		}

		, onBreakpointChange(listener){
			listeners.add(listener);

			return() => listeners.delete(listener);
		}

		, setBreakpoints(breakpoints){
			if(!disposed)
			{
				mark(breakpoints.filter(bp => bp.file === file && bp.enabled));
			}
		}

		, showLocation(location){
			for(const line of lines)
			{
				line.classList.remove('php-debugger-active-line');
			}

			active = location;
			const line = location?.file === file ? lines[location.line - 1] : null;

			if(line && !disposed)
			{
				line.classList.add('php-debugger-active-line');
				line.scrollIntoView({block: 'nearest'});
			}
		}

		, dispose(){
			if(disposed)
			{
				return;
			}

			disposed = true;
			code.removeEventListener('click', click);
			code.removeEventListener('keydown', keydown);
			unbuild();
			code.replaceChildren(...original);
			listeners.clear();
		}
	};
}

/** Put an attribute back as it was, absent included. */
function restore(element, name, value)
{
	return value === null ? element.removeAttribute(name) : element.setAttribute(name, value);
}

/**
 * The element for each line of a code block. Pandoc already wraps each line in a span of its own,
 * with nothing between them but line breaks; anything else, highlight.js's tokens included, is
 * split at its line breaks into a span for each line, and a token that spans lines is cut in two
 * with its class kept on both halves.
 */
function lineElements(code)
{
	const nodes = [...code.childNodes];

	const own = nodes.length && nodes.every(
		(node, index) => index % 2
			? node.nodeType === Node.TEXT_NODE && node.textContent === '\n'
			: node.localName === 'span' && !node.textContent.includes('\n')
	);

	if(own)
	{
		return nodes.filter(node => node.nodeType === Node.ELEMENT_NODE);
	}

	const lines = [document.createElement('span')];
	// The tokens open where the copy has got to: each source token, and its copy on this line.
	let stack = [];
	let cursor = lines[0];

	/** Open a copy of a token where the copy has got to. */
	const open = source => {
		const copy = source.cloneNode(false);

		cursor.append(copy);
		stack.push({source, copy});
		cursor = copy;
	};

	/** Close the innermost token. */
	const close = () => {
		stack.pop();
		cursor = stack.at(-1)?.copy ?? lines.at(-1);
	};

	/** Start a line, and open again in it every token still open at the break. */
	const newline = () => {
		const sources = stack.map(entry => entry.source);

		lines.push(document.createElement('span'));
		cursor = lines.at(-1);
		stack = [];
		sources.forEach(open);
	};

	/** Copy a node's children, starting a line at each line break. */
	const walk = node => {
		for(const child of [...node.childNodes])
		{
			if(child.nodeType === Node.ELEMENT_NODE)
			{
				open(child);
				walk(child);
				close();

				continue;
			}

			child.textContent.split('\n').forEach((part, index) => {
				if(index)
				{
					newline();
				}

				if(part)
				{
					cursor.append(part);
				}
			});
		}
	};

	walk(code);

	// Text that ends with a line break has no last line to number; the break stays.
	const trailing = lines.length > 1 && !lines.at(-1).textContent;

	if(trailing)
	{
		lines.pop();
	}

	code.replaceChildren(
		...lines.flatMap((line, index) => index ? ['\n', line] : [line])
		, ...trailing ? ['\n'] : []
	);

	return lines;
}
