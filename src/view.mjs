import {versions, phpClassLabel, typeLabel} from './model.mjs';

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
		this.status = node('output', 'php-debugger-status');
		this.status.setAttribute('aria-live', 'polite');
		this.root.append(this.status);
		this.message = node('div', 'php-debugger-message');
		this.message.setAttribute('role', 'alert');
		this.root.append(this.message);

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

		this.breakpoints = node('div', 'php-debugger-breakpoints');
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
		breakpointForm.append(lineInput, add);
		this.breakpoints.append(breakpointForm, this.breakpointList, this.breakpointError);
		this.root.append(this.breakpoints);

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
		this.tabs = node('div', 'php-debugger-tabs');
		this.tabs.setAttribute('role', 'tablist');
		this.tabs.setAttribute('aria-label', 'Inspect');
		right.append(this.tabs);

		for(const scope of ['variables'
			, 'globals'
			, 'constants'
			, 'functions'
			, 'classes'
			, 'files'
			, 'frames'
			, 'watches'
		]){
			const tab = node('button', 'php-debugger-tab', scope[0].toUpperCase() + scope.slice(1));

			tab.type = 'button';
			tab.id = `${this.id}-tab-${scope}`;
			tab.setAttribute('role', 'tab');
			tab.dataset.panel = scope;
			tab.addEventListener('click', () => this.showPanel(scope), {signal: this.abort.signal});
			this.tabs.append(tab);
		}

		// One tab stop for the row; the arrow keys move along it and show each panel.
		this.tabs.addEventListener(
			'keydown'
			, event => {
				const tabs = [...this.tabs.children];
				const at = tabs.findIndex(tab => tab.dataset.panel === this.panel);

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
		right.append(this.content);

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
		this.root.append(form);

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
					this.message.textContent = result.test.failures.map(
						f => `${f.field}: expected ${f.expected ?? f.message}, received ${f.actual
							?? ''}`
					).join('\n');
				}

				if(result.status === 'error')
				{
					this.message.textContent = result.diagnostics.map(d => d.message).join('\n');
				}
			}
		);

		this.adapterUnsubscribe = dbg.source?.onBreakpointChange?.(
			lines => this.act(() => dbg.setBreakpoints([
				...dbg.breakpoints.filter(
					bp => bp.file !== dbg.options.entrypoint || (!bp.enabled
			&& !lines.some(line => (typeof line === 'number' ? line : line.line) === bp.line)
					)
				)
				, ...lines
			]))
		);

		this.markTabs();
		this.gutterUpdate();
		this.update();
	}

	showPanel(panel)
	{
		this.panel = panel;
		this.markTabs();
		void this.refresh();
	}

	/** Say which tab's panel is showing; only that tab is a tab stop. */
	markTabs()
	{
		for(const tab of this.tabs.children)
		{
			const selected = tab.dataset.panel === this.panel;

			tab.setAttribute('aria-selected', String(selected));
			tab.tabIndex = selected ? 0 : -1;

			if(selected)
			{
				this.content.setAttribute('aria-labelledby', tab.id);
			}
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

		// Each run's output stands alone.
		if(this.dbg.runNumber !== this.run)
		{
			this.run = this.dbg.runNumber;
			this.clearConsole();
		}

		this.root.dataset.state = state;
		this.root.dataset.testStatus = testStatus;

		this.root.setAttribute('aria-busy', String(['loading', 'running'].includes(state)));

		if(state !== 'paused')
		{
			this.pauseReason = null;
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

			this.content.replaceChildren(
				node('p', 'php-debugger-empty', 'Pause execution to inspect values.')
			);
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

	frameLabel(frame)
	{
		// Only an API 2 runtime names the function; an empty name there means top-level code.
		const callee = frame.functionName === undefined
			? ''
			: ` · ${frame.functionName
				? `${frame.className
					? phpClassLabel(frame.className) + '::'
					: ''}${frame.functionName}()`
				: '{main}'}`;

		return `Frame ${frame.frame}${callee} — ${frame.filename
			? `${frame.filename}:${frame.lineNo}`
			: 'internal'}`;
	}

	gutterUpdate()
	{
		const dbg = this.dbg;
		// Rebuilt whole; focus goes back to the neighbour of a removed breakpoint, or to the box.
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
			// The file is named only when it is not the one on screen.
			const where = bp.file === dbg.options.entrypoint
				? `Line ${bp.line}`
				: `${bp.file}:${bp.line}`;

			const item = node('li', 'php-debugger-breakpoint');
			const label = node('label', 'php-debugger-breakpoint-toggle');
			const toggle = node('input');
			const remove = node('button', 'php-debugger-breakpoint-remove', '\u00d7');

			item.dataset.enabled = String(bp.enabled);
			toggle.type = 'checkbox';
			toggle.checked = bp.enabled;
			toggle.title = 'Untick to keep this breakpoint but not stop at it';
			label.append(toggle, where);

			toggle.addEventListener(
				'change'
				, () => this.act(
					() => dbg.setBreakpoints(
						dbg.breakpoints.map(
							b => b.id === bp.id ? {...b, enabled: toggle.checked} : b
						)
					)
				)
			);

			remove.type = 'button';
			remove.title = 'Remove';
			remove.setAttribute('aria-label', `Remove breakpoint, ${where.toLowerCase()}`);

			remove.addEventListener(
				'click'
				, () => this.act(
					() => dbg.setBreakpoints(dbg.breakpoints.filter(b => b.id !== bp.id))
				)
			);

			item.append(label, remove);
			this.breakpointList.append(item);
		}

		if(!dbg.breakpoints.length)
		{
			this.breakpointList.append(
				node('li', 'php-debugger-empty', 'No breakpoints. Click a line number to set one.')
			);
		}

		if(focused >= 0)
		{
			const controls = [...this.breakpointList.querySelectorAll('input, button')];

			(controls[Math.min(focused, controls.length - 1)] || this.breakpointLine).focus();
		}

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

			const enabled = dbg.breakpoints.some(
				bp => bp.file === dbg.options.entrypoint && bp.line === line && bp.enabled
			);

			b.type = 'button';
			b.tabIndex = line === this.gutterLine ? 0 : -1;
			b.setAttribute('aria-label', `Breakpoint on line ${line}`);
			b.setAttribute('aria-pressed', String(enabled));
			b.dataset.breakpoint = String(enabled);

			b.addEventListener('click', () => this.act(() => this.toggleBreakpoint(line)));

			this.gutter.append(b);
		}

		if(held)
		{
			this.gutter.children[this.gutterLine - 1].focus();
		}
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

		if(this.dbg.state !== 'paused')
		{
			return;
		}

		await this.act(async() => {
			let values = this.panel === 'watches'
				? await Promise.all(this.watches.map(expression => this.watchValue(expression)))
				: await this.dbg.inspect(this.panel);

			if(generation !== this.refreshNumber || this.dbg.state !== 'paused')
			{
				return;
			}

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
				const held = this.holdFocus();

				this.rows = rows;
				this.content.replaceChildren();

				for(const value of Array.isArray(values) ? values : Object.values(values))
				{
					const item = node(
						'button'
						, 'php-debugger-symbol'
						, typeof value === 'string'
							? value
							: this.panel === 'frames'
								? this.frameLabel(value)
								: `${value.name} — ${value.filename}:${value.lineNo}`
					);

					item.type = 'button';

					if(this.panel === 'frames' && value.selected)
					{
						item.setAttribute('aria-current', 'true');
					}

					item.addEventListener('click', () => this.act(() => this.openSymbol(value)));

					this.control(rows, `symbol ${rows.size}`, item);
					this.content.append(item);
				}

				this.returnFocus(held);
			}
		});
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
		const preview = node('span', 'php-debugger-value-preview', value.displayValue);

		const label = value.name + (value.visibility && value.visibility !== 'public'
			? ` (${value.visibility})`
			: ''
		);

		row.append(line);
		line.append(name, preview);

		if(value.type)
		{
			preview.dataset.type = value.type;
		}

		// The type is on show, not in a tooltip, wherever the value does not already say it.
		if(typeLabel(value))
		{
			line.append(node('span', 'php-debugger-value-type', typeLabel(value)));
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
			children.append(more);
			name.append(toggle, ': ');
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
			name.textContent = label + ': ';
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

	destroy()
	{
		this.abort.abort();
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

		this.root.remove();
	}
}
