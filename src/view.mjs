import {versions, phpClassLabel, typeLabel, operandParts, isPhpName} from './model.mjs';

let views = 0;

function node(tag, className, text)
{
	const n = document.createElement(tag);

	if(className)
	{
		n.className = className;
	}

	if(text !== undefined)
	{
		n.textContent = text;
	}

	return n;
}

/** What an inspector panel is called on its tab: "variables" is "Variables". */
function panelTitle(scope)
{
	return scope[0].toUpperCase() + scope.slice(1);
}

/** What the Opcodes panel's choice asks opcodes() for: "function:total" is {function: 'total'}. */
function opcodeTarget(choice)
{
	const [kind, name] = choice.split(/:(.*)/);

	return kind === 'frame' ? {} : kind === 'script' ? {script: true} : {[kind]: name};
}

export class DebuggerView
{

	constructor(debuggerInstance, host)
	{
		if(!host?.append)
		{
			throw new TypeError('mount needs a DOM element');
		}

		this.dbg = debuggerInstance;
		this.host = host;
		this.id = `php-debugger-${++views}`;
		this.abort = new AbortController();
		this.panel = 'variables';

		// What the Opcodes panel lists: "frame", "script", "function:name" or "class:name".
		this.opcodeChoice = 'frame';
		this.refreshNumber = 0;
		this.watches = [];
		// Which values are open, by their path of names from the panel down, so the tree comes back
		// as it was after an edit or a step.
		this.expanded = new Set();
		// The inspector's list is rebuilt whenever it may have changed. Each of its controls has a
		// key, so focus can go back to the same control in the new list.
		this.rows = new Map();
		this.controlKeys = new WeakMap();
		const dbg = this.dbg;

		this.root = node('section', 'php-debugger');
		this.root.setAttribute('aria-label', 'PHP debugger');
		host.append(this.root);

		this.toolbar = node('div', 'php-debugger-toolbar');
		this.toolbar.setAttribute('role', 'toolbar');
		this.toolbar.setAttribute('aria-label', 'Debugger controls');
		this.root.append(this.toolbar);
		this.buttons = new Map();
		this.shortcuts = new Map();

		// What each control does, for its tooltip.
		const purposes = {
			Run: 'Start the program'
			, Continue: 'Resume until the next breakpoint'
			, Pause: 'Pause the running program at its next line'

			, 'Step over': 'Run this line; a call it makes runs whole'
			, 'Step into': 'Run this line, entering a call it makes'
			, 'Step out': 'Run until this function has returned to its caller'
			, Until: 'Run until execution is past this line; at the end of a loop, finish the loop'
			, Leave: 'Run to the end of this function and pause before it returns'

			, Restart: 'End this run and start again'
			, Stop: 'End this run'
		};

		const keys = {
			Run: 'F8'
			, Continue: 'F8'
			, 'Step over': 'F10'
			, 'Step into': 'F11'
			, 'Step out': 'Shift+F11'
		};

		// Three groups: run, step, end.
		const running = [
			['Run', () => dbg.run()]
			, ['Continue', () => dbg.continue()]
			, ['Pause', () => dbg.pause()]
		];

		const stepping = [
			['Step over', () => dbg.stepOver()]
			, ['Step into', () => dbg.stepInto()]
			, ['Step out', () => dbg.stepOut()]
			, ['Until', () => dbg.until()]
			, ['Leave', () => dbg.leave()]
		];

		const ending = [['Restart', () => dbg.restart()], ['Stop', () => dbg.stop()]];

		for(const group of [running, stepping, ending])
		{
			const set = node('div', 'php-debugger-toolbar-group');

			set.setAttribute('role', 'group');
			this.toolbar.append(set);

			for(const [label, action] of group)
			{
				const button = node('button', 'php-debugger-button', label);
				const key = keys[label];

				button.type = 'button';
				button.title = purposes[label] + (key ? ` (${key})` : '');
				this.buttons.set(label, button);
				set.append(button);

				button.addEventListener(
					'click'
					, () => this.act(action)
					, {signal: this.abort.signal}
				);

				if(key)
				{
					button.setAttribute('aria-keyshortcuts', key);
					this.shortcuts.set(key, [...(this.shortcuts.get(key) || []), button]);
				}
			}
		}

		// While focus is anywhere in the debugger, a key presses whichever of its buttons is
		// available: F8 is Run before a run and Continue during a pause.
		this.root.addEventListener(
			'keydown'
			, event => {
				const key = (event.shiftKey ? 'Shift+' : '') + event.key;
				const modified = event.ctrlKey || event.altKey || event.metaKey;
				const button = modified ? null : this.shortcuts.get(key)?.find(b => !b.disabled);

				if(button)
				{
					event.preventDefault();
					button.click();
				}
			}
			, {signal: this.abort.signal}
		);

		const versionLabel = node('label', 'php-debugger-version-label', 'PHP ');

		this.version = node('select', 'php-debugger-version');
		versionLabel.append(this.version);

		for(const version of dbg.options.versions || versions)
		{
			const option = node('option', '', version);
			option.value = version;
			this.version.append(option);
		}

		this.version.value = dbg.options.version;

		this.version.addEventListener(
			'change'
			, () => this.act(
				async() => {
					const interrupted = !!dbg.active;

					await dbg.setVersion(this.version.value);

					if(interrupted)
					{
						this.status.textContent = 'Stopped: the PHP version is now '
							+ `${this.version.value}. Run starts again with it.`;
					}
				}
			)
			, {signal: this.abort.signal}
		);

		this.toolbar.append(versionLabel);

		// The status line and what went wrong; both close the box, under the expression box.
		this.status = node('output', 'php-debugger-status');
		this.status.setAttribute('aria-live', 'polite');
		this.message = node('div', 'php-debugger-message');
		this.message.setAttribute('role', 'alert');

		// A textarea the page put inside the mount point, as in <php-debugger><textarea>, is the
		// editor: it moves into the interface and gets the line numbers. One elsewhere on the page
		// is the page's to lay out and stays where it is.
		const adopted = dbg.source?.localName === 'textarea' && host.contains(dbg.source)
			? dbg.source
			: null;

		if(adopted || (!dbg.source && typeof dbg.options.code !== 'function'))
		{
			const editor = node('div', 'php-debugger-editor');

			this.editor = editor;
			this.gutter = node('div', 'php-debugger-gutter');

			if(adopted)
			{
				this.textarea = adopted;

				// What destroy() puts back.
				this.adopted = {
					parent: adopted.parentNode
					, next: adopted.nextSibling
					, readOnly: adopted.readOnly
					, spellcheck: adopted.getAttribute('spellcheck')
					, label: adopted.getAttribute('aria-label')
				};

				adopted.classList.add('php-debugger-source');

				if(!adopted.labels.length && !adopted.hasAttribute('aria-labelledby'))
				{
					adopted.setAttribute('aria-label', this.adopted.label || 'PHP source');
				}
			}
			else
			{
				this.textarea = node('textarea', 'php-debugger-source');
				this.textarea.setAttribute('aria-label', 'PHP source');
				this.textarea.value = typeof dbg.options.code === 'string' ? dbg.options.code : '';
				// Keep getters authoritative; the textarea is only an editor for string sources.
				dbg.source = this.textarea;
			}

			this.textarea.spellcheck = false;

			this.textarea.addEventListener(
				'input'
				, () => this.gutterUpdate()
				, {signal: this.abort.signal}
			);

			this.textarea.addEventListener(
				'scroll'
				, () => {this.gutter.scrollTop = this.textarea.scrollTop;}
				, {signal: this.abort.signal}
			);

			// Focus moving to a line number outside the view scrolls the gutter; take the source
			// along.
			this.gutter.addEventListener(
				'scroll'
				, () => {
					if(Math.abs(this.textarea.scrollTop - this.gutter.scrollTop) >= 1)
					{
						this.textarea.scrollTop = this.gutter.scrollTop;
					}
				}
				, {signal: this.abort.signal}
			);

			// The line numbers are one tab stop. The arrow keys move along them, and Enter or Space
			// sets or clears the breakpoint on the line in focus.
			this.gutter.setAttribute('role', 'group');
			this.gutter.setAttribute('aria-label', 'Breakpoints by line');
			this.gutterLine = 1;

			this.gutter.addEventListener(
				'focusin'
				, event => this.gutterStop(Number(event.target.textContent))
				, {signal: this.abort.signal}
			);

			this.gutter.addEventListener(
				'keydown'
				, event => {
					const last = this.gutter.children.length;

					const to = {
						ArrowDown: this.gutterLine + 1
						, ArrowUp: this.gutterLine - 1
						, PageDown: this.gutterLine + 10
						, PageUp: this.gutterLine - 10
						, Home: 1
						, End: last
					}[event.key];

					if(to !== undefined)
					{
						event.preventDefault();
						this.gutter.children[Math.min(Math.max(to, 1), last) - 1].focus();
					}
				}
				, {signal: this.abort.signal}
			);

			editor.append(this.gutter, this.textarea);
			this.root.append(editor);
		}
		else if(dbg.source?.element && host.contains(dbg.source.element))
		{
			this.hostEditor(dbg.source);
		}

		// The Breakpoints panel, one of the inspector's: the box to add one, then the list. It is
		// placed with the other panels below.
		this.breakpoints = node('div', 'php-debugger-breakpoints');
		this.breakpoints.id = `${this.id}-breakpoints`;
		this.breakpoints.setAttribute('role', 'tabpanel');
		this.breakpoints.setAttribute('aria-label', 'Breakpoints');
		this.breakpoints.hidden = true;
		const breakpointForm = node('form', 'php-debugger-breakpoint-form');
		const lineInput = node('input', 'php-debugger-breakpoint-line');
		const add = node('button', 'php-debugger-button', 'Add breakpoint');

		this.breakpointLine = lineInput;
		this.breakpointError = node('div', 'php-debugger-breakpoint-error');
		this.breakpointError.id = `${this.id}-breakpoint-error`;
		this.breakpointError.setAttribute('role', 'alert');
		lineInput.type = 'number';
		lineInput.min = '1';
		lineInput.placeholder = 'Line';
		lineInput.setAttribute('aria-label', 'Breakpoint line');
		lineInput.setAttribute('aria-describedby', this.breakpointError.id);
		add.type = 'submit';

		// A form, so Enter in the box adds the breakpoint.
		breakpointForm.addEventListener(
			'submit'
			, event => {
				event.preventDefault();
				void this.addBreakpoint();
			}
			, {signal: this.abort.signal}
		);

		lineInput.addEventListener(
			'input'
			, () => this.breakpointProblem('')
			, {signal: this.abort.signal}
		);

		this.breakpointList = node('ul', 'php-debugger-breakpoint-list');
		this.breakpointList.setAttribute('aria-label', 'Breakpoints');
		breakpointForm.append(lineInput, add, this.breakpointError);
		this.breakpoints.append(breakpointForm, this.breakpointList);

		const body = node('div', 'php-debugger-body');
		this.root.append(body);
		const output = node('div', 'php-debugger-console-panel');
		body.append(output);

		const bar = node('div', 'php-debugger-console-bar');
		const log = node('label', 'php-debugger-log-toggle');
		const clear = node('button', 'php-debugger-clear', 'Clear');

		this.debugLog = node('input');
		this.debugLog.type = 'checkbox';
		log.append(this.debugLog, ' Debugger log');
		clear.type = 'button';
		clear.title = 'Clear the output shown here';
		clear.addEventListener('click', () => this.clearConsole(), {signal: this.abort.signal});
		bar.append(log, clear);

		this.console = node('pre', 'php-debugger-console');
		this.console.setAttribute('aria-label', 'PHP and debugger output');
		this.console.tabIndex = 0;
		this.console.dataset.debug = 'false';
		this.console.dataset.placeholder = 'Output from the program appears here.';
		this.console.dataset.empty = 'true';
		output.append(bar, this.console);

		// The hidden attribute, not a stylesheet rule, so hosts that bring their own CSS get the
		// same default.
		this.debugLog.addEventListener('change', () => {
			this.console.dataset.debug = String(this.debugLog.checked);

			for(const notice of this.console.querySelectorAll('.php-debugger-output-notice'))
			{
				notice.hidden = !this.debugLog.checked;
			}

			this.consoleShown();
			this.console.scrollTop = this.console.scrollHeight;
		}, {signal: this.abort.signal}
		);

		const right = node('div', 'php-debugger-inspector');
		body.append(right);

		// The tabs: what the pause has in scope and what you set to watch it, then the whole
		// program's tables. When the row is too narrow, the last of those fold into More.
		this.tabBar = node('div', 'php-debugger-tabs');
		this.tabs = node('div', 'php-debugger-tablist');
		this.tabs.setAttribute('role', 'tablist');
		this.tabs.setAttribute('aria-label', 'Inspect');
		this.tabList = [];
		this.counts = {};

		for(const [group, scopes] of [
			['pause', ['variables', 'frames', 'opcodes', 'watches', 'breakpoints']]
			, ['program', ['globals', 'constants', 'functions', 'classes', 'files']]
		]){
			if(group === 'program')
			{
				const divider = node('span', 'php-debugger-tab-divider');

				divider.setAttribute('aria-hidden', 'true');
				this.tabs.append(divider);
			}

			for(const scope of scopes)
			{
				this.tabList.push(this.tab(scope, group));
			}
		}

		this.more = node('select', 'php-debugger-tab-more');
		this.more.id = `${this.id}-tab-more`;
		this.more.setAttribute('aria-label', 'More panels');
		this.more.hidden = true;

		this.more.addEventListener(
			'change'
			, () => this.more.value && this.showPanel(this.more.value)
			, {signal: this.abort.signal}
		);

		// A select is as wide as its longest option. This copy, never seen, measures the one name
		// More shows, so More can be as wide as that.
		this.moreSizer = node('select', 'php-debugger-tab-more php-debugger-tab-sizer');
		this.moreSizer.append(node('option'));
		this.moreSizer.setAttribute('aria-hidden', 'true');
		this.moreSizer.tabIndex = -1;

		this.tabBar.append(this.tabs, this.more, this.moreSizer);
		right.append(this.tabBar);

		// The row is fitted again when its width changes, a frame later, so that folding a tab
		// never resizes the row inside the observer's own callback.
		if(globalThis.ResizeObserver)
		{
			this.tabResize = new ResizeObserver(([entry]) => {
				if(entry.contentRect.width !== this.tabWidth)
				{
					this.tabWidth = entry.contentRect.width;
					requestAnimationFrame(() => this.fitTabs());
				}
			});

			this.tabResize.observe(this.tabBar);
		}

		// The labels may be measured before the page's font has loaded.
		document.fonts?.ready.then(() => this.tabBar.isConnected && this.fitTabs());

		// One tab stop for the row; the arrow keys move along the tabs on show and show each panel.
		this.tabs.addEventListener(
			'keydown'
			, event => {
				const tabs = this.tabList.filter(tab => !tab.hidden);
				const at = tabs.indexOf(event.target);

				const to = {
					ArrowRight: (at + 1) % tabs.length
					, ArrowLeft: (at + tabs.length - 1) % tabs.length
					, Home: 0
					, End: tabs.length - 1
				}[event.key];

				if(to !== undefined)
				{
					event.preventDefault();
					tabs[to].focus();
					this.showPanel(tabs[to].dataset.panel);
				}
			}
			, {signal: this.abort.signal}
		);

		this.content = node('div', 'php-debugger-values');
		this.content.setAttribute('role', 'tabpanel');
		this.content.tabIndex = -1;
		right.append(this.content, this.breakpoints);

		const form = node('form', 'php-debugger-expression-form');
		this.expression = node('input', 'php-debugger-expression');
		this.expression.setAttribute('aria-label', 'PHP expression');
		this.expression.placeholder = 'PHP expression';

		const evaluate = node('button', 'php-debugger-button', 'Evaluate');
		evaluate.type = 'submit';
		const watch = node('button', 'php-debugger-button', 'Watch');
		watch.type = 'button';

		// What went wrong with an expression is said here, next to where it was typed.
		this.expressionError = node('div', 'php-debugger-expression-error');
		this.expressionError.id = `${this.id}-expression-error`;
		this.expressionError.setAttribute('role', 'alert');
		this.expression.setAttribute('aria-describedby', this.expressionError.id);

		form.append(this.expression, evaluate, watch, this.expressionError);
		this.root.append(form, this.message, this.status);

		form.addEventListener(
			'submit'
			, event => {
				event.preventDefault();
				void this.evaluateExpression();
			}
			, {signal: this.abort.signal}
		);

		this.expression.addEventListener(
			'input'
			, () => this.expressionProblem('')
			, {signal: this.abort.signal}
		);

		watch.addEventListener(
			'click'
			, () => {
				const expression = this.expressionEntered();

				if(expression)
				{
					this.watches.push(expression);
					this.showCounts(this.counts);
					this.showPanel('watches');
				}
			}
			, {signal: this.abort.signal}
		);

		const on = (type, callback) => dbg.addEventListener(
			type
			, event => callback(event.detail)
			, {signal: this.abort.signal}
		);

		on('statechange', () => this.update());
		on('testresult', () => this.update());
		on('output', event => this.appendOutput(event));

		// What a logpoint printed, after where it is.
		on('log', entry => this.appendOutput({
			channel: 'log'
			, kind: entry.error ? 'error' : undefined
			, text: `${this.breakpointPlace(entry)}: ${entry.message}\n`
		}));

		on('progress', progress => this.showProgress(progress));

		on(
			'pause'
			, event => {
				this.pauseReason = event.reason;
				this.update();
				void this.refresh();
			}
		);

		on('framechange', () => void this.refresh());
		on('variablechange', () => void this.refresh());
		on('breakpointchange', () => this.gutterUpdate());

		on(
			'locationchange'
			, location => {
				this.showLocation(location);
				this.status.textContent = this.statusText();
			}
		);

		on('sourcechange', () => this.gutterUpdate());
		on('versionchange', () => {this.version.value = dbg.options.version;});

		on(
			'complete'
			, result => {
				if(result.test.status === 'failed')
				{
					// A failure is a value that differed, or a message alone.
					this.message.textContent = result.test.failures.map(
						f => 'message' in f
							? `${f.field}: ${f.message}`
							: `${f.field}: expected ${f.expected}, received ${f.actual ?? ''}`
					).join('\n');
				}

				if(result.status === 'error')
				{
					this.message.textContent = result.diagnostics.map(d => d.message).join('\n');
				}
			}
		);

		this.adapterUnsubscribe = dbg.source?.onBreakpointChange?.(
			lines => this.act(() => dbg.setBreakpoints(this.fromEditor(lines)))
		);

		this.fitTabs();
		this.gutterUpdate();
		this.update();
	}

