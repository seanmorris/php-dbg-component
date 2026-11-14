import {
	deferred
	, phpString
	, normalizePath
	, phpClassLabel
	, phpPropertyName
	, evaluationError
	, parseOpcodes
	, parseOpline
} from './model.mjs';

// What evaluate() runs in the paused frame. The inner eval() compiles and runs the expression
// in that frame too, so a syntax error or an uncaught exception arrives in this catch block.
// Left to phpdbg, either one is reported as the script's own fatal error, and a run that then
// ends normally exits with 255.
const evaluationRunner = `try
{
	return [true, eval(file_get_contents('/.php-debugger/eval.php'))];
}
catch(\\Throwable $__phpDebuggerError)
{
	return [
		false
		, get_class($__phpDebuggerError)
		, $__phpDebuggerError->getMessage()
		, $__phpDebuggerError instanceof \\ParseError ? $__phpDebuggerError->getLine() : 0
	];
}
finally
{
	unset($__phpDebuggerError);
}`;

// What a logpoint's expression is wrapped in: a string is logged as it is, anything else as
// var_export() writes it.
const logged = '(static fn($value) => is_string($value) ? $value : var_export($value, true))(';

/** What the inspector lists for a child it could not read. */
const unavailable = (name, error) => ({
	name
	, type: 'unavailable'
	, displayValue: error.message
	, writable: false
	, expandable: false
});

/** A PHP function or class name, namespaced or not. */
const phpName = /^\\?[A-Za-z_\x80-￿][\w\x80-￿]*(?:\\[A-Za-z_\x80-￿][\w\x80-￿]*)*$/u;

/** Lives beside the runtime, in a worker by default. Live Zend values stay here. */
export class DebugEngine
{

	constructor(emit)
	{
		this.emit = emit;
		this.sequence = 0;
		this.waiters = new Set();

		this.references = new Map();
		this.epoch = 0;
		this.nextReference = 0;
		this.frame = 0;

		this.paused = false;
		this.closed = false;

		this.sessionId = crypto.randomUUID();
		this.serial = Promise.resolve();
		this.decoders = new Map();
		this.diagnostics = [];
	}

	async open(assets, options)
	{
		this.options = options;
		const name = assets.environment === 'worker' ? 'PhpDbgWorker' : 'PhpDbgWeb';

		const Runtime = (await import(/* webpackIgnore: true */ new URL(
			`${name}.mjs`
			, assets.base
		).href
		))[name];

		const failed = deferred();
		const shared = {
			...(options.runtimeArgs?.shared || {})
			, __phpDebugger: {capture: value => {this.captured = {value};}}
		};

		const args = {
			...(options.runtimeArgs || {})
			, version: options.version
			, persist: false
			, autoTransaction: false
			, shared
			, dbgYieldInterval: 8
			, dbgManagedShutdown: true
			, dbgArgs: options.runtimeArgs?.dbgArgs ?? ['-q']

			, instantiateWasm(imports, ready) {
				WebAssembly.instantiate(assets.module, imports).then(
					instance => ready(instance, assets.module)
					, failed.reject
				);

				return {};
			}

			, getPreloadedPackage(name) {return assets.data[String(name).split('/').pop()];}
			, sharedLibs: assets.sharedLibs
			, dynamicLibs: assets.dynamicLibs
			, files: assets.files
			, locateFile: name => assets.libraryUrls[name]

			, onDbgOutput: event => this.output(event)
			, onDbgEvent: event => {
				if(event.type === 'exception')
				{
					this.exception = event;
					this.diagnostics.push(event);
					this.emit({...event, type: 'diagnostic'});
				}
			}

			, onAbort: reason => failed.reject(new Error(String(reason)))
		};

		this.php = new Runtime(args);
		this.binary = await Promise.race([this.php.binary, failed.promise]);

		if(typeof this.binary._php_wasm_dbg_bridge_version !== 'function'
		|| this.binary.ccall('php_wasm_dbg_bridge_version', 'number', [], []) !== 1
		){
			throw new Error(
				'This php-dbg-wasm build lacks debugger bridge v1. Rebuild its native worker/web artifacts.'
			);
		}

		// API 2 runtimes report PHP types, frame names and user globals themselves; older ones need
		// the fallbacks below.
		this.dbgApi = typeof this.php.debuggerApiVersion === 'function'
			? await this.php.debuggerApiVersion()
			: 1;

		this.binary.FS.mkdir('/.php-debugger');
		this.writeFile('/.php-debugger/run.php', evaluationRunner);

		this.php.addEventListener('stdin-request', () => {
			// The native async call must unwind before reading its state.
			setTimeout(
				() => {
					this.sequence++;

					for(const waiter of this.waiters)
					{
						waiter.resolve();
					}

					this.waiters.clear();
				}
				, 0
			);
		});

		const prompt = this.waitPrompt();

		this.process = this.php.run().catch(error => {
			if(typeof error?.status === 'number')
			{
				return error.status;
			}

			throw error;
		});

		this.process.catch(() => {});

		await Promise.race(
			[prompt, this.process.then(() => {throw new Error('Debugger exited during startup');})]
		);

		await this.command('set pagination off');
		await this.command('set colors off');
		this.emit({type: 'state', state: 'ready'});
	}

