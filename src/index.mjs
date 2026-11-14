import {prepareAssets} from './assets.mjs';
import {createTransport} from './transport.mjs';
import {checkExpectations} from './expectations.mjs';
import {versions, normalizePath, normalizeBreakpoints, deferred, errorRecord} from './model.mjs';
import {DebuggerView} from './view.mjs';
export {AssetRegistry, sharedAssets} from './assets.mjs';
export {versions};

export class PhpDebugger extends EventTarget
{

	constructor(options = {})
	{
		super();
		this.options = {
			version: '8.4'
			, execution: 'worker'
			, entrypoint: '/main.php'
			, extensions: []
			, ...options
		};

		this.validateVersion(this.options.version);

		if(!['worker', 'main'].includes(this.options.execution))
		{
			throw new TypeError('execution must be worker or main');
		}

		this.options.entrypoint = normalizePath(this.options.entrypoint);
		this.breakpoints = normalizeBreakpoints(options.breakpoints, this.options.entrypoint);
		this.state = 'idle';
		this.testStatus = 'unchecked';
		this.result = null;
		this.location = null;
		this.source = options.source || null;
		this.generation = 0;
		this.runNumber = 0;
		this.pauseWaiters = new Set();

		this.capabilities = Object.freeze(
			{hardStop: this.options.execution === 'worker', pause: true, variableEditing: true}
		);
	}

	validateVersion(version)
	{
		if(!versions.includes(version))
		{
			throw new RangeError(`Unsupported PHP version: ${version}`);
		}
	}

	assertAlive()
	{
		if(this.state === 'destroyed')
		{
			throw new Error('Debugger is destroyed');
		}
	}

	emit(type, detail) {this.dispatchEvent(new CustomEvent(type, {detail}));}

	transition(state)
	{
		const previous = this.state;

		if(this.active)
		{
			clearTimeout(this.active.timer);

			if(previous === 'running')
			{
				this.active.runningMs += performance.now() - this.active.runningSince;
			}

			if(state === 'running')
			{
				this.active.runningSince = performance.now();

				if(this.active.timeoutMs > 0)
				{
					this.active.timer = setTimeout(
						() => void this.finish('timed-out')
						, Math.max(0, this.active.timeoutMs - this.active.runningMs)
					);
				}
			}
		}

		this.state = state;
		this.emit('statechange', {state, previous});
	}

	async readCode()
	{
		const code = await this.sourceCode();

		if(typeof code !== 'string')
		{
			throw new TypeError('PHP source must be a string');
		}

		return code;
	}

	/** The code where the source holds it: an editor, an element, a getter, or the code option. */
	sourceCode()
	{
		if(typeof this.source?.getCode === 'function')
		{
			return this.source.getCode();
		}

		if(this.source?.nodeType)
		{
			return 'value' in this.source ? this.source.value : this.source.textContent;
		}

		if(typeof this.source === 'function')
		{
			return this.source();
		}

		const code = this.options.code;

		return typeof code === 'function' ? this.options.code() : code ?? '';
	}

	setCode(code)
	{
		this.assertAlive();

		if(typeof code !== 'string' && typeof code !== 'function')
		{
			throw new TypeError('Code must be a string or getter');
		}

		this.options.code = code;

		// A getter becomes the source, and code given as a string replaces one.
		if(typeof code === 'function' || typeof this.source === 'function')
		{
			this.source = typeof code === 'function' ? code : null;
		}

		// Code given as a string goes into the editor or element it came from.
		if(typeof this.source?.setCode === 'function')
		{
			this.source.setCode(code);
		}
		else if(this.source?.nodeType)
		{
			this.source['value' in this.source ? 'value' : 'textContent'] = code;
		}

		this.emit(
			'sourcechange'
			, {code: typeof code === 'string' ? code : undefined, pending: !!this.active}
		);
	}

	async setBreakpoints(input)
	{
		this.assertAlive();
		const breakpoints = normalizeBreakpoints(input, this.options.entrypoint);

		if(this.active && this.state !== 'paused')
		{
			throw new Error('Pause execution before changing breakpoints');
		}

		if(this.state === 'paused')
		{
			await this.transport.call('breakpoints', breakpoints);
		}

		this.breakpoints = breakpoints;
		this.emit('breakpointchange', {breakpoints});

		return breakpoints;
	}

	async setVersion(version)
	{
		this.assertAlive();
		this.validateVersion(version);

		if(this.options.version === version)
		{
			return;
		}

		await this.stop();
		this.options.version = version;
		this.emit('versionchange', {version});
	}