	/**
	 * The breakpoints once an editor's gutter has changed the entrypoint's to `lines`. A line that
	 * already had a breakpoint keeps its condition and its log; a disabled one the gutter does not
	 * show stays as it is.
	 */
	fromEditor(lines)
	{
		const dbg = this.dbg;
		const entrypoint = dbg.options.entrypoint;
		const numbers = lines.map(line => typeof line === 'number' ? line : line.line);

		/** The entrypoint's breakpoint on a line, if it has one. */
		const here = line => dbg.breakpoints.find(bp => bp.file === entrypoint && bp.line === line);

		return [
			...dbg.breakpoints.filter(
				bp => bp.file !== entrypoint || (!bp.enabled && !numbers.includes(bp.line))
			)
			, ...numbers.map(line => ({...here(line), line, enabled: true}))
		];
	}

	showPanel(panel)
	{
		this.panel = panel;

		// More may now show a longer name than before.
		this.fitTabs();
		void this.refresh();
	}

	/** One inspector tab: its title, then how many things it holds once that is known. */
	tab(scope, group)
	{
		const tab = node('button', 'php-debugger-tab');

		tab.type = 'button';
		tab.id = `${this.id}-tab-${scope}`;
		tab.setAttribute('role', 'tab');
		tab.dataset.panel = scope;
		tab.dataset.group = group;
		tab.append(panelTitle(scope), ' ', node('span', 'php-debugger-tab-count'));
		tab.addEventListener('click', () => this.showPanel(scope), {signal: this.abort.signal});
		this.tabs.append(tab);

		return tab;
	}