	output({type, bytes, evaluating})
	{
		const channel = type === 1 && !evaluating
			? 'stdout'
			: type === 2 && !evaluating ? 'stderr' : 'debug';

		// Notices are phpdbg's own chatter; errors and evaluation output answer something the user
		// did.
		const kind = channel !== 'debug'
			? null
			: type === 3 ? 'error' : evaluating ? 'evaluation' : 'notice';

		const key = `${channel}:${type}:${evaluating}`;
		let stream = this.decoders.get(key);

		if(!stream)
		{
			this.decoders.set(key, stream = {
				decoder: new TextDecoder()
				, event: kind ? {channel, kind} : {channel}
			});
		}

		const text = stream.decoder.decode(bytes, {stream: true});

		// A print command's lines are its answer, not chatter; each arrives whole.
		if(this.printing && !evaluating && [0, 3].includes(type))
		{
			(type === 3 ? this.printErrors : this.printing).push(type === 3 ? text : text + '\n');

			return;
		}

		if(type === 3 && text)
		{
			const diagnostic = {message: text, phase: evaluating ? 'evaluation' : 'execution'};
			this.commandErrors?.push(diagnostic);

			if(!evaluating)
			{
				this.diagnostics.push(diagnostic);
			}

			this.emit({type: 'diagnostic', ...diagnostic});
		}

		if(text)
		{
			this.emit({type: 'output', ...stream.event, text});
		}
	}

	writeFile(path, content)
	{
		const parts = path.split('/');
		parts.pop();
		let dir = '';

		for(const part of parts)
		{
			if(!part)
			{
				continue;
			}

			dir += '/' + part;

			if(!this.binary.FS.analyzePath(dir).exists)
			{
				this.binary.FS.mkdir(dir);
			}
		}

		this.binary.FS.writeFile(path, content);
	}

	waitPrompt() {const wait = deferred(); this.waiters.add(wait); return wait.promise;}

	async command(line)
	{
		if(this.closed)
		{
			throw new Error('Debugger is closed');
		}

		const prompt = this.waitPrompt();
		await this.php.provideInput(line);
		await Promise.race([prompt, this.process]);
		this.php.flush();
	}

	async execute(config)
	{
		this.config = config;
		this.diagnostics = [];
		this.exception = null;

		for(const [path, content] of Object.entries(config.files || {}))
		{
			this.writeFile(normalizePath(path), content);
		}

		this.writeFile(config.entrypoint, config.code);
		this.php.inputString(config.stdin || '');
		await this.command(`exec ${config.entrypoint}`);

		if(!this.binary.ccall('php_wasm_dbg_has_context', 'number', [], []))
		{
			return this.finish(255);
		}

		await this.breakpoints(config.breakpoints);

		return this.resume('run');
	}

	async breakpoints(breakpoints)
	{
		await this.command('clear');

		// A test run never pauses, so of its breakpoints only those that log are kept.
		const enabled = breakpoints.filter(
			bp => bp.enabled && (this.config?.mode !== 'test' || bp.log)
		);

		this.installedBreakpoints = enabled;

		for(const bp of enabled)
		{
			await this.command(`break ${bp.file}:${bp.line}`);
		}
	}

	invalidate() {this.epoch++; this.references.clear();}