	async prepare()
	{
		this.assertAlive();

		if(this.opening)
		{
			return this.opening;
		}

		if(this.transport)
		{
			return;
		}

		const generation = this.generation;
		const options = {
			...this.options
			, onProgress: progress => {
				if(generation === this.generation)
				{
					this.emit('progress', progress);
				}
			}
		};

		this.transition('loading');

		this.opening = (async () => {
			const assets = await prepareAssets(options);

			if(generation !== this.generation)
			{
				throw new DOMException('Loading cancelled', 'AbortError');
			}

			const transport = await createTransport(options, assets, event => {
				if(generation === this.generation)
				{
					this.handleEvent(event);
				}
			});

			if(generation !== this.generation)
			{
				await transport.destroy();
				throw new DOMException('Loading cancelled', 'AbortError');
			}

			this.transport = transport;
			await transport.open();
		})();

		try
		{
			await this.opening;
		}
		catch(error)
		{
			if(generation === this.generation)
			{
				await this.teardown();

				if(!this.active)
				{
					this.transition('error');
				}
			}

			throw error;
		}
	}

	run(options = {})
	{
		this.assertAlive();

		if(this.active)
		{
			throw new Error('An execution is already active');
		}

		const mode = options.mode || this.options.mode || 'debug';

		if(!['debug', 'test'].includes(mode))
		{
			throw new TypeError('mode must be debug or test');
		}

		const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 0;

		if(!Number.isFinite(timeoutMs) || timeoutMs < 0)
		{
			throw new RangeError('timeoutMs must be nonnegative');
		}

		const files = structuredClone(options.files ?? this.options.files ?? {});
		const wait = deferred();

		const active = this.active = {
			id: ++this.runNumber
			, wait
			, started: performance.now()
			, runningMs: 0
			, timeoutMs

			, stdout: ''
			, stderr: ''
			, logs: []

			, version: this.options.version
			, expectations: options.expect ?? this.options.expect
			, assertion: options.assert ?? this.options.assert
			, signal: options.signal
			, mode
		};

		this.result = null;
		this.testStatus = 'unchecked';
		this.location = null;

		active.abort = () => void this.finish('cancelled');
		options.signal?.addEventListener('abort', active.abort, {once: true});

		if(options.signal?.aborted)
		{
			void this.finish('cancelled');

			return wait.promise;
		}

		const breakpoints = this.breakpoints.map(bp => ({...bp}));
		const source = this.readCode();

		active.loadTimer = setTimeout(
			() => void this.finish('error', {error: new Error('Debugger startup timed out')})
			, this.options.loadTimeoutMs ?? 120000
		);

		/** A failure while starting ends this run, unless the run has already ended. */
		const failed = error => {
			if(this.active === active && !active.finishing)
			{
				void this.finish('error', {error});
			}
		};

		void (async () => {
			const code = await source;

			if(this.active !== active || active.finishing)
			{
				return;
			}

			await this.prepare();

			if(this.active !== active || active.finishing)
			{
				return;
			}

			clearTimeout(active.loadTimer);

			const stdin = options.stdin ?? this.options.stdin;
			const entrypoint = this.options.entrypoint;

			await this.transport.call(
				'execute'
				, {code, files, breakpoints, mode, stdin, entrypoint}
			);
		})().catch(failed);

		return wait.promise;
	}

	handleEvent(event)
	{
		switch(event.type)
		{
			case 'fatal':
				this.handleFatal(event.error);
				break;

			case 'state':
				this.location = event.state === 'running' ? null : this.location;
				this.transition(event.state);
				break;

			case 'output':
				this.handleOutput(event);
				break;

			case 'log':
				this.handleLog(event);
				break;

			case 'paused':
				this.handlePause(event);
				break;

			case 'complete':
				void this.finish('completed', event);
				break;

			default:
				this.emit(event.type, event);
		}
	}

	/** The runtime failed. A run ends with the error; otherwise the debugger reports it. */
	handleFatal(error)
	{
		if(this.active)
		{
			void this.finish('error', {error});

			return;
		}

		void this.teardown();
		this.transition('error');
		this.emit('diagnostic', errorRecord(error));
	}

	/** Output from the program or from phpdbg. A run that writes too much is ended. */
	handleOutput(event)
	{
		if(this.active && (event.channel === 'stdout' || event.channel === 'stderr'))
		{
			this.active[event.channel] += event.text;
			this.checkOutputLimit();
		}

		this.emit('output', event);
	}

	/** End a run whose program output and logs have passed the output limit. */
	checkOutputLimit()
	{
		const {stdout, stderr, logged = 0} = this.active;

		if(stdout.length + stderr.length + logged > (this.options.outputLimit ?? 10_000_000))
		{
			void this.finish('error', {error: new Error('Execution output limit exceeded')});
		}
	}

	/**
	 * A logpoint printed a value. The run keeps it for its result, and its text counts toward the
	 * output limit.
	 */
	handleLog({file, line, message: said, error})
	{
		// A message is text, whatever the engine made of the expression.
		const message = String(said ?? '');
		const entry = {file, line, message, ...error && {error: true}};

		if(this.active)
		{
			this.active.logs.push(entry);
			this.active.logged = (this.active.logged ?? 0) + message.length;
			this.checkOutputLimit();
		}

		this.emit('log', entry);
	}