	/**
	 * Say which tab's panel is showing. Only that tab is a tab stop; when it has folded into More,
	 * the first tab on show is.
	 */
	markTabs()
	{
		const shown = this.tabList.find(tab => tab.dataset.panel === this.panel);
		const stop = shown.hidden ? this.tabList.find(tab => !tab.hidden) : shown;

		for(const tab of this.tabList)
		{
			tab.setAttribute('aria-selected', String(tab === shown));
			tab.tabIndex = tab === stop ? 0 : -1;
		}

		// The Breakpoints panel is its own; every other tab shows in the values panel.
		this.breakpoints.hidden = this.panel !== 'breakpoints';
		this.content.hidden = !this.breakpoints.hidden;
		this.content.setAttribute('aria-label', panelTitle(this.panel));
		this.fillMore();
	}

	/**
	 * Fold tabs into More, last first, until the row fits, and unfold them when it has room: the
	 * program's tables, then Breakpoints, Watches and Frames at the narrowest. Variables always
	 * stays.
	 */
	fitTabs()
	{
		const foldable = this.tabList.filter(tab => tab.dataset.panel !== 'variables');

		/** Whether the row is wider than its place. */
		const overflows = () => this.tabBar.scrollWidth > this.tabBar.clientWidth;

		for(const tab of foldable)
		{
			tab.hidden = false;
		}

		this.more.hidden = true;

		if(overflows())
		{
			this.more.hidden = false;
			this.sizeMore('More');

			for(const tab of foldable.reverse())
			{
				if(!overflows())
				{
					break;
				}

				tab.hidden = true;

				// From here on More shows the panel's name.
				if(tab.dataset.panel === this.panel)
				{
					this.sizeMore(panelTitle(this.panel));
				}
			}
		}

		this.markTabs();
	}

	/** Make More as wide as the name it shows. */
	sizeMore(label)
	{
		this.moreSizer.firstChild.textContent = label;
		this.more.style.width = this.moreSizer.offsetWidth ? `${this.moreSizer.offsetWidth}px` : '';
	}

	/** List the folded tabs in More. While one of their panels is showing, More shows its name. */
	fillMore()
	{
		const folded = this.tabList.filter(tab => tab.hidden);
		const placeholder = node('option', '', 'More');

		placeholder.value = '';
		placeholder.hidden = true;

		const options = folded.map(tab => {
			const option = node('option', '', panelTitle(tab.dataset.panel));

			option.value = tab.dataset.panel;

			return option;
		});

		this.more.replaceChildren(placeholder, ...options);
		this.more.value = options.some(option => option.value === this.panel) ? this.panel : '';
		this.more.dataset.selected = String(this.more.value !== '');
		this.sizeMore(this.more.selectedOptions[0].textContent);
	}

	/**
	 * Put the counts on their tabs. Watches and breakpoints are counted here, at any time; no count
	 * is shown for none.
	 */
	showCounts(counts)
	{
		this.counts = counts;

		const own = {watches: this.watches.length, breakpoints: this.dbg.breakpoints.length};

		for(const tab of this.tabList)
		{
			const scope = tab.dataset.panel;
			const count = own[scope] ?? counts[scope];

			tab.querySelector('.php-debugger-tab-count').textContent = count ? String(count) : '';
		}

		this.fitTabs();
	}

	/**
	 * The Opcodes panel: what to list, the paused frame's function by default, then a table of
	 * ops for each function phpdbg's print lists. The op the frame stands on is kept in view.
	 *
	 * A listing that is the one last shown keeps its tables, and only the mark of the op the
	 * frame stands on moves: the panel stays where it was scrolled to, and a step within a
	 * function builds nothing.
	 */
	async showOpcodes(generation)
	{

		/** Whether this refresh is still the one to show. */
		const wanted = () => generation === this.refreshNumber && this.dbg.state === 'paused';

		/** A choice's listing, or an empty one and why phpdbg has none. */
		const listed = choice => this.dbg.opcodes(opcodeTarget(choice)).then(
			listing => ({listing})
			, error => ({listing: {functions: [], current: null}, problem: error.message})
		);

		let {listing, problem} = await listed(this.opcodeChoice);

		if(!wanted())
		{
			return;
		}

		// A choice phpdbg cannot list is given up for the paused frame, and the reason is shown.
		if(problem && this.opcodeChoice !== 'frame')
		{
			this.opcodeChoice = 'frame';
			({listing} = await listed('frame'));
		}

		/** The names in a list of symbols, keyed by name or names alone, that can be asked for. */
		const names = list => (Array.isArray(list) ? list : Object.values(list)).map(
			entry => typeof entry === 'string' ? entry : entry.name
		).filter(isPhpName);

		const functions = names(await this.dbg.inspect('functions'));
		const classes = names(await this.dbg.inspect('classes'));

		if(!wanted())
		{
			return;
		}

		const signature = JSON.stringify(
			[this.opcodeChoice, listing.functions, functions, classes]
		);

		const kept = this.opcodesShown?.signature === signature;

		const shown = kept
			? this.opcodesShown
			: {signature, ...this.opcodeParts(listing, functions, classes)};

		const attached = kept && this.content.contains(shown.bar);
		const stands = JSON.stringify(listing.current);
		const moved = shown.stands !== stands;

		this.opcodesShown = Object.assign(shown, {stands});

		if(!attached)
		{
			const held = this.holdFocus();

			// What a jump marked belongs to the listing as it was last looked at.
			for(const marked of shown.tables.flatMap(table => [...table.rows]))
			{
				marked.removeAttribute('data-jumped');
			}

			this.rows = shown.rows;
			this.content.replaceChildren(shown.bar, ...shown.tables, ...shown.empty);
			this.returnFocus(held);
		}

		if(shown.tables.length)
		{
			this.markCurrentOp(shown.tables[0], listing.functions[0].ops, listing.current);
		}

		const here = this.content.querySelector('tr[aria-current]');

		if(here && (!attached || moved))
		{
			this.keepInView(here);
		}

		if(problem)
		{
			throw new Error(problem);
		}
	}