	async resume(command = 'continue')
	{
		if(command !== 'run' && !this.paused)
		{
			throw new Error('The debugger is not paused');
		}

		this.paused = false;
		this.frame = 0;
		this.invalidate();
		this.exception = null;
		await this.php.switchFrame(0);
		this.emit({type: 'state', state: 'running'});
		await this.command(command);

		while(await this.php.isRunning())
		{
			const file = await this.php.currentFile();
			const line = await this.php.currentLine();

			// Run and Continue stop at breakpoints; one with a condition or a log decides here
			// whether execution pauses.
			const reached = !this.pauseRequested && !this.exception
				&& ['run', 'continue'].includes(command)
				? this.installedBreakpoints?.find(bp => bp.file === file && bp.line === line)
				: null;

			const decides = reached && (reached.condition || reached.log);

			if(decides && !await this.reachBreakpoint(reached))
			{
				await this.command('continue');
				continue;
			}

			if(this.config.mode === 'test' && !this.pauseRequested)
			{
				await this.command('continue');
				continue;
			}

			this.paused = true;
			const location = {file, line, frame: 0, pauseId: this.epoch};

			const reason = this.pauseRequested
				? 'pause'
				: this.exception
					? 'exception'
					: command === 'continue' || command === 'run' ? 'breakpoint' : 'step';

			this.pauseRequested = false;
			this.emit({type: 'paused', reason, location});

			return location;
		}

		return this.finish();
	}

	/**
	 * Execution has reached a breakpoint with a condition or a log, in the frame it stopped in.
	 * A condition must be true for anything to happen. Then a log prints its value and execution
	 * goes on; a breakpoint without one pauses. Answers whether to pause.
	 *
	 * A condition PHP cannot evaluate pauses, with the reason in the console, so the mistake is
	 * seen; in a test run, which never pauses, the reason is logged instead.
	 */
	async reachBreakpoint(bp)
	{
		// Evaluating needs a paused frame; whatever it leaves behind goes before anything else.
		this.paused = true;

		const where = {file: bp.file, line: bp.line};

		try
		{
			if(bp.condition)
			{
				let met;

				try
				{
					met = (await this.evaluateWithin('(bool) (', bp.condition, ')', 0)).value;
				}
				catch(error)
				{
					const message = `The condition at ${bp.file}:${bp.line} failed: `
						+ error.message;

					if(this.config.mode === 'test')
					{
						this.emit({type: 'log', ...where, message, error: true});

						return false;
					}

					const text = `${message}\n`;

					this.emit({type: 'output', channel: 'debug', kind: 'error', text});

					return true;
				}

				if(met !== true)
				{
					return false;
				}
			}

			if(!bp.log)
			{
				return true;
			}

			let message;
			let error = false;

			try
			{
				message = (await this.evaluateWithin(logged, bp.log, ')', 0)).value;
			}
			catch(failure)
			{
				message = failure.message;
				error = true;
			}

			this.emit({type: 'log', ...where, message, ...error && {error}});

			return false;
		}
		finally
		{
			this.paused = false;
			this.invalidate();
		}
	}

	async finish(compilationExitCode)
	{
		if(this.closed)
		{
			return;
		}

		await this.php.provideInput('quit');
		const exitCode = await this.process;
		this.php.flush();
		this.closed = true;
		this.paused = false;
		this.invalidate();

		for(const {decoder, event} of this.decoders.values())
		{
			const text = decoder.decode();

			if(text)
			{
				this.emit({type: 'output', ...event, text});
			}
		}

		this.emit(
			{
				type: 'complete'
				, exitCode: compilationExitCode ?? exitCode
				, diagnostics: this.diagnostics
			}
		);
	}

	pause()
	{
		if(this.closed)
		{
			throw new Error('Debugger is closed');
		}

		this.pauseRequested = true;
		this.binary.dbgPauseRequested = true;
	}

	async stop()
	{
		if(this.closed)
		{
			return;
		}

		if(!this.process)
		{
			this.closed = true;

			return;
		}

		if(this.paused || !await this.php.isRunning())
		{
			await this.php.provideInput('quit');
			await this.process;
		}
		else
		{
			this.binary.dbgStopRequested = true;
			await this.process;
		}

		this.closed = true;
		this.invalidate();
	}

	assertPaused()
	{
		if(!this.paused || this.closed)
		{
			throw new Error('Inspection requires paused execution');
		}
	}

