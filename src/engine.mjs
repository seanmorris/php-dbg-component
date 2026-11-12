import {deferred, phpString, normalizePath} from './model.mjs';

/** Lives beside the runtime, in a worker by default. Live Zend values stay here. */
export class DebugEngine {
  constructor(emit) {
    this.emit = emit; this.sequence = 0; this.waiters = new Set(); this.references = new Map();
    this.epoch = 0; this.nextReference = 0; this.frame = 0; this.paused = false; this.closed = false;
    this.sessionId = crypto.randomUUID();
    this.serial = Promise.resolve(); this.decoders = new Map(); this.diagnostics = [];
  }
  async open(assets, options) {
    this.options = options;
    const name = assets.environment === 'worker' ? 'PhpDbgWorker' : 'PhpDbgWeb';
    const Runtime = (await import(/* webpackIgnore: true */ new URL(`${name}.mjs`, assets.base).href))[name];
    const failed = deferred();
    const shared = {...(options.runtimeArgs?.shared || {}), __phpDebugger: {capture: value => {this.captured = {value};}}};
    const args = {
      ...(options.runtimeArgs || {}), version:options.version, persist:false, autoTransaction:false, shared,
      dbgYieldInterval:8, dbgManagedShutdown:true, dbgArgs:options.runtimeArgs?.dbgArgs ?? ['-q'],
      instantiateWasm(imports, ready) {
        WebAssembly.instantiate(assets.module, imports).then(instance => ready(instance, assets.module), failed.reject);
        return {};
      },
      getPreloadedPackage(name) {return assets.data[String(name).split('/').pop()];},
      sharedLibs:assets.sharedLibs,
      dynamicLibs:assets.dynamicLibs,
      files:assets.files,
      locateFile: name => assets.libraryUrls[name],
      onDbgOutput: event => this.output(event),
      onDbgEvent: event => {if(event.type === 'exception') {this.exception = event; this.diagnostics.push(event); this.emit({...event, type:'diagnostic'});}},
      onAbort: reason => failed.reject(new Error(String(reason))),
    };
    this.php = new Runtime(args);
    this.binary = await Promise.race([this.php.binary, failed.promise]);
    if(typeof this.binary._php_wasm_dbg_bridge_version !== 'function' || this.binary.ccall('php_wasm_dbg_bridge_version','number',[],[]) !== 1)
      throw new Error('This php-dbg-wasm build lacks debugger bridge v1. Rebuild its native worker/web artifacts.');
    // API 2 runtimes report PHP types, frame names and user globals themselves; older ones need the fallbacks below.
    this.dbgApi = typeof this.php.debuggerApiVersion === 'function' ? await this.php.debuggerApiVersion() : 1;
    this.binary.FS.mkdir('/.php-debugger');
    this.php.addEventListener('stdin-request', () => {
      // The native async call must unwind before reading its state.
      setTimeout(() => {this.sequence++; for(const waiter of this.waiters) waiter.resolve(); this.waiters.clear();}, 0);
    });
    const prompt = this.waitPrompt();
    this.process = this.php.run().catch(error => {
      if(typeof error?.status === 'number') return error.status;
      throw error;
    });
    this.process.catch(() => {});
    await Promise.race([prompt, this.process.then(() => {throw new Error('Debugger exited during startup');})]);
    await this.command('set pagination off');
    await this.command('set colors off');
    this.emit({type:'state', state:'ready'});
  }
  output({type, bytes, evaluating}) {
    const channel = type === 1 && !evaluating ? 'stdout' : type === 2 && !evaluating ? 'stderr' : 'debug';
    // Notices are phpdbg's own chatter; errors and evaluation output answer something the user did.
    const kind = channel !== 'debug' ? null : type === 3 ? 'error' : evaluating ? 'evaluation' : 'notice';
    const key = `${channel}:${type}:${evaluating}`;
    let stream = this.decoders.get(key);
    if(!stream) this.decoders.set(key, stream = {decoder:new TextDecoder(), event:kind ? {channel, kind} : {channel}});
    const text = stream.decoder.decode(bytes, {stream:true});
    if(type === 3 && text) {
      const diagnostic = {message:text, phase:evaluating ? 'evaluation' : 'execution'};
      this.commandErrors?.push(diagnostic);
      if(!evaluating) this.diagnostics.push(diagnostic);
      this.emit({type:'diagnostic', ...diagnostic});
    }
    if(text) this.emit({type:'output', ...stream.event, text});
  }
  writeFile(path, content) {
    const parts = path.split('/'); parts.pop(); let dir = '';
    for(const part of parts) {
      if(!part) continue;
      dir += '/' + part;
      if(!this.binary.FS.analyzePath(dir).exists) this.binary.FS.mkdir(dir);
    }
    this.binary.FS.writeFile(path, content);
  }
  waitPrompt() {const wait = deferred(); this.waiters.add(wait); return wait.promise;}
  async command(line) {
    if(this.closed) throw new Error('Debugger is closed');
    const prompt = this.waitPrompt();
    await this.php.provideInput(line);
    await Promise.race([prompt, this.process]);
    this.php.flush();
  }
  async execute(config) {
    this.config = config; this.diagnostics = []; this.exception = null;
    for(const [path, content] of Object.entries(config.files || {})) this.writeFile(normalizePath(path), content);
    this.writeFile(config.entrypoint, config.code);
    this.php.inputString(config.stdin || '');
    await this.command(`exec ${config.entrypoint}`);
    if(!this.binary.ccall('php_wasm_dbg_has_context','number',[],[])) return this.finish(255);
    await this.breakpoints(config.breakpoints);
    return this.resume('run');
  }
  async breakpoints(breakpoints) {
    this.installedBreakpoints = breakpoints;
    await this.command('clear');
    if(this.config?.mode !== 'test') for(const bp of breakpoints) {
      if(bp.enabled) await this.command(`break ${bp.file}:${bp.line}`);
    }
  }
  invalidate() {this.epoch++; this.references.clear();}
  async resume(command = 'continue') {
    if(command !== 'run' && !this.paused) throw new Error('The debugger is not paused');
    this.paused = false; this.frame = 0; this.invalidate(); this.exception = null;
    await this.php.switchFrame(0);
    this.emit({type:'state', state:'running'});
    await this.command(command);
    while(await this.php.isRunning()) {
      if(this.config.mode === 'test' && !this.pauseRequested) {await this.command('continue'); continue;}
      this.paused = true;
      const location = {file:await this.php.currentFile(), line:await this.php.currentLine(), frame:0, pauseId:this.epoch};
      const reason = this.pauseRequested ? 'pause' : this.exception ? 'exception' : command === 'continue' || command === 'run' ? 'breakpoint' : 'step';
      this.pauseRequested = false;
      this.emit({type:'paused', reason, location});
      return location;
    }
    return this.finish();
  }
  async finish(compilationExitCode) {
    if(this.closed) return;
    await this.php.provideInput('quit');
    const exitCode = await this.process;
    this.php.flush(); this.closed = true; this.paused = false; this.invalidate();
    for(const {decoder, event} of this.decoders.values()) {
      const text = decoder.decode(); if(text) this.emit({type:'output', ...event, text});
    }
    this.emit({type:'complete', exitCode:compilationExitCode ?? exitCode, diagnostics:this.diagnostics});
  }
  pause() {if(this.closed) throw new Error('Debugger is closed'); this.pauseRequested = true; this.binary.dbgPauseRequested = true;}
  async stop() {
    if(this.closed) return;
    if(!this.process) {this.closed = true; return;}
    if(this.paused || !await this.php.isRunning()) {await this.php.provideInput('quit'); await this.process;}
    else {this.binary.dbgStopRequested = true; await this.process;}
    this.closed = true; this.invalidate();
  }
  assertPaused() {if(!this.paused || this.closed) throw new Error('Inspection requires paused execution');}
  async selectFrame(frame) {
    this.assertPaused();
    if(!Number.isInteger(frame) || frame < 0 || await this.php.switchFrame(frame) < 0) throw new RangeError('Invalid frame');
    this.frame = frame;
    return {frame};
  }
  async frames() {
    if(this.dbgApi >= 2) return this.php.dumpBacktrace();
    // An older runtime lists frames starting at the selected one; list from the top so indexes match selectFrame().
    const selected = this.frame;
    if(selected) await this.php.switchFrame(0);
    try {return (await this.php.dumpBacktrace()).map(frame => ({...frame, selected:frame.frame === selected}));}
    finally {if(selected) await this.php.switchFrame(selected);}
  }
  type(value) {
    if(value === null) return 'null';
    if(typeof value !== 'object') return typeof value;
    const symbol = Object.getOwnPropertySymbols(value).find(s => s.description === 'origZval');
    if(symbol) {
      const type = this.binary.getValue(value[symbol] + 8, 'i32') & 255;
      if(type === 7) return 'array';
    }
    return Array.isArray(value) ? 'array' : 'object';
  }
  identity(value) {
    if(!value || typeof value !== 'object') return null;
    const symbol = Object.getOwnPropertySymbols(value).find(s => s.description === 'origZval');
    return symbol ? `${this.type(value)}:${this.binary.getValue(value[symbol], 'i32')}` : value;
  }
  display({type, className, count}, value) {
    if(type === 'array') return `array(${count})`;
    if(type === 'object') return className || 'object';
    if(type === 'string') return JSON.stringify(value);
    // PHP prints 3.0 as 3; keep the float visible.
    if(type === 'float' && Number.isInteger(value)) return value.toFixed(1);
    return type === 'null' ? 'null' : String(value);
  }
  symbolExpression(scope, name) {
    return scope === 'constants' ? null : scope === 'globals' ? `$GLOBALS[${phpString(name)}]` : '${' + phpString(name) + '}';
  }
  /** info is the runtime's own description of the value, when it can give one. */
  describe(name, value, expression, writable = true, frame = this.frame, ancestors = [], info = null) {
    // Without info, undefined is how the runtime hands back a variable the frame declares but has not assigned yet.
    const unset = info ? info.type === 'undefined' : value === undefined && !ancestors.length;
    const type = unset ? 'unset' : info?.type || this.type(value);
    const identity = this.identity(value), circular = identity !== null && ancestors.includes(identity);
    const expandable = value !== null && typeof value === 'object' && !circular;
    const reference = `${this.sessionId}:${this.epoch}:${++this.nextReference}`;
    this.references.set(reference, {name, value, expression, writable, frame, ancestors:[...ancestors,identity], type});
    return {name, type, reference, expandable, circular, writable:!!expression && writable && typeof value !== 'function',
      ...(info && {className:info.className, count:info.count}),
      value:expandable || circular || typeof value === 'function' ? undefined : value,
      displayValue:unset ? 'unset' : circular ? '[Circular]' : info ? this.display(info, value) : expandable ? (type === 'array' ? 'Array' : 'Object') : typeof value === 'string' ? JSON.stringify(value) : String(value)};
  }
  async inspect(scope = 'variables', options = {}) {
    this.assertPaused();
    if(options.frame !== undefined) await this.selectFrame(options.frame);
    const methods = {variables:'dumpVars', globals:'dumpGlobals', constants:'dumpConstants', functions:'dumpFunctions', classes:'dumpClasses', files:'dumpFiles', frames:'dumpBacktrace'};
    if(!methods[scope]) throw new TypeError(`Unknown inspection scope: ${scope}`);
    if(this.dbgApi >= 2 && ['variables','globals','constants'].includes(scope)) {
      const symbols = await (scope === 'variables' ? this.php.describeVars() : scope === 'globals' ? this.php.describeGlobals({user:true}) : this.php.describeConstants());
      return symbols.map(symbol => this.describe(symbol.name, symbol.value, this.symbolExpression(scope, symbol.name), scope !== 'constants', this.frame, [], symbol));
    }
    let values = scope === 'frames' ? await this.frames() : await this.php[methods[scope]]() || {};
    if(scope === 'globals') {
      // The low-level dump arms superglobals but filters out user-defined globals.
      const globals = await this.evaluate('$GLOBALS');
      values = this.references.get(globals.reference).value;
    }
    if(scope === 'files') return [...new Set([this.config.entrypoint, ...values])];
    if(['functions','classes','frames'].includes(scope)) return values;
    return Object.entries(values).map(([name,value]) => this.describe(name, value, this.symbolExpression(scope, name), scope !== 'constants'));
  }
  async children(reference, {offset = 0, limit = 100} = {}) {
    this.assertPaused();
    const parent = this.references.get(reference);
    if(!parent) throw new Error('Stale variable reference');
    if(!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid inspection page');
    const type = parent.type;
    const names = Object.keys(parent.value);
    const values = [];
    for(const name of names.slice(offset, offset + limit)) {
      const expression = !parent.expression ? null : type === 'array' ? `${parent.expression}[${phpString(name)}]` : `${parent.expression}->{${phpString(name.split('\0').pop())}}`;
      try {
        // Asking by key keeps the child's own PHP type; a float of 3.0 is just the number 3 once converted.
        const info = this.dbgApi >= 2 ? await this.php.describeChild(parent.value, name) : null;
        values.push(this.describe(name, info ? info.value : parent.value[name], expression, parent.writable, parent.frame, parent.ancestors, info));
      } catch(error) {values.push({name,type:'unavailable',displayValue:error.message,writable:false,expandable:false});}
    }
    return {values, total:names.length, offset};
  }
  async evaluate(expression, {frame = this.frame} = {}) {
    this.assertPaused();
    if(typeof expression !== 'string' || !expression.trim()) throw new TypeError('Enter a PHP expression');
    const previous = this.frame;
    await this.selectFrame(frame);
    this.captured = null; this.commandErrors = [];
    try {
      // A file avoids phpdbg's line-length limit and preserves multiline expressions.
      this.writeFile('/.php-debugger/eval.php', `return (${expression});`);
      // Handed over directly, a float of 3.0 arrives as the number 3 and its PHP type is gone. Inside an array it
      // stays a PHP value, and the runtime can describe that element as it describes any other child.
      const boxed = this.dbgApi >= 2;
      await this.command(`ev vrzno_shared('__phpDebugger')->capture(${boxed ? '[' : ''}eval(file_get_contents('/.php-debugger/eval.php'))${boxed ? ']' : ''})`);
      if(!this.captured) throw new Error(this.commandErrors.map(d => d.message).join('\n') || 'PHP expression evaluation failed');
      const info = boxed ? await this.php.describeChild(this.captured.value, '0') : null;
      return this.describe(expression, info ? info.value : this.captured.value, expression, true, this.frame, [], info);
    } finally {this.commandErrors = null; await this.selectFrame(previous);}
  }
  async setVariable(reference, expression) {
    this.assertPaused();
    const variable = this.references.get(reference);
    if(!variable) throw new Error('Stale variable reference');
    if(!variable.expression || !variable.writable) throw new Error('This value is read-only');
    const evaluated = await this.evaluate(`${variable.expression} = (${expression})`, {frame:variable.frame});
    const value = this.describe(variable.name, this.references.get(evaluated.reference).value, variable.expression, variable.writable, variable.frame, variable.ancestors.slice(0,-1),
      this.dbgApi >= 2 ? {type:evaluated.type, className:evaluated.className, count:evaluated.count} : null);
    this.references.delete(evaluated.reference);
    this.emit({type:'variablechange', reference, value});
    return value;
  }
  invoke(method, args = []) {
    const allowed = ['execute','breakpoints','resume','pause','stop','inspect','children','selectFrame','evaluate','setVariable'];
    if(!allowed.includes(method)) return Promise.reject(new Error('Unknown debugger operation'));
    // Pause/stop must be able to arrive while an execution command is waiting.
    if(method === 'pause' || method === 'stop') return Promise.resolve(this[method](...args));
    const task = this.serial.then(() => this[method](...args));
    this.serial = task.catch(() => {}); return task;
  }
}
