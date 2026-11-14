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
	, plainLine
	, arrivesAt
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

				// The object whose hidden properties are being read: see unveiled().
				, subject: () => this.subject
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

		if(type === 0 && !evaluating)
		{
			this.heard?.push(text);
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

		// What is known of each logpoint's line, by its place: see arrived().
		this.arrivals = new Map();
		this.seek = null;

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

	/**
	 * Give phpdbg the breakpoints to stop at. `quiet` is for putting them back after a step's
	 * temporary ones: what phpdbg says about it then is not for the console.
	 */
	async breakpoints(breakpoints, quiet = false)
	{

		/** Give phpdbg one command. */
		const tell = line => quiet ? this.quietly(line) : this.command(line);

		// What was asked for, to put back when a step's temporary breakpoints go.
		this.given = breakpoints;
		await tell('clear');

		// A test run never pauses, so of its breakpoints only those that log are kept.
		const enabled = breakpoints.filter(
			bp => bp.enabled && (this.config?.mode !== 'test' || bp.log)
		);

		this.installedBreakpoints = enabled;

		for(const bp of enabled)
		{
			await tell(`break ${bp.file}:${bp.line}`);
		}
	}

	/** Give phpdbg a command whose answer, an error included, is nobody's business. */
	async quietly(line)
	{
		await this.printed(line).catch(() => {});
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

	/**
	 * Let PHP run, by a phpdbg command, until it next stops or ends. "leave" given where a
	 * function already returns runs nothing, and phpdbg says so; `unmoved` remembers it.
	 */
	async go(command)
	{
		await this.arm(true);
		this.heard = [];
		await this.command(command);
		this.unmoved = this.heard.some(text => text.includes('Already at the end of the function'));
		this.heard = null;
	}

	/**
	 * Start what a resume asks for. phpdbg's own "next", "finish" and "until" do not stop where
	 * their names say: "next" stops inside a call the line makes, and the other two run on past
	 * the caller or the next line, to the next breakpoint or the end. Step over, Until and Step
	 * out are therefore made here, of a step and of temporary breakpoints PHP runs on to.
	 */
	async begin(command, from)
	{
		const steps = {next: 'over', until: 'until', finish: 'out'};

		return steps[command] ? this[steps[command]](from) : this.go(command);
	}

	/** Whether PHP has stopped of its own accord: not ended, thrown or been asked to pause. */
	async goes()
	{
		return await this.php.isRunning() && !this.exception && !this.pauseRequested;
	}

	/**
	 * Step over the line of a frame; `from` is where that is. A step is all it takes unless the
	 * line makes a call, where phpdbg stops at the call's first line. From there PHP runs on to
	 * another line of the frame the step began in.
	 */
	async over(from)
	{
		await this.go('step');

		// Where the stack cannot be measured, the step is left where phpdbg put it.
		if(await this.goes() && await this.depth() > (from.depth ?? Infinity))
		{
			await this.seekFrom(from, 'over');
		}
	}

	/**
	 * Until: a step, unless that lands back on the line or on an earlier one, as at the end of a
	 * loop, or inside a call. From there PHP runs on to a later line of the frame.
	 */
	async until(from)
	{
		await this.go('step');

		const landed = await this.goes()
			&& !this.ended({kind: 'until', from}, await this.php.currentLine(), await this.depth());

		if(landed)
		{
			await this.seekFrom(from, 'until');
		}
	}

	/**
	 * Step out: PHP runs on to a line of the caller. The main script has no caller and runs on
	 * as Continue does.
	 *
	 * A line breakpoint is met only when the line's number changes, so it cannot see a function
	 * return onto a line with the number of the line it returned from, as a function that calls
	 * itself does. There, and where the caller cannot be listed, the return is taken exactly.
	 */
	async out(from)
	{
		if(from.depth === 1)
		{
			return this.go('continue');
		}

		const own = from.depth === null ? null : await this.listed(0);
		const [, caller] = await this.frames().catch(() => []);
		const unseen = !own || (!own.generator && own.returns.includes(caller?.lineNo));

		if(unseen || !await this.seekFrom(from, 'out'))
		{
			await this.returnExactly();
		}
	}

	/**
	 * Run to where the function returns, by phpdbg's "leave", and one op further, which is the
	 * caller's, where it made the call. phpdbg passes breakpoints, and a pause, on the way.
	 */
	async returnExactly()
	{
		await this.go('leave');

		if(await this.goes())
		{
			await this.command('set stepping opcode');
			await this.go('step');
			await this.command('set stepping line');
		}
	}

	/**
	 * Run on to where a step ends, and answer whether that could be arranged. Temporary
	 * breakpoints go on the lines it may end on: the other lines of the function the step began
	 * in, the later ones for Until, and the lines of that function's caller, where execution
	 * comes out when the function returns first; for Step out, the caller's alone. resume()
	 * stops PHP at the first of them the step's own frame reaches, and takes them away again.
	 *
	 * PHP runs as it does for Continue: at full speed, stopping at breakpoints inside the calls
	 * it passes, and open to a pause.
	 */
	async seekFrom(from, kind)
	{
		// How far down the stack the frame the step began in is by now.
		const depth = await this.depth();
		const below = depth - from.depth;
		const own = kind === 'out' ? null : await this.listed(below);
		const caller = await this.listed(below + 1);

		if(!(kind === 'out' ? caller : own))
		{
			return false;
		}

		// Further out, the caller's caller and the outermost frame: where a return was not seen,
		// the step ends on the next line reached there, and never runs away.
		const further = [];

		for(const frame of new Set([below + 2, depth - 1]))
		{
			further.push(frame > below + 1 ? await this.listed(frame) : null);
		}

		/** Whether a line of the step's own function is one it may end on. */
		const ends = line => kind === 'until' ? line > from.line : line !== from.line;

		const lines = new Set([
			...own ? own.lines.filter(ends).map(line => `${own.file}:${line}`) : []
			, ...[caller, ...further].flatMap(
				listed => listed ? listed.lines.map(line => `${listed.file}:${line}`) : []
			)
		]);

		// The function called again, deeper, is run to where it returns. Not a generator, whose
		// first frame is gone before it returns.
		this.seek = {kind, from, lines, swift: !(own ?? caller).generator};

		for(const place of lines)
		{
			const [file, line] = place.split(/:(?=\d+$)/);

			// A line with a breakpoint of its own stops PHP already.
			if(!this.installedBreakpoints.some(bp => bp.file === file && bp.line === Number(line)))
			{
				await this.quietly(`break ${place}`);
			}
		}

		await this.go('continue');

		return true;
	}

	/**
	 * The function a frame is in, from its listing, as outline() has it. Null where there is no
	 * such frame or nothing to list, or its file is not one a breakpoint can name.
	 */
	async listed(frame)
	{
		const there = !frame || await this.php.switchFrame(frame) >= 0;

		const [listed] = there
			? await this.printed('print stack').then(parseOpcodes, () => [])
			: [];

		if(frame)
		{
			await this.php.switchFrame(0);
		}

		return listed?.file && !/[\s:]/.test(listed.file) ? this.outline(listed) : null;
	}

	/**
	 * What a step needs of a listed function: its file, the lines its ops are on, the lines it
	 * returns from, and whether it is a generator.
	 */
	outline({file, ops})
	{
		const lines = [...new Set(ops.map(op => op.line))];

		// PHP 8.0 writes a number after some opcodes: "RETURN<-1>".
		const returns = ops.filter(op => /^(?:GENERATOR_)?RETURN\b/.test(op.opcode)).map(
			op => op.line
		);

		const generator = ops.some(op => op.opcode === 'GENERATOR_CREATE');

		return {file, lines, returns, generator};
	}

	/** Whether a step PHP is running on for ends where PHP has stopped. */
	ended({kind, from}, line, depth)
	{
		// Where the stack cannot be measured, wherever PHP stopped is where the step ends.
		if(depth === null || depth < from.depth)
		{
			return true;
		}

		if(kind === 'out' || depth > from.depth)
		{
			return false;
		}

		return kind === 'until' ? line > from.line : line !== from.line;
	}

	/**
	 * Carry on from a stop that is not a pause. `again` says a step's temporary breakpoint was
	 * met deeper than the step began: its function has been called again. That call is run to
	 * where it returns first, or each of its lines would be a stop of its own.
	 */
	async onward(again)
	{
		if(again && this.seek.swift)
		{
			await this.go('leave');

			if(!await this.goes())
			{
				return;
			}
		}

		await this.go('continue');
	}

	/** Take a step's temporary breakpoints away, once it has ended or been stopped. */
	async settle()
	{
		const seek = this.seek;

		this.seek = null;

		if(seek)
		{
			await this.breakpoints(this.given, true);
		}
	}

	/**
	 * How deep the stack is, in frames of the program's own. The runtime is asked whether there
	 * is a frame of each number in turn. Its list of frames is not used: an older runtime's can
	 * fail with a function of PHP's own on the stack, as when array_map() calls back.
	 */
	async depth()
	{
		let depth = 1;

		while(depth < 4096 && await this.php.switchFrame(depth) >= 0)
		{
			depth++;
		}

		await this.php.switchFrame(0);

		return depth;
	}

	/**
	 * Where execution paused, for a step: its file and line, and how deep the stack is. The
	 * place is the one the pause was reported at; the runtime's own answer is the evaluation's
	 * once anything has been evaluated there.
	 */
	async place()
	{
		const {file, line} = this.stopped;

		return {file, line, depth: await this.depth()};
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
		const from = ['next', 'until', 'finish'].includes(command) ? await this.place() : null;

		await this.begin(command, from);

		while(await this.php.isRunning())
		{
			await this.arm(false);

			// A command that ran nothing leaves PHP where the last pause was, and the runtime's
			// answer for where that is may be an evaluation's.
			const unmoved = this.unmoved;
			const file = unmoved ? this.stopped.file : await this.php.currentFile();
			const line = unmoved ? this.stopped.line : await this.php.currentLine();
			const interrupted = this.pauseRequested || this.exception;
			const depth = this.seek && !interrupted ? await this.depth() : null;

			// A step PHP is running on for, not yet where it ends. It meets a breakpoint as
			// Continue does, but for the line it is stepping over, which is reached again as
			// each call made on it returns.
			const seeking = !!this.seek && !interrupted && !this.ended(this.seek, line, depth);
			const own = seeking && this.seek.kind === 'over' && depth === this.seek.from.depth;

			// The breakpoint on this line, unless execution stopped here for another reason.
			const reached = interrupted || unmoved || own
				? null
				: this.installedBreakpoints?.find(bp => bp.file === file && bp.line === line);

			const meets = continues || seeking;

			// A breakpoint says whether execution pauses at it; without one, only a step still
			// on its way goes on. A test run never pauses. A pause asked for while a breakpoint
			// was deciding is answered here.
			const passes = (reached ? !await this.reach(reached, meets) : seeking)
				|| this.config.mode === 'test';

			if(passes && !this.pauseRequested)
			{
				const again = seeking && !reached && depth > this.seek.from.depth
					&& this.seek.lines.has(`${file}:${line}`);

				await this.onward(again);

				continue;
			}

			await this.settle();

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

		this.seek = null;

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

			if(bp.log && !await this.arrived(bp))
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
	 * Whether execution has arrived at a logpoint's line, and is not merely back on it. phpdbg
	 * reports a line reached whenever execution comes to it from another: also when a call made
	 * on it returns, and when a statement written over several lines comes round to a line of
	 * its own again. The op execution stands on tells the two apart.
	 *
	 * The function is listed once for each logpoint. A line it can only arrive at is not asked
	 * about again, so a logpoint on one costs no command more.
	 */
	async arrived(bp)
	{
		const place = `${bp.file}:${bp.line}`;

		if(!this.arrivals.has(place))
		{
			const [listed] = await this.printed('print stack').then(parseOpcodes, () => []);

			this.arrivals.set(place, listed && !plainLine(listed.ops, bp.line) ? listed : null);
		}

		const listed = this.arrivals.get(place);

		if(!listed)
		{
			return true;
		}

		const at = parseOpline(await this.printed('print opline').catch(() => ''), [listed]);

		// An op that is not this function's, on this line, is another function's on the same
		// line: what is known of this one says nothing of it.
		return listed.ops[at?.index]?.line !== bp.line || arrivesAt(listed.ops, at.index);
	}

	/**
	 * Evaluate a breakpoint's condition and, when it holds, its log, in one command, in the frame
	 * that reached the line. Answers {met, message, failed}: `failed` is the part PHP could not
	 * evaluate, "condition" or "log", and `message` is then the reason.
	 */
	async decide(bp)
	{
		// Each is put where its runner reads it. One of nothing but a semicolon is not left
		// out, as if the breakpoint had none: it is said to be empty.
		const empty = 'The expression is empty';

		const [condition, log] = [['condition', '(bool) ('], ['log', logged]].map(
			([part, before]) => bp[part] ? this.stage(part, before, bp[part], ')').trim() : ''
		);

		if(bp.condition && !condition)
		{
			return {met: false, failed: 'condition', message: empty};
		}

		const logs = log ? answer('run-log') : 'null';

		const {captured, decided, errors} = await this.ev(
			bp.condition ? `${handed('decide', answer('run-condition'))} ? ${logs} : null` : logs
		);

		/** Why PHP could not evaluate an expression: what its runner answered, if it did. */
		const reason = (expression, answered) => answered
			? evaluationError(expression, answered[1], answered[2], answered[3])
			: errors || 'PHP expression evaluation failed';

		if(bp.condition && decided?.[0] !== true)
		{
			return {met: false, failed: 'condition', message: reason(condition, decided)};
		}

		if(bp.condition && decided[1] !== true)
		{
			return {met: false};
		}

		if(!bp.log)
		{
			return {met: true};
		}

		if(!log)
		{
			return {met: true, failed: 'log', message: empty};
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

		// The object's private and protected properties, read once if any is asked for.
		let hidden = null;

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

				hidden ??= withheld ? await this.unveiled(parent.value) : null;

				const info = withheld ? await hidden(key) : described;

				// An expression evaluated from outside the class cannot assign a private or
				// protected property, nor reach what is inside one.
				const value = this.describe(
					name
					, info ? info.value : parent.value[key]
					, withheld ? null : expression
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
	 * An object's private and protected properties, which the runtime describes without their
	 * values. PHP is handed the object the debugger already holds and casts it to an array,
	 * where every property stands under the key PHP stores it by, whatever class it is hidden
	 * in. Nothing of the program is evaluated again, and a built-in class's properties are read
	 * like any other's.
	 *
	 * Answers a function from such a key to the runtime's description of the property, value
	 * included.
	 */
	async unveiled(object)
	{
		this.subject = object;

		try
		{
			const {captured} = await this.evaluated(
				'(static fn($held) => [array_keys($held), array_values($held)])((array) '
				, handed('subject', '')
				, ')'
			);

			const [keys, held] = [captured[1][0], captured[1][1]];
			const places = new Map(Object.keys(keys).map(at => [keys[at], at]));

			return async key => {
				if(!places.has(key))
				{
					throw new Error('This property could not be read');
				}

				return this.php.describeChild(held, places.get(key));
			};
		}
		finally
		{
			this.subject = null;
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