	async selectFrame(frame)
	{
		this.assertPaused();

		if(!Number.isInteger(frame) || frame < 0 || await this.php.switchFrame(frame) < 0)
		{
			throw new RangeError('Invalid frame');
		}

		this.frame = frame;

		return {frame};
	}

	async frames()
	{
		if(this.dbgApi >= 2)
		{
			return this.php.dumpBacktrace();
		}

		// An older runtime lists frames starting at the selected one; list from the top so indexes
		// match selectFrame().
		const selected = this.frame;

		if(selected)
		{
			await this.php.switchFrame(0);
		}

		try
		{
			const frames = await this.php.dumpBacktrace();

			return frames.map(frame => ({...frame, selected: frame.frame === selected}));
		}
		finally
		{
			if(selected)
			{
				await this.php.switchFrame(selected);
			}
		}
	}

	type(value)
	{
		if(value === null)
		{
			return 'null';
		}

		if(typeof value !== 'object')
		{
			return typeof value;
		}

		const symbol = Object.getOwnPropertySymbols(value).find(s => s.description === 'origZval');

		if(symbol)
		{
			const type = this.binary.getValue(value[symbol] + 8, 'i32') & 255;

			if(type === 7)
			{
				return 'array';
			}
		}

		return Array.isArray(value) ? 'array' : 'object';
	}

	identity(value)
	{
		if(!value || typeof value !== 'object')
		{
			return null;
		}

		const symbol = Object.getOwnPropertySymbols(value).find(s => s.description === 'origZval');

		return symbol ? `${this.type(value)}:${this.binary.getValue(value[symbol], 'i32')}` : value;
	}

	display({type, className, count}, value)
	{
		if(type === 'array')
		{
			return `array(${count})`;
		}

		if(type === 'object')
		{
			return className ? phpClassLabel(className) : 'object';
		}

		if(type === 'string')
		{
			return JSON.stringify(value);
		}

		// PHP prints 3.0 as 3; keep the float visible.
		if(type === 'float' && Number.isInteger(value))
		{
			return value.toFixed(1);
		}

		return type === 'null' ? 'null' : String(value);
	}

	symbolExpression(scope, name)
	{
		return scope === 'constants'
			? null
			: scope === 'globals' ? `$GLOBALS[${phpString(name)}]` : '${' + phpString(name) + '}';
	}

	/** info is the runtime's own description of the value, when it can give one. */
	describe(name, value, expression, writable = true, frame = this.frame, ancestors = [], info =
	null
	){
		// Without info, undefined is how the runtime hands back a variable the frame declares but
		// has not assigned yet.
		const unset = info ? info.type === 'undefined' : value === undefined && !ancestors.length;
		const type = unset ? 'unset' : info?.type || this.type(value);

		const identity = this.identity(value);

		const circular = identity !== null && ancestors.includes(identity);
		const expandable = value !== null && typeof value === 'object' && !circular;
		const reference = `${this.sessionId}:${this.epoch}:${++this.nextReference}`;

		this.references.set(
			reference
			, {name, value, expression, writable, frame, ancestors: [...ancestors, identity], type}
		);

		return {
			name
			, type
			, reference
			, expandable
			, circular

			// A function stands for a callable PHP value, which can be neither shown nor assigned.
			, writable: !!expression && writable && typeof value !== 'function'
			, ...(info && {className: info.className, count: info.count})
			, value: expandable || circular || typeof value === 'function' ? undefined : value
			, displayValue: this.text(value, type, {unset, circular, expandable, info})
		};
	}

	/** The text the inspector shows for a value. */
	text(value, type, {unset, circular, expandable, info})
	{
		if(unset)
		{
			return 'unset';
		}

		if(circular)
		{
			return '[Circular]';
		}

		if(info)
		{
			return this.display(info, value);
		}

		if(expandable)
		{
			return type === 'array' ? 'Array' : 'Object';
		}

		return typeof value === 'string' ? JSON.stringify(value) : String(value);
	}