	/**
	 * The Opcodes panel's parts for a listing: the bar that chooses what is listed, a table for
	 * each function, and words in their place when there is none.
	 */
	opcodeParts(listing, functions, classes)
	{
		const rows = new Map();
		const bar = node('div', 'php-debugger-opcodes-bar');
		const label = node('label', 'php-debugger-opcodes-label', 'Opcodes of ');
		const picker = node('select', 'php-debugger-opcodes-scope');

		const choices = [
			['frame', 'the paused frame']
			, ['script', 'the main script']
			, ...functions.map(name => [`function:${name}`, `${name}()`])
			, ...classes.map(name => [`class:${name}`, `class ${name}`])
		];

		for(const [value, text] of choices)
		{
			const option = node('option', '', text);

			option.value = value;
			picker.append(option);
		}

		picker.value = this.opcodeChoice;

		picker.addEventListener('change', () => {
			this.opcodeChoice = picker.value;
			void this.refresh();
		});

		this.control(rows, 'opcodes of', picker);
		label.append(picker);
		bar.append(label);

		const tables = listing.functions.map((listed, at) => this.opcodeTable(listed, at));
		const chosen = picker.selectedOptions[0]?.textContent ?? 'this';

		// A class may have no PHP of its own: an interface, or one whose methods are inherited.
		const empty = tables.length
			? []
			: [node('p', 'php-debugger-empty', `No opcodes to list for ${chosen}.`)];

		return {rows, bar, tables, empty};
	}

	/**
	 * Mark the op the paused frame stands on among a function's rows, which are in the order of
	 * its ops. Where PHP 8.0 gives only the line, every op on it is marked.
	 */
	markCurrentOp(table, ops, current)
	{
		[...table.tBodies[0].rows].forEach((row, at) => {
			const {line, index} = ops[at];
			const here = current?.line === line && [null, index].includes(current.index);

			row.toggleAttribute('aria-current', here);

			if(here)
			{
				row.setAttribute('aria-current', 'step');
			}
		});
	}

	/** Scroll the panel so a row of it is a third of the way down. */
	keepInView(row)
	{
		const top = row.getBoundingClientRect().top - this.content.getBoundingClientRect().top;

		this.content.scrollTop += top - this.content.clientHeight / 3;
	}

	/**
	 * One function's ops as a table, numbered first, as jumps name them. A jump target is a link
	 * to its op.
	 */
	opcodeTable(listed, at)
	{
		const table = node('table', 'php-debugger-opcodes');
		const name = listed.name === '{main}' ? '{main}' : `${listed.name}()`;
		const caption = node('caption', '', name);
		const where = listed.file ? ` · ${listed.file}:${listed.start}–${listed.end}` : '';
		const summary = `${listed.ops.length} ops${where}`;
		const head = node('tr');
		const body = node('tbody');

		/** An op's number as the dumper writes it, and its row's id. */
		const number = index => String(index).padStart(4, '0');

		const id = index => `${this.id}-op-${at}-${index}`;

		caption.append(node('span', 'php-debugger-opcodes-where', summary));

		for(const title of ['Op', 'Line', 'Result', 'Opcode', 'Operands'])
		{
			const cell = node('th', '', title);

			cell.scope = 'col';
			head.append(cell);
		}

		for(const op of listed.ops)
		{
			const row = node('tr');
			const operands = node('td', 'php-debugger-opcode-operands');

			row.id = id(op.index);

			for(const part of operandParts(op, listed.ops.length))
			{
				if(part.jump === undefined)
				{
					operands.append(part.text);

					continue;
				}

				operands.append(this.jumpLink(number(part.jump), id(part.jump)));
			}

			row.append(
				node('td', 'php-debugger-opcode-index', number(op.index))
				, node('td', 'php-debugger-opcode-line', String(op.line))
				, node('td', 'php-debugger-opcode-result', op.result)
				, node('td', 'php-debugger-opcode', op.opcode)
				, operands
			);

			body.append(row);
		}

		table.append(caption, node('thead'), body);
		table.tHead.append(head);

		return table;
	}

	/**
	 * A link to the op a jump names. It brings that op into view and marks it, with focus on its
	 * number, without touching the page's address.
	 */
	jumpLink(text, target)
	{
		const link = node('a', 'php-debugger-opcode-jump', text);

		link.href = `#${target}`;
		link.setAttribute('aria-label', `Go to op ${Number(text)}`);

		link.addEventListener('click', event => {
			event.preventDefault();

			const row = this.content.querySelector(`#${CSS.escape(target)}`);

			// A target that is not listed leaves everything as it is.
			if(!row)
			{
				return;
			}

			const cell = row.cells[0];

			for(const marked of this.content.querySelectorAll('tr[data-jumped]'))
			{
				marked.removeAttribute('data-jumped');
			}

			row.dataset.jumped = 'true';
			cell.tabIndex = -1;
			cell.focus({preventScroll: true});
			this.keepInView(row);
		});

		return link;
	}

	/** With no pause there is nothing to inspect, so the panel says when there will be. */
	showIdle()
	{
		const waiting = {
			frames: 'The call stack appears here when the program pauses.'
			, watches: this.watches.length
				? 'Watches are evaluated when the program pauses.'
				: 'No watch expressions. Type one below and choose Watch.'
		}[this.panel] ?? `${panelTitle(this.panel)} appear here when the program pauses.`;

		this.rows = new Map();
		this.content.replaceChildren(node('p', 'php-debugger-empty', waiting));
	}

	/**
	 * Count the pause's variables and frames, reusing the panel that was just loaded when it is
	 * one of them. Only those two are counted: a count on another tab would widen it and refold
	 * the row.
	 */
	async recount(generation, loaded)
	{
		const counts = {};

		for(const scope of ['variables', 'frames'])
		{
			counts[scope] = loaded[scope]
				?? await this.dbg.inspect(scope).then(list => list.length, () => null);
		}

		if(generation === this.refreshNumber && this.dbg.state === 'paused')
		{
			this.showCounts(counts);
		}
	}

	expressionProblem(message)
	{
		this.expressionError.textContent = message;

		if(message)
		{
			this.expression.setAttribute('aria-invalid', 'true');
		}
		else
		{
			this.expression.removeAttribute('aria-invalid');
		}
	}

	/** The expression in the box, or nothing and a message beside the box when it is empty. */
	expressionEntered()
	{
		const expression = this.expression.value.trim();

		this.message.textContent = '';
		this.expressionProblem(expression ? '' : 'Enter a PHP expression, such as $total * 2.');

		return expression;
	}

	async evaluateExpression()
	{
		const expression = this.expressionEntered();

		if(!expression)
		{
			return;
		}

		if(this.dbg.state !== 'paused')
		{
			this.expressionProblem(
				'Expressions are evaluated where execution is paused. Set a breakpoint and run.'
			);

			return;
		}

		// The console keeps the exchange: the expression, anything it printed, then its value or
		// its error.
		this.appendOutput({channel: 'evaluation', kind: 'input', text: `> ${expression}\n`});

		try
		{
			const value = await this.dbg.evaluate(expression);

			this.appendOutput({channel: 'evaluation', text: value.displayValue + '\n'});
		}
		catch(error)
		{
			const message = error.message || String(error);

			this.appendOutput({channel: 'evaluation', kind: 'error', text: message + '\n'});
			this.expressionProblem(message);

			return;
		}

		await this.refresh();
	}

	/** Set a breakpoint on a line of the entrypoint, or remove the one that is there. */
	toggleBreakpoint(line)
	{
		const dbg = this.dbg;
		const file = dbg.options.entrypoint;

		const here = bp => bp.line === line && bp.file === file;

		return dbg.setBreakpoints(
			dbg.breakpoints.some(here)
				? dbg.breakpoints.filter(bp => !here(bp))
				: [...dbg.breakpoints, line]
		);
	}

	/** A watched expression's value, or what went wrong evaluating it. */
	watchValue(expression)
	{
		return this.dbg.evaluate(expression).then(
			value => ({...value, name: expression})
			, error => ({name: expression, displayValue: error.message, writable: false})
		);
	}

