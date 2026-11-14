import {
	deferred
	, phpString
	, normalizePath
	, phpClassLabel
	, phpPropertyName
	, evaluationError

	, isPhpName
	, parseOpcodes
	, parseOpline
} from './model.mjs';

/**
 * What an "ev" command runs for the expression in a file of /.php-debugger, in the paused frame.
 * The inner eval() compiles and runs the expression in that frame too, so a syntax error or an
 * uncaught exception arrives in this catch block. Left to phpdbg, either one is reported as the
 * script's own fatal error, and a run that then ends normally exits with 255.
 */
const runner = name => `try
{
	return [true, eval(file_get_contents('/.php-debugger/${name}.php'))];
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

// The runner for each file an expression is put in: the one evaluate() uses, and those for a
// breakpoint's condition and its log.
const runners = {run: 'eval', 'run-condition': 'condition', 'run-log': 'log'};

/** The PHP that runs a runner and is its answer. */
const answer = name => `eval(file_get_contents('/.php-debugger/${name}.php'))`;

/** The PHP that hands a value to the debugger, through its `capture` or its `decide`. */
const handed = (method, php) => `vrzno_shared('__phpDebugger')->${method}(${php})`;

// What a logpoint's expression is wrapped in: a string is logged as it is, anything else as
// var_export() writes it.
const logged = '(static fn($value) => is_string($value) ? $value : var_export($value, true))(';

/**
 * A value that is not text as PHP writes it: INF, -INF and NAN are its words for what JavaScript
 * calls Infinity and NaN, and they are what an edit can hand back.
 */
const phpNumber = value => typeof value !== 'number' || Number.isFinite(value)
	? String(value)
	: Number.isNaN(value) ? 'NAN' : value < 0 ? '-INF' : 'INF';

/** What the inspector lists for a child it could not read. */
const unavailable = (name, error) => ({
	name
	, type: 'unavailable'
	, displayValue: error.message
	, writable: false
	, expandable: false
});

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
		this.deciding = false;

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
			, __phpDebugger: {
				capture: value => {this.captured = {value};}

				// A condition's answer, [true, bool] when PHP could evaluate it. PHP goes on to the
				// log only when this says the condition held.
				, decide: value => {
					this.decided = {value};

					return value[0] === true && value[1] === true;
				}
			}
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

		for(const [file, expression] of Object.entries(runners))
		{
			this.writeFile(`/.php-debugger/${file}.php`, runner(expression));
		}

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

		// The runtime makes room for as many bytes as the line has characters and cuts what is
		// over, so a name in other than ASCII lost its end: "caféé" was read as "café". Spaces
		// after the line make the room.
		const over = new TextEncoder().encode(line).length - line.length;

		await this.php.provideInput(line + ' '.repeat(over));
		await Promise.race([prompt, this.process]);
		this.php.flush();
	}

	async execute(config)
	{
		this.config = config;
		this.diagnostics = [];
		this.exception = null;

		// The text of each file by its path, for what a breakpoint's line holds.
		this.sources = new Map([[config.entrypoint, config.code]]);

		for(const [path, content] of Object.entries(config.files || {}))
		{
			this.writeFile(normalizePath(path), content);
			this.sources.set(normalizePath(path), content);
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

	/**
	 * Switch phpdbg's breakpoints on for PHP to run and off while it is stopped, so that nothing
	 * the debugger evaluates or reads there, a function a condition calls or a magic method a
	 * value has, stops at one. The runtime exports the two switches; one without them is told by
	 * command.
	 */
	async arm(on)
	{
		const direct = on ? '_phpdbg_enable_breakpoints' : '_phpdbg_disable_breakpoints';

		if(typeof this.binary?.[direct] === 'function')
		{
			this.binary[direct]();

			return;
		}

		await this.command(`set breaks ${on ? 'on' : 'off'}`);
	}

	/** Let PHP run, by a phpdbg command, until it next stops or ends. */
	async go(command)
	{
		await this.arm(true);
		await this.command(command);
	}

	/**
	 * Start what a resume asks for. Two of phpdbg's commands do not stop where their names say:
	 * "finish" runs on past the caller, and "until" past the next line, to the next breakpoint or
	 * the end. Stepping out is therefore "leave", which stops where the function returns, and
	 * one step from there into the caller; Until is a step over a line, which resume() repeats.
	 */
	async begin(command)
	{
		if(command !== 'finish')
		{
			return this.go(command === 'until' ? 'next' : command);
		}

		await this.go('leave');

		// Stopped where the function returns, and not by an exception or a pause on the way.
		if(await this.php.isRunning() && !this.exception && !this.pauseRequested)
		{
			await this.go('step');
		}
	}

	/**
	 * Where execution paused, for Until: its line, and how deep the stack is. The line is the
	 * one the pause was reported at; the runtime's own answer is the evaluation's once anything
	 * has been evaluated there.
	 */
	async place()
	{
		return {line: this.stopped.line, depth: (await this.frames()).length};
	}

	/** Whether execution is past the line Until began on: on a later one, or out of its frame. */
	async past(began, line)
	{
		return (await this.frames()).length !== began.depth || line > began.line;
	}

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

		// Run and Continue stop at breakpoints; a step stops where it lands.
		const continues = ['run', 'continue'].includes(command);

		// Until goes on line by line from where it began, and stops once past that line.
		const began = command === 'until' ? await this.place() : null;

		await this.begin(command);

		while(await this.php.isRunning())
		{
			await this.arm(false);

			const file = await this.php.currentFile();
			const line = await this.php.currentLine();
			const interrupted = this.pauseRequested || this.exception;

			// The breakpoint on this line, unless execution stopped here for another reason.
			const reached = interrupted
				? null
				: this.installedBreakpoints?.find(bp => bp.file === file && bp.line === line);

			// Until, not yet past its line, meets a breakpoint as Continue does.
			const seeking = !!began && !interrupted && !await this.past(began, line);
			const meets = continues || seeking;

			// A breakpoint says whether execution pauses at it; without one, only Until's search
			// goes on. A test run never pauses. A pause asked for while a breakpoint was deciding
			// is answered here.
			const passes = (reached ? !await this.reach(reached, meets) : seeking)
				|| this.config.mode === 'test';

			if(passes && !this.pauseRequested)
			{
				await this.go(began ? 'next' : 'continue');

				continue;
			}

			this.paused = true;
			const location = this.stopped = {file, line, frame: 0, pauseId: this.epoch};

			const reason = this.pauseRequested
				? 'pause'
				: this.exception
					? 'exception'
					: meets ? 'breakpoint' : 'step';

			// The pause asked for is this one, whatever stopped PHP here.
			this.pauseRequested = false;
			this.binary.dbgPauseRequested = false;
			this.emit({type: 'paused', reason, location});

			return location;
		}

		return this.finish();
	}

	/**
	 * Execution has stopped on a breakpoint's line, by Run or Continue or by a step. Answers
	 * whether it pauses there on the breakpoint's account.
	 *
	 * A condition must be true for anything to happen; then a log prints its value and execution
	 * goes on, and a breakpoint without one pauses. A step pauses where it lands whatever the
	 * breakpoint says, after any log.
	 *
	 * A line a call was made on is reached again, as phpdbg sees it, when the call returns. A
	 * breakpoint that pauses does so again, as phpdbg's do; a log is for arriving at the line, and
	 * is not printed a second time.
	 *
	 * A condition PHP cannot evaluate pauses, with the reason in the console, so the mistake is
	 * seen; in a test run, which never pauses, the reason is logged instead.
	 */
	async reach(bp, continues)
	{
		// A step has only the line's log to print.
		if(!continues && !bp.log)
		{
			return true;
		}

		const where = {file: bp.file, line: bp.line};

		this.deciding = true;

		try
		{
			if(!bp.condition && !bp.log)
			{
				return true;
			}

			if(bp.log && await this.returned(bp))
			{
				return !continues;
			}

			const {met, message, failed} = await this.decide(bp);

			if(failed === 'condition')
			{
				const reason = `The condition at ${bp.file}:${bp.line} failed: ${message}`;

				if(this.config.mode === 'test')
				{
					this.emit({type: 'log', ...where, message: reason, error: true});

					return false;
				}

				this.emit({type: 'output', channel: 'debug', kind: 'error', text: `${reason}\n`});

				return true;
			}

			if(met && bp.log)
			{
				this.emit({type: 'log', ...where, message, ...failed && {error: true}});
			}

			// Met and with nothing to log, it is a breakpoint to pause at.
			return met && !bp.log || !continues;
		}
		finally
		{
			this.deciding = false;
		}
	}

	/**
	 * Whether execution is on a logpoint's line because a call made on it has returned, which
	 * phpdbg reports as it does reaching the line. Only a line that can make a call is asked
	 * about, so a logpoint on any other costs no command more.
	 */
	async returned(bp)
	{
		const source = this.sources?.get(bp.file);
		const text = typeof source === 'string' ? source.split('\n')[bp.line - 1] : null;

		if(typeof text === 'string' && !/\(|\bnew\b/.test(text))
		{
			return false;
		}

		return /\bEXT_FCALL_END\b/.test(await this.printed('print opline'));
	}

	/**
	 * Evaluate a breakpoint's condition and, when it holds, its log, in one command, in the frame
	 * that reached the line. Answers {met, message, failed}: `failed` is the part PHP could not
	 * evaluate, "condition" or "log", and `message` is then the reason.
	 */
	async decide(bp)
	{
		const condition = bp.condition && this.stage('condition', '(bool) (', bp.condition, ')');
		const log = bp.log && this.stage('log', logged, bp.log, ')');
		const logs = log ? answer('run-log') : 'null';

		const {captured, decided, errors} = await this.ev(
			condition ? `${handed('decide', answer('run-condition'))} ? ${logs} : null` : logs
		);

		/** Why PHP could not evaluate an expression: what its runner answered, if it did. */
		const reason = (expression, answered) => answered
			? evaluationError(expression, answered[1], answered[2], answered[3])
			: errors || 'PHP expression evaluation failed';

		if(condition && decided?.[0] !== true)
		{
			return {met: false, failed: 'condition', message: reason(condition, decided)};
		}

		if(condition && decided[1] !== true)
		{
			return {met: false};
		}

		if(!log)
		{
			return {met: true};
		}

		// The log's own answer, [true, message]; anything else is why there is none.
		return captured?.[0] === true
			? {met: true, message: captured[1]}
			: {met: true, failed: 'log', message: reason(log, captured)};
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

		// PHP stopped on a breakpoint that is still deciding is not asked: it would stop inside
		// the condition or the log. resume() pauses there once they are done.
		if(!this.deciding)
		{
			this.binary.dbgPauseRequested = true;
		}
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

		// What a resource is cannot be shown, only that it is one.
		if(type === 'resource')
		{
			return 'resource';
		}

		return type === 'null' ? 'null' : phpNumber(value);
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

		// A resource has nothing inside to list, and no PHP that would write it again.
		const opaque = type === 'resource';
		const expandable = value !== null && typeof value === 'object' && !circular && !opaque;
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
			, writable: !!expression && writable && typeof value !== 'function' && !opaque
			, ...(info && {className: info.className, count: info.count})
			, value: expandable || circular || opaque || typeof value === 'function'
				? undefined
				: value
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

		return typeof value === 'string' ? JSON.stringify(value) : phpNumber(value);
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
				const described = this.dbgApi >= 2
					? await this.php.describeChild(parent.value, key)
					: null;

				// A runtime describes a private or protected property, but may look for its value
				// on the object as JavaScript sees it, where it is not.
				const withheld = described?.value === undefined
					&& !['undefined', 'null'].includes(described?.type ?? 'null')
					&& (visibility ?? 'public') !== 'public';

				const read = withheld ? await this.concealed(parent, key) : null;
				const info = read?.info ?? described;

				// An expression evaluated from outside the class cannot assign a private or
				// protected property.
				const value = this.describe(
					name
					, info ? info.value : parent.value[key]
					, read?.expression ?? expression
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
	 * A private or protected property, read by PHP from inside the class that may see it: the
	 * class that declares a private one, the object's own for a protected one. Answers the
	 * runtime's description of it, value included, and the expression that read it, by which what
	 * it holds can be read in turn.
	 */
	async concealed(parent, key)
	{
		if(!parent.expression)
		{
			throw new Error('This property cannot be read from here');
		}

		const {name} = phpPropertyName(key);
		const owner = key.slice(1, key.lastIndexOf('\0'));
		const reads = `static fn($object) => $object->{${phpString(name)}}`;

		const before = owner === '*'
			? `(static fn($object) => \\Closure::bind(${reads}, null, $object)($object))(`
			: `\\Closure::bind(${reads}, null, ${phpString(owner)})(`;

		const previous = this.frame;

		await this.selectFrame(parent.frame);

		try
		{
			const {captured} = await this.evaluated(before, parent.expression, ')');
			const info = await this.php.describeChild(captured, '1');

			return {info, expression: `${before}${parent.expression})`};
		}
		finally
		{
			await this.selectFrame(previous);
		}
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
		if(name !== undefined && !isPhpName(name))
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
		const previous = this.frame;

		await this.selectFrame(frame);

		try
		{
			const {captured, written} = await this.evaluated(before, expression, after);

			// Read as a plain element, a float of 3.0 arrives as the number 3 and its PHP type is
			// gone. An API 2 runtime describes the element where it is, as it does any other child.
			const info = this.dbgApi >= 2 ? await this.php.describeChild(captured, '1') : null;
			const value = info ? info.value : captured[1];
			const code = `${before}${written}${after}`;

			return this.describe(code, value, code, true, this.frame, [], info);
		}
		finally
		{
			await this.selectFrame(previous);
		}
	}

	/**
	 * Evaluate `before`, the expression and `after` in the selected frame. Answers the runner's
	 * [true, value] and the expression as it was written; an error is thrown, worded for the
	 * expression alone.
	 */
	async evaluated(before, expression, after)
	{
		const written = this.stage('eval', before, expression, after);
		const {captured, errors} = await this.ev(answer('run'));

		if(!captured)
		{
			throw new Error(errors || 'PHP expression evaluation failed');
		}

		// [true, value], or [false, class, message, line of a syntax error].
		if(!captured[0])
		{
			throw new Error(evaluationError(written, captured[1], captured[2], captured[3]));
		}

		return {captured, written};
	}

	/**
	 * Put an expression in the file a runner reads. A file avoids phpdbg's line-length limit and
	 * keeps a multiline expression whole. The expression has lines to itself, so a comment at its
	 * end cannot swallow what closes it and a syntax error's line says whether it is in the
	 * expression. Answers the expression as it was put there.
	 */
	stage(name, before, expression, after)
	{
		// "$n + 1;" is what people type; the semicolon is not part of the expression.
		const written = expression.replace(/;\s*$/, '');

		this.writeFile(`/.php-debugger/${name}.php`, `return (${before}\n${written}\n${after});`);

		return written;
	}

	/**
	 * Evaluate PHP by an "ev" command and hand its value to the debugger. Answers what came
	 * back: `captured`, the value; `decided`, a condition's answer when the PHP asked for one;
	 * and `errors`, what PHP reported meanwhile.
	 */
	async ev(php)
	{
		this.captured = null;
		this.decided = null;
		this.commandErrors = [];

		try
		{
			await this.command(`ev ${handed('capture', php)}`);

			const errors = this.commandErrors.map(d => d.message).join('\n');

			return {captured: this.captured?.value, decided: this.decided?.value, errors};
		}
		finally
		{
			this.commandErrors = null;
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