	async inspect(scope = 'variables', options = {})
	{
		this.assertPaused();

		if(options.frame !== undefined)
		{
			await this.selectFrame(options.frame);
		}

		const methods = {
			variables: 'dumpVars'
			, globals: 'dumpGlobals'
			, constants: 'dumpConstants'
			, functions: 'dumpFunctions'
			, classes: 'dumpClasses'
			, files: 'dumpFiles'
			, frames: 'dumpBacktrace'
		};

		if(!methods[scope])
		{
			throw new TypeError(`Unknown inspection scope: ${scope}`);
		}

		if(this.dbgApi >= 2 && ['variables', 'globals', 'constants'].includes(scope))
		{
			const symbols = await (scope === 'variables'
				? this.php.describeVars()
				: scope === 'globals'
					? this.php.describeGlobals({user: true})
					: this.php.describeConstants()
			);

			const describe = symbol => this.describe(
				symbol.name
				, symbol.value
				, this.symbolExpression(scope, symbol.name)
				, scope !== 'constants'
				, this.frame
				, []
				, symbol
			);

			return symbols.map(describe);
		}

		let values = scope === 'frames'
			? await this.frames()
			: await this.php[methods[scope]]() || {};

		if(scope === 'globals')
		{
			// The low-level dump arms superglobals but filters out user-defined globals.
			const globals = await this.evaluate('$GLOBALS');
			values = this.references.get(globals.reference).value;
		}

		if(scope === 'files')
		{
			return [...new Set([this.config.entrypoint, ...values])];
		}

		if(['functions', 'classes', 'frames'].includes(scope))
		{
			return values;
		}

		return Object.entries(values).map(
			([name, value]) => this.describe(
				name
				, value
				, this.symbolExpression(scope, name)
				, scope !== 'constants'
			)
		);
	}

	async children(reference, {offset = 0, limit = 100} = {})
	{
		this.assertPaused();
		const parent = this.references.get(reference);

		if(!parent)
		{
			throw new Error('Stale variable reference');
		}

		if(!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1
		|| limit > 1000
		){
			throw new RangeError('Invalid inspection page');
		}

		const type = parent.type;
		// Object.keys() gives an object's public properties. Its own keys also include the private
		// and protected ones, under PHP's mangled names ("\0Class\0name", "\0*\0name"), and a
		// runtime with debugger API 2 can read those by key.
		const names = this.dbgApi >= 2 && type === 'object'
			? Reflect.ownKeys(parent.value).filter(name => typeof name === 'string')
			: Object.keys(parent.value);

		const values = [];

		for(const key of names.slice(offset, offset + limit))
		{
			// Only a property name is mangled. An array key is shown whole, NUL bytes included.
			const {name, visibility} = type === 'object' ? phpPropertyName(key) : {name: key};

			const expression = !parent.expression
				? null
				: type === 'array'
					? `${parent.expression}[${phpString(key)}]`
					: `${parent.expression}->{${phpString(name)}}`;

			try
			{
				// Asking by key keeps the child's own PHP type; a float of 3.0 is just the number 3
				// once converted.
				const info = this.dbgApi >= 2
					? await this.php.describeChild(parent.value, key)
					: null;

				// An expression evaluated from outside the class cannot assign a private or
				// protected property.
				const value = this.describe(
					name
					, info ? info.value : parent.value[key]
					, expression
					, parent.writable && (visibility ?? 'public') === 'public'
					, parent.frame
					, parent.ancestors
					, info
				);

				values.push(visibility ? {...value, visibility} : value);
			}
			catch(error)
			{
				values.push(unavailable(name, error));
			}
		}

		return {values, total: names.length, offset};
	}

	/**
	 * The ops phpdbg's print command lists. With no target, the selected frame's function, and
	 * `current` is the op that frame stands on; or the main script, a function or a class.
	 */
	async opcodes(target = {})
	{
		this.assertPaused();

		const name = target.function ?? target.class;

		// A name reaches the phpdbg command line, so it must be a PHP name and nothing more.
		if(name !== undefined && !phpName.test(name))
		{
			throw new TypeError(`Not a PHP function or class name: ${name}`);
		}

		const command = target.function !== undefined
			? `print func ${name}`
			: target.class !== undefined
				? `print class ${name}`
				: target.script ? 'print exec' : 'print stack';

		const functions = parseOpcodes(await this.printed(command));

		const current = command === 'print stack'
			? parseOpline(await this.printed('print opline'), functions)
			: null;

		return {functions, current};
	}