	/** Select a frame from the frame list; for a function, class or file, show where it is. */
	async openSymbol(value)
	{
		if(this.panel === 'frames')
		{
			await this.dbg.selectFrame(value.frame);

			return;
		}

		const file = typeof value === 'string' ? value : value.filename;

		this.showLocation({file, line: value.lineNo || 1});
	}

	async act(callback)
	{
		this.message.textContent = '';

		try
		{
			return await callback();
		}
		catch(error)
		{
			this.message.textContent = error.message || String(error);
		}
	}

	breakpointProblem(message)
	{
		this.breakpointError.textContent = message;

		if(message)
		{
			this.breakpointLine.setAttribute('aria-invalid', 'true');
		}
		else
		{
			this.breakpointLine.removeAttribute('aria-invalid');
		}
	}

	/** Add the line in the box as a breakpoint, or say beside the box why it cannot be one. */
	async addBreakpoint()
	{
		const dbg = this.dbg;
		const text = this.breakpointLine.value.trim();
		const line = Number(text);
		const lines = this.textarea ? this.textarea.value.split('\n').length : Infinity;

		const taken = dbg.breakpoints.some(
			bp => bp.file === dbg.options.entrypoint && bp.line === line
		);

		const problem = !text
			? 'Enter a line number.'
			: !Number.isInteger(line) || line < 1
				? 'Line numbers are whole numbers, starting at 1.'
				: line > lines
					? `This file has ${lines} lines.`
					: taken ? `Line ${line} already has a breakpoint.` : '';

		this.message.textContent = '';
		this.breakpointProblem(problem);

		if(problem)
		{
			return;
		}

		await this.act(() => dbg.setBreakpoints([...dbg.breakpoints, {line}]));

		this.breakpointLine.value = '';
	}

	/** Start the console afresh: at the Clear button, and when a new run begins. */
	clearConsole()
	{
		this.console.replaceChildren();
		this.openLine = false;
		this.openVisibleLine = false;
		this.consoleShown();
	}

	/** Mark the console empty when nothing in it is showing, so it can say what it is for. */
	consoleShown()
	{
		this.console.dataset.empty = String(
			![...this.console.children].some(child => !child.hidden)
		);
	}

	update()
	{
		const {state, testStatus} = this.dbg;

		// Each run's output stands alone, and its opcodes start from the paused frame.
		if(this.dbg.runNumber !== this.run)
		{
			this.run = this.dbg.runNumber;
			this.opcodeChoice = 'frame';
			this.clearConsole();
		}

		this.root.dataset.state = state;
		this.root.dataset.testStatus = testStatus;

		this.root.setAttribute('aria-busy', String(['loading', 'running'].includes(state)));

		if(state !== 'paused')
		{
			this.pauseReason = null;
		}

		// A step keeps the counts until the next pause replaces them; the end of a run drops them.
		if(!['paused', 'running'].includes(state) && Object.keys(this.counts).length)
		{
			this.showCounts({});
		}

		this.status.textContent = this.statusText();

		// The one thing to do next: start, or carry on from a pause.
		const primary = !this.dbg.active ? 'Run' : state === 'paused' ? 'Continue' : null;

		for(const [label, button] of this.buttons)
		{
			button.disabled = label === 'Run'
				? !!this.dbg.active
				: label === 'Pause'
					? state !== 'running'
					: label === 'Stop'
						|| label === 'Restart'
						? !this.dbg.active
						: state !== 'paused';

			button.dataset.primary = String(label === primary);
		}

		if(this.textarea)
		{
			this.textarea.readOnly = !!this.dbg.active;
		}

		this.dbg.source?.setReadOnly?.(!!this.dbg.active);

		if(!this.dbg.location)
		{
			this.showLocation(null);
		}

		if(state !== 'paused')
		{
			this.refreshNumber++;
			this.holdFocus();

			this.showIdle();
		}
	}

	/**
	 * Before the inspector's list is replaced: if focus is on one of its controls, remember
	 * which and rest focus on the list itself. Focus then stays in the debugger, where the keys
	 * work, and returnFocus() can put it back.
	 */
	holdFocus()
	{
		const active = this.root.getRootNode().activeElement;

		if(active !== this.content && !this.content.contains(active))
		{
			return false;
		}

		this.focusKey ??= this.controlKeys.get(active) ?? null;
		this.content.focus();

		return true;
	}

	/** After the list is rebuilt: back to the control that had focus, if it is still there. */
	returnFocus(held)
	{
		if(held)
		{
			this.rows.get(this.focusKey)?.focus();
		}

		this.focusKey = null;
	}

	/** Give one of the inspector's controls its key for the two methods above. */
	control(rows, key, element)
	{
		rows.set(key, element);
		this.controlKeys.set(element, key);
	}

	/** Where things stand, as a sentence: where execution is paused, or how the run ended. */
	statusText()
	{
		const {state, testStatus, location, result} = this.dbg;
		const test = testStatus === 'unchecked' ? '' : ` Test ${testStatus}.`;

		if(state === 'paused' && location)
		{
			const where = `line ${location.line} of ${location.file}`;

			if(location.frame)
			{
				return `Paused. Showing frame ${location.frame}, at ${where}.`;
			}

			const why = {
				breakpoint: ', on a breakpoint'
				, step: ', after a step'
				, exception: ', on an exception'
			}[this.pauseReason] || '';

			return `Paused at ${where}${why}.`;
		}

		if(state === 'completed')
		{
			return `Finished with exit code ${result?.exitCode ?? 'unknown'}.${test}`;
		}

		if(state === 'stopped')
		{
			const timedOut = result?.status === 'timed-out';

			return (timedOut ? 'Stopped: the time limit was reached.' : 'Stopped.') + test;
		}

		return {
			idle: 'Ready.'
			, loading: `Loading PHP ${this.dbg.options.version}…`
			, ready: 'Starting…'
			, running: 'Running…'
			, paused: 'Paused.'
			, error: 'Failed.' + test
		}[state] ?? '';
	}

	showProgress({loaded, total})
	{
		if(this.dbg.state !== 'loading')
		{
			return;
		}

		const megabytes = bytes => (bytes / 1048576).toFixed(1) + ' MB';
		const loading = `Loading PHP ${this.dbg.options.version}: `;
		// Whole steps only: the status is a live region, and every change is announced.
		const text = total
			? `${loading}${Math.floor(loaded / total * 10) * 10}% of ${megabytes(total)}`
			: `${loading}${Math.floor(loaded / 1048576)} MB`;

		if(this.status.textContent !== text)
		{
			this.status.textContent = text;
		}
	}

	/**
	 * Frames, functions, classes or files, a row each across the panel. The list is one tab stop:
	 * the arrow keys move along it, and Enter, Space or a click chooses a row. The chosen frame
	 * is the selected one; a function, class or file stays selected while its place is shown.
	 */
	symbolList(values, rows)
	{
		const list = node('div', 'php-debugger-symbols');
		const frames = this.panel === 'frames';
		// Only an API 2 runtime names a frame's function.
		const named = frames && values.some(frame => frame.functionName !== undefined);
		const layout = frames || this.panel === 'files' ? this.panel : 'symbols';

		list.setAttribute('role', 'listbox');
		list.setAttribute('aria-label', panelTitle(this.panel));
		list.dataset.layout = named ? 'named-frames' : layout;

		for(const value of values)
		{
			const item = node('div', 'php-debugger-symbol');

			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(!!(frames && value.selected)));
			item.tabIndex = -1;
			item.append(...this.symbolCells(value, named));
			item.addEventListener('click', () => this.chooseSymbol(rows, item, value));

			this.control(rows, `symbol ${rows.size}`, item);
			list.append(item);
		}

		const options = [...rows.values()];
		const stop = options.find(option => option.getAttribute('aria-selected') === 'true')
			?? options[0];

		if(stop)
		{
			stop.tabIndex = 0;
		}

		list.addEventListener('focusin', event => {
			for(const option of options)
			{
				option.tabIndex = option === event.target ? 0 : -1;
			}
		});

		list.addEventListener('keydown', event => this.symbolKey(event, options));