	/** The program has paused: record where, and answer everyone waiting for a pause. */
	handlePause(event)
	{
		this.location = event.location;
		this.transition('paused');
		this.emit('pause', event);
		this.emit('locationchange', event.location);

		for(const wait of this.pauseWaiters)
		{
			wait.resolve(event);
		}

		this.pauseWaiters.clear();
	}

	async finish(status, details = {})
	{
		const active = this.active;

		if(!active || active.finishing)
		{
			return;
		}

		active.finishing = true;
		clearTimeout(active.timer);
		clearTimeout(active.loadTimer);
		active.signal?.removeEventListener('abort', active.abort);

		const result = {
			runId: active.id
			, version: active.version
			, status
			, exitCode: details.exitCode ?? null

			, stdout: active.stdout
			, stderr: active.stderr
			, logs: active.logs
			, diagnostics: details.diagnostics || (details.error
				? [errorRecord(details.error)]
				: []
			)

			, durationMs: performance.now() - active.started
		};

		for(const wait of this.pauseWaiters)
		{
			wait.reject(new Error(`Execution ${status} before another pause`));
		}

		this.pauseWaiters.clear();

		try
		{
			await this.teardown();
		}
		catch(error)
		{
			result.diagnostics.push(errorRecord(error));
			result.status = 'error';
		}

		// Whatever checking the expectations throws, the run still ends, as a failed test.
		result.test = await checkExpectations(result, active.expectations, active.assertion).catch(
			error => ({
				status: 'failed'
				, failures: [{field: 'expect', message: error.message || String(error)}]
			})
		);

		this.active = null;
		this.result = result;
		this.testStatus = result.test.status;
		this.location = null;

		this.transition(
			result.status === 'completed'
				? 'completed'
				: result.status === 'error' ? 'error' : 'stopped'
		);

		this.emit('testresult', result.test);
		this.emit('complete', result);

		active.wait.resolve(result);
	}

	async teardown()
	{
		this.generation++;
		const transport = this.transport;
		this.transport = null;
		this.opening = null;

		if(transport)
		{
			await transport.destroy();
		}
	}

	whenPaused()
	{
		if(this.state === 'paused')
		{
			return Promise.resolve({location: this.location});
		}

		if(!this.active)
		{
			return Promise.reject(new Error('No active execution'));
		}

		const wait = deferred();
		this.pauseWaiters.add(wait);

		return wait.promise;
	}

	async pause()
	{
		this.assertAlive();

		if(this.state !== 'running')
		{
			throw new Error('Execution is not running');
		}

		await this.transport.call('pause');

		return this.whenPaused();
	}

	async command(method, ...args)
	{
		this.assertAlive();

		if(this.state !== 'paused')
		{
			throw new Error('Execution must be paused');
		}

		const active = this.active;

		try
		{
			return await this.transport.call(method, ...args);
		}
		catch(error)
		{
			// Completion can arrive before the worker's response to the resume RPC.
			if(method === 'resume' && active?.finishing
				&& (await active.wait.promise).status === 'completed'
			){
				return;
			}

			throw error;
		}
	}

	continue() {return this.command('resume', 'continue');}

	stepInto() {return this.command('resume', 'step');}

	stepOver() {return this.command('resume', 'next');}

	stepOut() {return this.command('resume', 'finish');}

	until() {return this.command('resume', 'until');}

	leave() {return this.command('resume', 'leave');}

	inspect(scope, options) {return this.command('inspect', scope, options);}

	children(reference, options) {return this.command('children', reference, options);}

	evaluate(expression, options) {return this.command('evaluate', expression, options);}

	setVariable(reference, expression) {return this.command('setVariable', reference, expression);}

	/**
	 * The ops phpdbg's print lists: the selected frame's function, or {script: true}, {function}
	 * or {class}.
	 */
	opcodes(target) {return this.command('opcodes', target);}

	async selectFrame(frame)
	{
		const result = await this.command('selectFrame', frame);

		const selected = (await this.inspect('frames')).find(
			candidate => candidate.frame === frame
		);

		if(selected)
		{
			this.location = {
				...this.location
				, file: selected.filename
				, line: selected.lineNo
				, frame
			};

			this.emit('locationchange', this.location);
		}

		this.emit('framechange', result);

		return result;
	}

	async stop()
	{
		this.assertAlive();

		if(this.active)
		{
			const done = this.active.wait.promise;
			await this.finish('cancelled');

			return done;
		}

		await this.teardown();
		this.location = null;
		this.transition('idle');
	}

	async restart(options) {await this.stop(); return this.run(options);}

	mount(host)
	{
		this.assertAlive();
		this.view?.destroy();
		this.view = new DebuggerView(this, host);

		return this.view;
	}

	async destroy()
	{
		if(this.state === 'destroyed')
		{
			return;
		}

		// The view goes first, before anything is awaited: what it borrowed from the page, a
		// textarea or an editor, is back at once, for whatever mounts there next.
		this.view?.destroy();
		this.view = null;
		await this.stop();
		this.transition('destroyed');
	}
}