	/**
	 * What a print command lists. From PHP 8.1 that is the dump PHP writes to standard error, and
	 * phpdbg's own lines around it, such as the internal methods it names after a class, are no
	 * part of it; PHP 8.0's phpdbg writes the listing itself. None of it reaches the console or
	 * the run's diagnostics; an error is thrown.
	 */
	async printed(command)
	{
		const own = [];
		const dumped = [];

		/** Standard error arrives a line at a time. */
		const listen = event => dumped.push(...event.detail);

		this.printing = own;
		this.printErrors = [];
		this.php.addEventListener('error', listen);

		try
		{
			await this.command(command);
		}
		finally
		{
			this.php.removeEventListener('error', listen);
			this.printing = null;
		}

		if(this.printErrors.length)
		{
			throw new Error(this.printErrors.join('\n'));
		}

		return (dumped.length ? dumped : own).join('');
	}

	async evaluate(expression, {frame = this.frame} = {})
	{
		this.assertPaused();

		if(typeof expression !== 'string' || !expression.trim())
		{
			throw new TypeError('Enter a PHP expression');
		}

		return this.evaluateWithin('', expression, '', frame);
	}

	/**
	 * Evaluate `before`, the expression and `after` as one PHP expression in a frame. Only the
	 * middle part is the user's, and errors are worded for it alone.
	 */
	async evaluateWithin(before, expression, after, frame)
	{
		// "$n + 1;" is what people type; the semicolon is not part of the expression.
		expression = expression.replace(/;\s*$/, '');

		const previous = this.frame;
		await this.selectFrame(frame);
		this.captured = null;
		this.commandErrors = [];

		try
		{
			// A file avoids phpdbg's line-length limit and preserves multiline expressions. The
			// expression has lines to itself, so a comment at its end cannot swallow the closing
			// parenthesis and a syntax error's line says whether it is in the expression.
			this.writeFile(
				'/.php-debugger/eval.php'
				, `return (${before}\n${expression}\n${after});`
			);

			await this.command(
				"ev vrzno_shared('__phpDebugger')->capture("
				+ "eval(file_get_contents('/.php-debugger/run.php')))"
			);

			if(!this.captured)
			{
				throw new Error(
					this.commandErrors.map(d => d.message).join('\n')
					|| 'PHP expression evaluation failed'
				);
			}

			// [true, value], or [false, class, message, line of a syntax error].
			const outcome = this.captured.value;

			if(!outcome[0])
			{
				throw new Error(evaluationError(expression, outcome[1], outcome[2], outcome[3]));
			}

			// Read as a plain element, a float of 3.0 arrives as the number 3 and its PHP type is
			// gone. An API 2 runtime describes the element where it is, as it does any other child.
			const info = this.dbgApi >= 2 ? await this.php.describeChild(outcome, '1') : null;
			const value = info ? info.value : outcome[1];
			const code = `${before}${expression}${after}`;

			return this.describe(code, value, code, true, this.frame, [], info);
		}
		finally
		{
			this.commandErrors = null;
			await this.selectFrame(previous);
		}
	}

	async setVariable(reference, expression)
	{
		this.assertPaused();
		const variable = this.references.get(reference);

		if(!variable)
		{
			throw new Error('Stale variable reference');
		}

		if(!variable.expression || !variable.writable)
		{
			throw new Error('This value is read-only');
		}

		if(typeof expression !== 'string' || !expression.trim())
		{
			throw new TypeError('Enter a PHP expression');
		}

		const evaluated = await this.evaluateWithin(
			`${variable.expression} = (`
			, expression
			, ')'
			, variable.frame
		);

		const info = this.dbgApi >= 2
			? {type: evaluated.type, className: evaluated.className, count: evaluated.count}
			: null;

		const value = this.describe(
			variable.name
			, this.references.get(evaluated.reference).value
			, variable.expression
			, variable.writable
			, variable.frame
			, variable.ancestors.slice(0, -1)
			, info
		);

		this.references.delete(evaluated.reference);
		this.emit({type: 'variablechange', reference, value});

		return value;
	}

	invoke(method, args = [])
	{
		const allowed = [
			'execute', 'breakpoints', 'resume', 'pause', 'stop', 'inspect'
			, 'children', 'selectFrame', 'evaluate', 'setVariable', 'opcodes'
		];

		if(!allowed.includes(method))
		{
			return Promise.reject(new Error('Unknown debugger operation'));
		}

		// Pause/stop must be able to arrive while an execution command is waiting.
		if(method === 'pause' || method === 'stop')
		{
			return Promise.resolve(this[method](...args));
		}

		const task = this.serial.then(() => this[method](...args));
		this.serial = task.catch(() => {});

		return task;
	}
}