		return list;
	}

	/** Move along a list of symbols, or choose the row in focus. */
	symbolKey(event, options)
	{
		const at = options.indexOf(event.target);

		if(at < 0 || event.ctrlKey || event.altKey || event.metaKey)
		{
			return;
		}

		if(event.key === 'Enter' || event.key === ' ')
		{
			event.preventDefault();
			event.target.click();

			return;
		}

		const to = {
			ArrowDown: Math.min(at + 1, options.length - 1)
			, ArrowUp: Math.max(at - 1, 0)
			, Home: 0
			, End: options.length - 1
		}[event.key];

		if(to !== undefined)
		{
			event.preventDefault();
			options[to].focus();
		}
	}

	/** Select a row's frame or show where its symbol is, then mark the row selected. */
	chooseSymbol(rows, item, value)
	{
		return this.act(async() => {
			await this.openSymbol(value);

			for(const option of rows.values())
			{
				option.setAttribute('aria-selected', String(option === item));
			}
		});
	}

	/**
	 * The cells of one row: a frame's number, function and place; a function's or class's name
	 * and place; a file's path. Unseen words between them read the row as one phrase: "Frame 1 ·
	 * total() — /main.php:4".
	 */
	symbolCells(value, named)
	{

		/** A cell, after any words only a screen reader says. */
		const cell = (className, text, spoken) => {
			const element = node('span', `php-debugger-symbol-${className}`);

			if(spoken)
			{
				element.append(node('span', 'php-debugger-symbol-spoken', spoken));
			}

			element.append(text);

			return element;
		};

		if(typeof value === 'string')
		{
			return [cell(this.panel === 'files' ? 'place' : 'name', value)];
		}

		const where = value.filename ? `${value.filename}:${value.lineNo}` : 'internal';

		if(this.panel !== 'frames')
		{
			return [cell('name', value.name), cell('place', where, ' — ')];
		}

		const owner = value.className ? phpClassLabel(value.className) + '::' : '';
		// An empty function name is top-level code.
		const callee = value.functionName ? `${owner}${value.functionName}()` : '{main}';

		return [
			cell('index', String(value.frame), 'Frame ')
			, ...named ? [cell('name', callee, ' · ')] : []
			, cell('place', where, ' — ')
		];
	}

	gutterUpdate()
	{
		const dbg = this.dbg;

		this.listBreakpoints();

		dbg.source?.setBreakpoints?.(
			dbg.breakpoints.filter(bp => bp.file === dbg.options.entrypoint)
		);

		if(!this.gutter)
		{
			return;
		}

		// The numbers are rebuilt whole; a breakpoint set from the keyboard must keep its place.
		const held = this.gutter.contains(this.root.getRootNode().activeElement);

		this.gutter.replaceChildren();
		const lines = this.textarea.value.split('\n').length;

		this.gutterLine = Math.min(Math.max(this.gutterLine, 1), lines);

		// The stylesheet sizes the number column from this, so the breakpoint dot stays clear of
		// the digits however long the file is.
		this.editor.style.setProperty(
			'--php-debugger-gutter-digits'
			, String(Math.max(2, String(lines).length))
		);

		for(let line = 1; line <= lines; line++)
		{
			const b = node('button', 'php-debugger-line', String(line));

			const bp = dbg.breakpoints.find(
				bp => bp.file === dbg.options.entrypoint && bp.line === line && bp.enabled
			);

			b.type = 'button';
			b.tabIndex = line === this.gutterLine ? 0 : -1;
			b.setAttribute('aria-label', `Breakpoint on line ${line}`);
			b.setAttribute('aria-pressed', String(!!bp));
			b.dataset.breakpoint = String(!!bp);

			// A logpoint's mark is a diamond, and a conditional one's is hollow; the title says
			// what either does.
			if(bp?.log || bp?.condition)
			{
				b.dataset.log = String(!!bp.log);
				b.dataset.condition = String(!!bp.condition);
				b.title = this.breakpointDoes(bp).flat().join('');
			}

			b.addEventListener('click', () => this.act(() => this.toggleBreakpoint(line)));

			this.gutter.append(b);
		}

		if(held)
		{
			this.gutter.children[this.gutterLine - 1].focus();
		}
	}

	/**
	 * The Breakpoints panel's list, rebuilt whole. Focus goes back to the control asked for, or to
	 * the neighbour of a removed breakpoint, or to the box.
	 */
	listBreakpoints()
	{
		const dbg = this.dbg;
		const active = this.root.getRootNode().activeElement;
		const focused = this.breakpointList.contains(active)
			? [...this.breakpointList.querySelectorAll('input, button')].indexOf(active)
			: -1;

		this.breakpointList.replaceChildren();

		// In reading order: the file on screen first, then by line.
		const listed = [...dbg.breakpoints].sort(
			(a, b) => (a.file !== dbg.options.entrypoint) - (b.file !== dbg.options.entrypoint)
				|| a.file.localeCompare(b.file)
				|| a.line - b.line
		);

		for(const bp of listed)
		{
			this.breakpointList.append(this.breakpointRow(bp));
		}

		if(!dbg.breakpoints.length)
		{
			this.breakpointList.append(
				node('li', 'php-debugger-empty', 'No breakpoints. Click a line number to set one.')
			);
		}

		// The Breakpoints tab counts them.
		this.showCounts(this.counts);

		const asked = this.breakpointFocus;

		this.breakpointFocus = null;

		if(asked)
		{
			const rows = [...this.breakpointList.children];

			rows.find(item => item.dataset.id === asked.id)?.querySelector(asked.part).focus();
		}
		else if(focused >= 0)
		{
			const controls = [...this.breakpointList.querySelectorAll('input, button')];

			(controls[Math.min(focused, controls.length - 1)] || this.breakpointLine).focus();
		}
	}

	/** What a breakpoint does besides pausing, as words and the PHP they name. */
	breakpointDoes(bp)
	{
		return [
			...bp.log ? [['logs ', bp.log]] : []
			, ...bp.condition ? [[bp.log ? ' when ' : 'when ', bp.condition]] : []
		];
	}

	/** Where a breakpoint is: the file is named only when it is not the one on screen. */
	breakpointPlace(bp)
	{
		const {file, line} = bp;

		return file === this.dbg.options.entrypoint ? `Line ${line}` : `${file}:${line}`;
	}

	/**
	 * One breakpoint in the Breakpoints panel: whether it is on, where it is, what it checks and
	 * logs, then Edit and Remove. Edit opens the form for its condition and its log.
	 */
	breakpointRow(bp)
	{
		const dbg = this.dbg;
		const where = this.breakpointPlace(bp);
		const editing = this.editingBreakpoint === bp.id;

		const item = node('li', 'php-debugger-breakpoint');
		const label = node('label', 'php-debugger-breakpoint-toggle');
		const toggle = node('input');
		const detail = node('span', 'php-debugger-breakpoint-detail');
		const edit = node('button', 'php-debugger-breakpoint-edit', 'Edit');
		const remove = node('button', 'php-debugger-breakpoint-remove', '×');

		item.dataset.id = bp.id;
		item.dataset.enabled = String(bp.enabled);
		toggle.type = 'checkbox';
		toggle.checked = bp.enabled;
		toggle.title = 'Untick to keep this breakpoint but not stop at it';
		label.append(toggle, where);

		for(const [words, php] of this.breakpointDoes(bp))
		{
			detail.append(words, node('code', '', php));
		}

		/** The breakpoints with this one switched on or off as its box says. */
		const switched = () => dbg.breakpoints.map(
			b => b.id === bp.id ? {...b, enabled: toggle.checked} : b
		);

		toggle.addEventListener('change', () => this.act(() => dbg.setBreakpoints(switched())));

		edit.type = 'button';
		edit.setAttribute('aria-label', `Edit breakpoint, ${where.toLowerCase()}`);
		edit.setAttribute('aria-expanded', String(editing));

		edit.addEventListener('click', () => {
			this.editingBreakpoint = editing ? null : bp.id;

			const part = editing ? 'edit' : 'start';

			this.breakpointFocus = {id: bp.id, part: `.php-debugger-breakpoint-${part}`};

			this.listBreakpoints();

			// The panel scrolls; the whole form comes into view, its buttons included.
			this.breakpointList.querySelector('.php-debugger-breakpoint-settings')
				?.scrollIntoView({block: 'nearest'});
		});

		remove.type = 'button';
		remove.title = 'Remove';
		remove.setAttribute('aria-label', `Remove breakpoint, ${where.toLowerCase()}`);

		/** The breakpoints without this one. */
		const others = () => dbg.breakpoints.filter(b => b.id !== bp.id);

		remove.addEventListener('click', () => this.act(() => dbg.setBreakpoints(others())));

		item.append(label, detail, edit, remove);

		if(editing)
		{
			item.append(this.breakpointSettings(bp));
		}

		return item;
	}

	/**
	 * The form under a breakpoint for its condition and its log, each explained under its box. A
	 * sentence under both says what the breakpoint will do with what is typed, as it is typed.
	 * Enter applies, Escape cancels.
	 */
	breakpointSettings(bp)
	{
		const form = node('form', 'php-debugger-breakpoint-settings');

		const condition = this.breakpointField(
			form
			, 'condition'
			, 'Condition'
			, bp.condition
			, 'PHP expression that must be true for the breakpoint to stop.'
		);

		const log = this.breakpointField(
			form
			, 'log'
			, 'Log message'
			, bp.log
			, 'PHP expression whose value is printed instead of stopping.'
		);

		const outcome = node('p', 'php-debugger-breakpoint-outcome');
		const actions = node('div', 'php-debugger-breakpoint-actions');
		const apply = node('button', 'php-debugger-button', 'Apply');
		const cancel = node('button', 'php-debugger-button', 'Cancel');

		/** Say what the breakpoint will do with what is ticked and typed now. */
		const describe = () => outcome.replaceChildren(
			...this.breakpointOutcome(bp, condition.value(), log.value())
		);

		/** Close the form, and go back to the row's Edit button. */
		const close = () => {
			this.editingBreakpoint = null;
			this.breakpointFocus = {id: bp.id, part: '.php-debugger-breakpoint-edit'};
		};

		apply.type = 'submit';
		cancel.type = 'button';
		form.addEventListener('input', describe);
		describe();

		// The form stays open when the change is refused, as it is while PHP runs.
		form.addEventListener('submit', event => {
			event.preventDefault();

			const changed = this.dbg.breakpoints.map(
				b => b.id === bp.id ? {...b, condition: condition.value(), log: log.value()} : b
			);

			void this.act(async() => {
				await this.dbg.setBreakpoints(changed);
				close();
				this.listBreakpoints();
			});
		});

		cancel.addEventListener('click', () => {
			close();
			this.listBreakpoints();
		});

		form.addEventListener('keydown', event => {
			if(event.key === 'Escape')
			{
				event.preventDefault();
				cancel.click();
			}
		});

		actions.append(apply, cancel);
		form.append(outcome, actions);

		// The form opens on the first PHP it holds, or on the Condition checkbox.
		const ticked = [condition, log].find(field => field.toggle.checked);
		const start = ticked?.input ?? condition.toggle;

		start.classList.add('php-debugger-breakpoint-start');

		return form;
	}

	/**
	 * What a breakpoint will do, as a sentence with its PHP in code: "Prints $total when $i > 2
	 * is true at line 6, without stopping."
	 */
	breakpointOutcome(bp, condition, log)
	{
		const where = this.breakpointPlace(bp).replace(/^Line/, 'line');

		/** A piece of PHP, set as code. */
		const php = text => node('code', '', text);

		if(log && condition)
		{
			const rest = ` is true at ${where}, without stopping.`;

			return ['Prints ', php(log), ' when ', php(condition), rest];
		}

		if(log)
		{
			return ['Prints ', php(log), ` each time ${where} runs, without stopping.`];
		}

		return condition
			? [`Stops at ${where} when `, php(condition), ' is true.']
			: [`Stops each time ${where} runs.`];
	}

	/**
	 * One part of the breakpoint form: a checkbox that turns it on, what it does, and, while it is
	 * on, the box for its PHP. Turned off, what was typed stays in the box but does not count.
	 */
	breakpointField(form, key, name, value, help)
	{
		const id = `${this.id}-breakpoint-${key}`;
		const field = node('div', 'php-debugger-breakpoint-field');
		const toggle = node('input', 'php-debugger-breakpoint-on');
		const label = node('label', 'php-debugger-breakpoint-label', name);
		const hint = node('span', 'php-debugger-breakpoint-hint', help);
		const input = node('input', 'php-debugger-breakpoint-expression');

		toggle.type = 'checkbox';
		toggle.id = `${id}-on`;
		toggle.checked = !!value;
		label.htmlFor = toggle.id;
		hint.id = `${id}-hint`;

		input.id = id;
		input.value = value ?? '';
		input.hidden = !toggle.checked;
		input.spellcheck = false;
		input.autocomplete = 'off';
		input.setAttribute('aria-label', name);

		for(const control of [toggle, input])
		{
			control.setAttribute('aria-describedby', hint.id);
		}

		// Ticked, the box appears and takes the typing, and the form, now taller, stays in view;
		// unticked, the box goes.
		toggle.addEventListener('change', () => {
			input.hidden = !toggle.checked;

			if(toggle.checked)
			{
				input.focus();
				form.scrollIntoView({block: 'nearest'});
			}
		});

		field.append(toggle, label, hint, input);
		form.append(field);

		return {toggle, input, value: () => toggle.checked ? input.value.trim() : ''};
	}

	/** Make one line number the gutter's tab stop. */
	gutterStop(line)
	{
		const lines = this.gutter.children;

		if(lines[this.gutterLine - 1])
		{
			lines[this.gutterLine - 1].tabIndex = -1;
		}

		this.gutterLine = Math.min(Math.max(line, 1), lines.length);
		lines[this.gutterLine - 1].tabIndex = 0;
	}

	showLocation(location)
	{
		this.dbg.source?.showLocation?.(location);

		if(!location && this.gutter)
		{
			for(const line of this.gutter.children)
			{
				line.dataset.active = 'false';
			}
		}

		if(this.textarea && location?.file === this.dbg.options.entrypoint)
		{
			const lines = this.textarea.value.split('\n');

			const start = lines.slice(0, location.line - 1).reduce((a, b) => a + b.length + 1, 0);

			this.textarea.setSelectionRange(start, start + (lines[location.line - 1]?.length || 0));

			for(const line of this.gutter.children)
			{
				line.dataset.active = String(Number(line.textContent) === location.line);
			}

			// Tabbing into the line numbers arrives at the paused line.
			if(!this.gutter.contains(this.root.getRootNode().activeElement))
			{
				this.gutterStop(location.line);
			}

			this.reveal(location.line);
		}
	}

	/** Scroll the built-in editor until a line is in view; a line already in view stays put. */
	reveal(line)
	{
		const style = getComputedStyle(this.textarea);
		const pitch = parseFloat(style.lineHeight);
		const top = (line - 1) * pitch;

		const height = this.textarea.clientHeight - parseFloat(style.paddingTop)
			- parseFloat(style.paddingBottom);

		if(top < this.textarea.scrollTop || top + pitch > this.textarea.scrollTop + height)
		{
			this.textarea.scrollTop = Math.max(0, top - (height - pitch) / 2);
		}

		this.gutter.scrollTop = this.textarea.scrollTop;
	}

	appendOutput({channel, text, kind})
	{
		const program = channel === 'stdout'
			|| channel === 'stderr';

		const notice = kind === 'notice';

		if(channel === 'debug' && !text.endsWith('\n'))
		{
			text += '\n';
		}

		// Debugger lines start on a fresh line even when program output stopped mid-line. Notices
		// compare against everything; the rest compare against what is visible while notices are
		// hidden.
		if(!program && (notice ? this.openLine : this.openVisibleLine))
		{
			text = '\n' + text;
		}

		const span = node(
			'span'
			, `php-debugger-output php-debugger-output-${channel}${kind
				? ` php-debugger-output-${kind}`
				: ''}`
			, text
		);

		span.hidden = notice && !this.debugLog.checked;
		this.console.append(span);
		this.openLine = !text.endsWith('\n');

		if(!span.hidden)
		{
			this.console.dataset.empty = 'false';
		}

		if(!notice)
		{
			this.openVisibleLine = this.openLine;
		}

		if(this.console.childNodes.length > 1000)
		{
			while(this.console.childNodes.length > 1000)
			{
				this.console.firstChild.remove();
			}

			this.consoleShown();
		}

		this.console.scrollTop = this.console.scrollHeight;
	}

	async refresh()
	{
		const generation = ++this.refreshNumber;

		this.markTabs();

		// The breakpoints are the view's own, there at any time: nothing is loaded for them.
		if(this.panel === 'breakpoints')
		{
			return;
		}

		if(this.dbg.state !== 'paused')
		{
			this.showIdle();

			return;
		}

		// What this panel held, for the count on its tab.
		const loaded = {};

		await this.act(async() => {
			if(this.panel === 'opcodes')
			{
				await this.showOpcodes(generation);

				return;
			}

			let values = this.panel === 'watches'
				? await Promise.all(this.watches.map(expression => this.watchValue(expression)))
				: await this.dbg.inspect(this.panel);

			if(generation !== this.refreshNumber || this.dbg.state !== 'paused')
			{
				return;
			}

			loaded[this.panel] = values.length;

			if(this.panel === 'variables')
			{
				// What PHP puts in every script's scope goes after what the script put there.

				const given = value => ['argv', 'argc'].includes(value.name);

				values = [...values.filter(value => !given(value)), ...values.filter(given)];
			}

			if(['variables', 'globals', 'constants', 'watches'].includes(this.panel))
			{
				// Built off the page, open values included, and swapped in whole: nothing collapses
				// and reopens in view.
				const rows = new Map();
				const nodes = [];

				for(const value of values)
				{
					nodes.push(await this.valueNode(value, [this.panel, value.name], rows));
				}

				if(generation !== this.refreshNumber || this.dbg.state !== 'paused')
				{
					return;
				}

				const scrolled = this.content.scrollTop;
				const held = this.holdFocus();

				this.rows = rows;
				this.content.replaceChildren(...nodes);
				this.content.scrollTop = scrolled;

				if(!nodes.length)
				{
					this.content.append(
						node(
							'p'
							, 'php-debugger-empty'
							, this.panel === 'watches'
								? 'No watch expressions. Type one below and choose Watch.'
								: `No ${this.panel} here yet.`
						)
					);
				}

				this.returnFocus(held);
			}
			else
			{
				const rows = new Map();
				const listed = Array.isArray(values) ? values : Object.values(values);
				const list = this.symbolList(listed, rows);
				const scrolled = this.content.scrollTop;
				const held = this.holdFocus();

				this.rows = rows;

				// An empty panel says so rather than showing nothing.
				this.content.replaceChildren(
					rows.size ? list : node('p', 'php-debugger-empty', `No ${this.panel} here yet.`)
				);

				this.content.scrollTop = scrolled;
				this.returnFocus(held);
			}
		});

		if(generation === this.refreshNumber && this.dbg.state === 'paused')
		{
			await this.recount(generation, loaded);
		}
	}

	/**
	 * One value of the tree, with its children loaded when its path was left open. `rows` collects
	 * each value's controls by path for the refresh that is building them.
	 */
	async valueNode(value, path, rows, depth = 0)
	{
		const key = JSON.stringify(path);
		const row = node('div', 'php-debugger-value');
		const line = node('div', 'php-debugger-value-line');
		const name = node('span', 'php-debugger-value-name');
		const data = node('span', 'php-debugger-value-data');
		const preview = node('span', 'php-debugger-value-preview', value.displayValue);

		// The table has no colon to show, but "price: 10" is how a row reads aloud.
		const colon = node('span', 'php-debugger-value-colon', ': ');

		const label = value.name + (value.visibility && value.visibility !== 'public'
			? ` (${value.visibility})`
			: ''
		);

		// A row of the table: name, value, and Edit at the right. A child's name is indented
		// inside the name column, so its row's columns are where every other row has them.
		line.style.setProperty('--php-debugger-depth', String(depth));
		row.append(line);
		line.append(name, data);
		data.append(preview);

		if(value.type)
		{
			preview.dataset.type = value.type;
		}

		// The type is on show, not in a tooltip, wherever the value does not already say it.
		if(typeLabel(value))
		{
			data.append(node('span', 'php-debugger-value-type', typeLabel(value)));
		}

		if(value.expandable && depth < 30)
		{
			// The name is the switch: its text stays the same open or shut, and aria-expanded says
			// which it is.
			const toggle = node('button', 'php-debugger-expand', label);
			const children = node('div', 'php-debugger-children');
			const more = node('button', 'php-debugger-more');
			let offset = 0;
			let loaded = false;

			toggle.type = 'button';
			toggle.setAttribute('aria-expanded', 'false');
			this.control(rows, `open ${key}`, toggle);
			more.type = 'button';
			more.hidden = true;
			children.hidden = true;
			children.style.setProperty('--php-debugger-depth', String(depth + 1));
			children.append(more);
			name.append(toggle, colon);
			row.append(children);

			const load = async() => {
				const page = await this.dbg.children(value.reference, {offset, limit: 100});

				for(const child of page.values)
				{
					children.insertBefore(
						await this.valueNode(child, [...path, child.name], rows, depth + 1)
						, more
					);
				}

				offset += page.values.length;
				loaded = true;
				more.hidden = offset >= page.total;
				more.textContent = `Show more (${offset} of ${page.total})`;

				if(!page.total)
				{
					children.append(node('span', 'php-debugger-empty', 'empty'));
				}
			};

			const open = async() => {
				if(!loaded)
				{
					await load();
				}

				children.hidden = false;
				toggle.setAttribute('aria-expanded', 'true');
				this.expanded.add(key);
			};

			toggle.addEventListener(
				'click'
				, () => this.act(
					async() => {
						if(children.hidden)
						{
							await open();

							return;
						}

						children.hidden = true;
						toggle.setAttribute('aria-expanded', 'false');
						this.expanded.delete(key);
					}
				)
			);

			more.addEventListener('click', () => this.act(load));

			if(this.expanded.has(key))
			{
				// A value that can no longer be opened simply stays shut.
				await open().catch(() => {});
			}
		}
		else
		{
			name.classList.add('php-debugger-value-leaf');
			name.append(label, colon);
		}

		if(value.writable)
		{
			const edit = node('button', 'php-debugger-edit', 'Edit');

			edit.type = 'button';
			edit.setAttribute('aria-label', `Edit ${value.name}`);
			this.control(rows, `edit ${key}`, edit);
			line.append(edit);
			edit.addEventListener('click', () => this.editValue(value, key, line, edit));
		}

		return row;
	}

	/** Swap a value's Edit button for a small form: Enter applies, Escape cancels. */
	editValue(value, key, line, edit)
	{
		const form = node('form', 'php-debugger-edit-form');
		const input = node('input', 'php-debugger-edit-expression');
		const save = node('button', 'php-debugger-button', 'Apply');
		const cancel = node('button', 'php-debugger-button', 'Cancel');
		const problem = node('div', 'php-debugger-edit-error');

		input.setAttribute('aria-label', `New PHP expression for ${value.name}`);
		input.spellcheck = false;
		input.value = value.type === 'string'
			? "'" + String(value.value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")
				+ "'"
			: value.type === 'unset' || value.expandable || value.circular
				? ''
				: value.displayValue;

		save.type = 'submit';
		cancel.type = 'button';
		problem.setAttribute('role', 'alert');
		form.append(input, save, cancel, problem);
		line.append(form);
		edit.hidden = true;
		input.focus();
		input.select();

		const close = () => {
			form.remove();
			edit.hidden = false;
			edit.focus();
		};

		cancel.addEventListener('click', close);

		form.addEventListener('keydown', event => {
			if(event.key === 'Escape')
			{
				event.preventDefault();
				close();
			}
		});

		form.addEventListener('submit', async event => {
			event.preventDefault();
			problem.textContent = '';
			input.removeAttribute('aria-invalid');

			try
			{
				await this.dbg.setVariable(value.reference, input.value);
			}
			catch(error)
			{
				// What PHP made of the new value is said beside it, and the form stays open. Focus
				// returns to the box unless the user has already gone elsewhere.
				problem.textContent = error.message || String(error);
				input.setAttribute('aria-invalid', 'true');

				if(form.contains(this.root.getRootNode().activeElement))
				{
					input.focus();
				}

				return;
			}

			// The form goes with the old list; focus belongs back on the button that opened it.
			this.focusKey = `edit ${key}`;
			await this.refresh();
		});
	}

	/**
	 * An adapter's editor inside the mount point moves into the interface, where the textarea
	 * would be, as a textarea there does. It keeps its own look and size, and destroy() hands it
	 * back.
	 */
	hostEditor(adapter)
	{
		const {element} = adapter;

		this.hosted = {adapter, element, parent: element.parentNode, next: element.nextSibling};
		this.hostedSlot = node('div', 'php-debugger-hosted-editor');
		this.hostedSlot.append(element);
		this.root.append(this.hostedSlot);

		// Ace and CodeMirror measure themselves against their container.
		adapter.layout?.();
	}

	destroy()
	{
		this.abort.abort();
		this.tabResize?.disconnect();
		this.adapterUnsubscribe?.();
		this.dbg.source?.showLocation?.(null);
		this.dbg.source?.setBreakpoints?.([]);
		this.dbg.source?.setReadOnly?.(false);

		if(this.adopted)
		{
			const {parent, next, readOnly, spellcheck, label} = this.adopted;

			const restore = (name, value) => value === null
				? this.textarea.removeAttribute(name)
				: this.textarea.setAttribute(name, value);

			this.textarea.classList.remove('php-debugger-source');
			this.textarea.readOnly = readOnly;
			restore('spellcheck', spellcheck);
			restore('aria-label', label);

			if(parent.isConnected)
			{
				parent.insertBefore(this.textarea, next?.parentNode === parent ? next : null);
			}
		}
		else if(this.dbg.source === this.textarea)
		{
			this.dbg.options.code = this.textarea.value;
			this.dbg.source = null;
		}

		if(this.hosted?.parent.isConnected)
		{
			const {adapter, element, parent, next} = this.hosted;

			parent.insertBefore(element, next?.parentNode === parent ? next : null);
			adapter.layout?.();
		}

		this.root.remove();
	}
}
