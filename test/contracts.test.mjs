import {test} from 'node:test';
import assert from 'node:assert/strict';

test(
	'asset requests coalesce, failed requests retry, consumers cannot detach shared bytes'
	, async () => {
		const {AssetRegistry} = await import('../src/assets.mjs');
		let requests = 0;

		const registry = new AssetRegistry({
			fetch: async () => {
				requests++;

				if(requests === 1)
				{
					throw Error('offline');
				}

				await new Promise(resolve => setTimeout(resolve, 5));

				return new Response(new Uint8Array([1, 2, 3]));
			}
		});

		await assert.rejects(registry.bytes('https://example.test/a.wasm'), /offline/);

		const [a, b] = await Promise.all(
			[registry.bytes('https://example.test/a.wasm')
				, registry.bytes('https://example.test/a.wasm')
			]
		);

		assert.equal(requests, 2);
		structuredClone(a, {transfer: [a]});
		assert.equal(b.byteLength, 3);
		assert.equal((await registry.bytes('https://example.test/a.wasm')).byteLength, 3);
	}
);

test(
	'test expectations preserve whitespace, handle regex state, and never pass an aborted run'
	, async () => {
		const {checkExpectations} = await import('../src/expectations.mjs');
		const result = {
			status: 'completed'
			, stdout: 'ok\n'
			, stderr: ''
			, exitCode: 0
			, diagnostics: []
		};

		assert.equal((await checkExpectations(result, {stdout: 'ok\n'})).status, 'passed');
		assert.equal((await checkExpectations(result, {stdout: 'ok'})).status, 'failed');
		const expected = {stdout: /ok/g};
		assert.equal((await checkExpectations(result, expected)).status, 'passed');
		assert.equal((await checkExpectations(result, expected)).status, 'passed');

		assert.equal(
			(await checkExpectations({...result, status: 'cancelled'}, expected)).status
			, 'failed'
		);

		assert.equal(
			(await checkExpectations({...result, exitCode: 7}, {exitCode: 7})).status
			, 'passed'
		);

		assert.equal((await checkExpectations(result)).status, 'unchecked');
	}
);

test('source paths and breakpoints have unambiguous command boundaries', async () => {
	const {normalizeBreakpoints, normalizePath} = await import('../src/model.mjs');

	assert.deepEqual(
		normalizeBreakpoints(
			[3, 3, {file: '/other.php', line: 4, enabled: false}]
			, '/main.php'
		).map(b => [b.file, b.line, b.enabled])
		, [['/main.php', 3, true], ['/other.php', 4, false]]
	);

	assert.throws(() => normalizeBreakpoints([0], '/main.php'));
	assert.throws(() => normalizePath('/foo\nrun'));
	assert.throws(() => normalizePath('/../php.ini'));
});

test('a breakpoint keeps a condition and a log as PHP strings, and drops blank ones', async () => {
	const {normalizeBreakpoints} = await import('../src/model.mjs');

	const [conditional, logpoint, plain] = normalizeBreakpoints(
		[
			{line: 2, condition: ' $i > 2 '}
			, {line: 3, log: '$sum', condition: ''}
			, {line: 4, log: ' '}
		]
		, '/main.php'
	);

	assert.deepEqual(
		[conditional, logpoint, plain]
		, [
			{id: '/main.php:2', file: '/main.php', line: 2, enabled: true, condition: '$i > 2'}
			, {id: '/main.php:3', file: '/main.php', line: 3, enabled: true, log: '$sum'}
			, {id: '/main.php:4', file: '/main.php', line: 4, enabled: true}
		]
	);

	assert.throws(() => normalizeBreakpoints([{line: 2, condition: true}]), TypeError);
	assert.throws(() => normalizeBreakpoints([{line: 2, log: 3}]), TypeError);
});

test('expected logs match the messages one for one, in order', async () => {
	const {checkExpectations} = await import('../src/expectations.mjs');

	const result = {
		status: 'completed'
		, stdout: ''
		, stderr: ''
		, exitCode: 0
		, diagnostics: []

		, logs: [
			{file: '/main.php', line: 4, message: '0'}
			, {file: '/main.php', line: 4, message: '1'}
		]
	};

	assert.equal((await checkExpectations(result, {logs: ['0', /^1$/]})).status, 'passed');

	const missing = await checkExpectations(result, {logs: ['0']});

	assert.equal(missing.status, 'failed');
	assert.deepEqual(missing.failures, [{field: 'logs', expected: '0', actual: '0\n1'}]);
	assert.equal((await checkExpectations(result, {logs: ['1', '0']})).status, 'failed');
});

test('expectations of the wrong shape fail the test and are not thrown', async () => {
	const {checkExpectations} = await import('../src/expectations.mjs');

	const result = {
		status: 'completed'
		, stdout: ''
		, stderr: ''
		, exitCode: 0
		, diagnostics: []
		, logs: [{file: '/main.php', line: 4, message: 'total: 40'}]
	};

	for(const logs of ['total: 40', null, 5, {0: 'total: 40'}])
	{
		const {status, failures} = await checkExpectations(result, {logs});

		assert.equal(status, 'failed');

		assert.deepEqual(
			failures
			, [{field: 'logs', message: 'expect.logs must be an array of strings or patterns'}]
		);
	}

	const text = await checkExpectations(result, 'total: 40');

	assert.equal(text.status, 'failed');
	assert.deepEqual(text.failures, [{field: 'expect', message: 'Expectations must be an object'}]);

	// An assertion fails the test by whatever it throws, nothing at all included.
	const thrown = [
		[() => Promise.reject(), 'Assertion rejected without a reason']
		, [() => {throw null;}, 'Assertion rejected without a reason']
		, [() => {throw 'a string';}, 'a string']
		, [() => {throw new Error('an error');}, 'an error']
		, [() => false, 'Assertion returned false']
	];

	for(const [assertion, message] of thrown)
	{
		assert.deepEqual(
			(await checkExpectations(result, undefined, assertion)).failures
			, [{field: 'assertion', message}]
		);
	}

	// With null there is nothing to compare, and the run must still have ended well.
	assert.equal((await checkExpectations(result, null)).status, 'passed');
	assert.equal((await checkExpectations({...result, exitCode: 2}, null)).status, 'failed');
});

test('the custom element forwards every event and method the controller declares', async () => {
	const {debuggerEvents} = await import('../src/model.mjs');
	const {readFileSync} = await import('node:fs');

	/** A source file's text. */
	const read = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

	const types = read('index.d.ts');
	const controller = read('index.mjs');
	const element = read('element.mjs');
	const elementTypes = read('element.d.ts');

	/** The names a block of a declaration file begins its lines with, one tab in. */
	const members = (source, opening) => {
		const block = source.slice(source.indexOf(opening)).split(/^}/m)[0];

		return [...new Set([...block.matchAll(/^\t(\w+)[(:?]/gm)].map(match => match[1]))];
	};

	// The events: the list the element forwards is the declared one, and nothing is emitted
	// under a name that is not on it.
	assert.deepEqual(
		[...debuggerEvents].sort()
		, members(types, 'export interface DebuggerEvents').sort()
	);

	const emitted = [...controller.matchAll(/this\.emit\(\s*'(\w+)'/g)].map(match => match[1]);

	assert.equal(emitted.length > 10, true);
	assert.deepEqual(emitted.filter(name => !debuggerEvents.includes(name)), []);
	assert.match(element, /for\(const name of debuggerEvents\)/);

	// The methods: all but those that make no sense on an element, one under another name.
	const kept = ['constructor', 'readCode', 'setCode', 'destroy', 'mount'];
	const renamed = {children: 'inspectChildren'};

	const expected = members(types, 'export class PhpDebugger').filter(
		name => !kept.includes(name) && !name.endsWith('EventListener')
	).map(name => renamed[name] ?? name);

	const declared = members(elementTypes, 'export interface PhpDebuggerElement');

	assert.equal(expected.includes('opcodes') && expected.includes('run'), true);
	assert.deepEqual(expected.filter(name => !declared.includes(name)), []);

	for(const name of expected)
	{
		assert.match(element, new RegExp(`^\\t\\t${name}\\(`, 'm'), name);
	}
});

test('a string is written as a PHP literal on one line', async () => {
	const {phpLiteral} = await import('../src/model.mjs');

	// As it reads, in single quotes, when nothing in it needs an escape.
	assert.equal(phpLiteral('plain $text "quoted"'), '\'plain $text "quoted"\'');
	assert.equal(phpLiteral('it\'s a \\ path'), '\'it\\\'s a \\\\ path\'');

	// In double quotes, with PHP's escapes, when it holds a line break or another control
	// character; there a dollar sign and a double quote are escaped as well.
	assert.equal(phpLiteral('line one\nline two'), '"line one\\nline two"');
	assert.equal(phpLiteral('a\r\nb\t$c "d" \\ e'), '"a\\r\\nb\\t\\$c \\"d\\" \\\\ e"');
	assert.equal(phpLiteral('nul\0 esc\x1b bell\x07'), '"nul\\x00 esc\\e bell\\x07"');
});

test('controller import and construction are DOM-free and do not load a runtime', async () => {
	const {PhpDebugger} = await import('../src/index.mjs');
	const dbg = new PhpDebugger({code: '<?php echo 1;'});
	assert.equal(dbg.state, 'idle');
	await dbg.destroy();
	assert.equal(dbg.state, 'destroyed');
});

test('verified identical binaries share compilation and downloads across loader URLs', async() => {
	const {AssetRegistry} = await import('../src/assets.mjs');
	const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

	const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(
		b => b.toString(16).padStart(2, '0')
	).join('');

	let fetched = 0;

	const registry = new AssetRegistry(
		{fetch: async() => {fetched++; return new Response(bytes);}}
	);

	const [worker, main] = await Promise.all(
		[registry.module('https://example.test/worker.wasm', hash)
			, registry.module('https://example.test/web.wasm', hash)
		]
	);

	assert.equal(worker, main);
	assert.equal(fetched, 1);
});

test(
	'engine lists frames from the top, labels unset variables and classifies debugger output'
	, async () => {
		const {DebugEngine} = await import('../src/engine.mjs');
		const events = [];
		const engine = new DebugEngine(event => events.push(event));
		// A runtime whose backtrace starts at the selected frame, as vrzno_dbg_dump_backtrace does.
		const stack = [10, 4, 13];
		let selected = 0;
		engine.php = {

			async switchFrame(frame) {
				if(frame >= stack.length)
				{
					return -1;
				}

				const previous = selected;
				selected = frame;

				return previous;
			}

			, async dumpBacktrace() {
				return stack.slice(selected).map((lineNo, frame) => ({
					filename: '/main.php'
					, lineNo
					, frame
				}));
			}
		};

		engine.paused = true;
		await engine.selectFrame(1);
		const frames = await engine.inspect('frames');

		assert.deepEqual(
			frames.map(frame => [frame.frame, frame.lineNo, frame.selected])
			, [[0, 10, false], [1, 4, true], [2, 13, false]]
		);

		assert.equal(selected, 1, 'listing restores the selected frame');

		const unset = engine.describe('later', undefined, "${'later'}");

		assert.deepEqual(
			[unset.type, unset.displayValue, unset.writable, unset.expandable]
			, ['unset', 'unset', true, false]
		);

		const bytes = text => new TextEncoder().encode(text);
		events.length = 0;
		engine.output({type: 0, bytes: bytes('Breakpoint #0 added'), evaluating: false});
		engine.output({type: 3, bytes: bytes('Uncaught Exception'), evaluating: false});
		engine.output({type: 1, bytes: bytes('42'), evaluating: true});
		engine.output({type: 1, bytes: bytes('hello'), evaluating: false});

		assert.deepEqual(events.filter(event => event.type === 'output'), [
			{type: 'output', channel: 'debug', kind: 'notice', text: 'Breakpoint #0 added'}
			, {type: 'output', channel: 'debug', kind: 'error', text: 'Uncaught Exception'}
			, {type: 'output', channel: 'debug', kind: 'evaluation', text: '42'}
			, {type: 'output', channel: 'stdout', text: 'hello'}
		]);
	}
);

test('downloads report progress and still deliver every byte', async () => {
	const {AssetRegistry} = await import('../src/assets.mjs');
	const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];

	const body = () => new ReadableStream(
		{

			start(controller) {
				for(const part of parts)
				{
					controller.enqueue(part);
				}

				controller.close();
			}
		}
	);

	const sized = new AssetRegistry(
		{fetch: async () => new Response(body(), {headers: {'content-length': '6'}})}
	);

	const seen = [];
	const stop = sized.onProgress(progress => seen.push(progress));

	assert.deepEqual(
		[...new Uint8Array(await sized.bytes('https://example.test/php.wasm'))]
		, [1, 2, 3, 4, 5, 6]
	);

	assert.deepEqual(seen.at(-1), {url: 'https://example.test/php.wasm', loaded: 6, total: 6});
	assert.ok(seen.every((progress, index) => !index || progress.loaded > seen[index - 1].loaded));
	stop();
	await sized.bytes('https://example.test/other.wasm');

	assert.equal(
		seen.at(-1).url
		, 'https://example.test/php.wasm'
		, 'a stopped listener hears nothing more'
	);

	// A compressed transfer declares the compressed size, which is not the size of these bytes.
	const compressed = new AssetRegistry(
		{
			fetch: async () => new Response(
				body()
				, {headers: {'content-length': '4', 'content-encoding': 'gzip'}}
			)
		}
	);

	const totals = [];
	compressed.onProgress(progress => totals.push(progress.total));
	await compressed.bytes('https://example.test/php.wasm');
	assert.deepEqual([...new Set(totals)], [null]);

	// Across origins the browser can hide the encoding and still show the compressed length.
	const hidden = new AssetRegistry(
		{fetch: async () => new Response(body(), {headers: {'content-length': '4'}})}
	);

	const steps = [];
	hidden.onProgress(progress => steps.push([progress.loaded, progress.total]));
	await hidden.bytes('https://example.test/php.wasm');
	assert.deepEqual(steps, [[3, 4], [5, null], [6, null]]);
});

test(
	'engine uses the runtime\'s own types, frame names and globals when it provides debugger API 2'
	, async () => {
		const {DebugEngine} = await import('../src/engine.mjs');
		const engine = new DebugEngine(() => {});

		engine.paused = true;
		engine.dbgApi = 2;
		const list = {0: 'a', 1: 'b'};
		const item = {label: 'x', ratio: 2};

		const scalar = value => ({
			type: typeof value === 'string' ? 'string' : Number.isInteger(value) ? 'int' : 'float'
			, className: null
			, count: null
			, reference: false
			, value
		});

		/** A variable as describeVars() reports it. */
		const symbol = (name, type, value, more = {}) => ({
			name
			, type
			, className: null
			, count: null
			, reference: false
			, value
			, ...more
		});

		const calls = [];
		engine.php = {

			async describeVars() {
				calls.push('vars');

				return [
					symbol('count', 'int', 3)
					, symbol('ratio', 'float', 3)
					, symbol('later', 'undefined', undefined)
					, symbol('list', 'array', list, {count: 2})
					, symbol('item', 'object', item, {className: 'App\\Item'})
				];
			}

			, async describeGlobals(options) {
				calls.push(['globals', options]);

				return [{
					name: 'config'
					, type: 'string'
					, className: null
					, count: 2
					, reference: false
					, value: 'on'
				}];
			}

			, async describeConstants() {
				return [{
					name: 'LIMIT'
					, type: 'int'
					, className: null
					, count: null
					, reference: false
					, value: 9
				}];
			}

			, async describeChild(parent, key) {
				return key === 'ratio'
					? {...scalar(parent[key]), type: 'float'}
					: scalar(parent[key]);
			}

			, async dumpBacktrace() {
				calls.push('frames');

				return [{
					filename: '/main.php'
					, lineNo: 7
					, frame: 0
					, selected: true
					, functionName: 'inner'
					, className: ''
				}];
			}

			, async switchFrame() {
				throw new Error('an API 2 runtime lists frames without switching');
			}
		};

		const locals = await engine.inspect('variables');

		assert.deepEqual(locals.map(v => [v.name, v.type, v.displayValue, v.expandable]), [
			['count', 'int', '3', false]
			, ['ratio', 'float', '3.0', false]
			, ['later', 'unset', 'unset'
				, false
			]
			, ['list', 'array', 'array(2)', true], ['item', 'object', 'App\\Item', true]
		]);

		assert.deepEqual([locals[4].className, locals[3].count], ['App\\Item', 2]);
		const globals = await engine.inspect('globals');

		assert.deepEqual(
			[globals[0].name, globals[0].displayValue, globals[0].writable]
			, ['config', '"on"', true]
		);

		assert.deepEqual(calls.find(call => call[0] === 'globals')[1], {user: true});
		assert.equal((await engine.inspect('constants'))[0].writable, false);
		const properties = await engine.children(locals[4].reference);

		assert.deepEqual(
			properties.values.map(v => [v.name, v.type, v.displayValue])
			, [['label', 'string', '"x"'], ['ratio', 'float', '2.0']]
		);

		assert.deepEqual((await engine.inspect('frames'))[0].functionName, 'inner');
	}
);

test(
	'two debuggers that load the identical binary from different URLs both see its progress'
	, async () => {
		const {AssetRegistry, prepareAssets} = await import('../src/assets.mjs');
		const fs = await import('node:fs');
		const os = await import('node:os');
		const path = await import('node:path');
		const {pathToFileURL} = await import('node:url');
		const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

		const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(
			b => b.toString(16).padStart(2, '0')
		).join('');

		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'php-debugger-assets-'));

		try
		{
			// prepareAssets imports the runtime's dependency resolver from the runtime directory.
			const bases = ['worker-host', 'page-host'].map(name => {
				fs.mkdirSync(path.join(root, name));

				const resolver
					= 'export const resolveDependencies = () => ({files:[], libs:[], urlLibs:{}});';

				fs.writeFileSync(path.join(root, name, 'resolveDependencies.mjs'), resolver + '\n');

				return pathToFileURL(path.join(root, name) + path.sep).href;
			});

			const fetched = [];

			const registry = new AssetRegistry({
				fetch: async url => {
					if(url.endsWith('.assets.json'))
					{
						const environment = url.includes('-dbg-worker.') ? 'worker' : 'web';

						const manifest = {
							schemaVersion: 1
							, bridgeVersion: 1
							, version: '8.4'
							, environment
							, wasm: 'php.wasm'
							, sha256
						};

						return new Response(JSON.stringify(manifest));
					}

					fetched.push(url);

					const body = new ReadableStream({

						async start(controller) {
							for(const part of [bytes.slice(0, 3)
								, bytes.slice(3)
							]){
								await new Promise(resolve => setTimeout(resolve, 5));
								controller.enqueue(part);
							}

							controller.close();
						}
					});

					return new Response(body, {headers: {'content-length': String(bytes.length)}});
				}
			});

			const seen = [[], []];

			const [worker, page] = await Promise.all(
				bases.map((runtimeBaseUrl, index) => prepareAssets({
					version: '8.4'
					, execution: index ? 'main' : 'worker'
					, runtimeBaseUrl
					, assetRegistry: registry
					, onProgress: progress => seen[index].push(progress)
				}))
			);

			assert.equal(worker.module, page.module);
			assert.equal(fetched.length, 1, 'the binary is downloaded once');

			for(const progress of seen)
			{
				assert.deepEqual(progress.at(-1), {loaded: bytes.length, total: bytes.length});
			}

			assert.equal(registry.moduleSource(new URL('php.wasm', bases[1]), sha256), fetched[0]);
		}
		finally
		{
			fs.rmSync(root, {recursive: true, force: true});
		}
	}
);

/**
 * An engine stopped on line 2 of a script, where a logpoint is, with a stand-in for PHP that stops
 * there once more after Continue and then ends. `during` runs while the log is evaluated.
 */
const stoppedEngine = async (binary, during = () => {}) => {
	const {DebugEngine} = await import('../src/engine.mjs');
	const events = [];
	const commands = [];
	const engine = new DebugEngine(event => events.push(event));
	let stops = 2;

	engine.paused = true;
	engine.binary = binary;
	engine.config = {mode: 'debug', entrypoint: '/main.php', code: '<?php\n$n = 1;\n'};
	engine.sources = new Map([['/main.php', engine.config.code]]);
	engine.installedBreakpoints = [{file: '/main.php', line: 2, enabled: true, log: '$n'}];

	engine.writeFile = () => {};

	engine.finish = async () => 'finished';

	engine.php = {

		async switchFrame() {return 0;}

		, async isRunning() {return stops-- > 0;}

		, async currentFile() {return '/main.php';}

		, async currentLine() {return 2;}
	};

	engine.command = async line => {
		commands.push(line.split('(')[0]);

		if(line.startsWith('ev '))
		{
			during(engine);
			engine.captured = {value: {0: true, 1: '1'}};
		}
	};

	return {engine, events, commands};
};

test(
	'breakpoints are off while PHP is stopped, by the runtime\'s switches or by command'
	, async () => {
		const switched = [];

		const binary = {
			_phpdbg_enable_breakpoints: () => switched.push('on')
			, _phpdbg_disable_breakpoints: () => switched.push('off')
		};

		const direct = await stoppedEngine(binary);

		// Two stops on the logpoint, each logged and continued from, then the end of the run.
		assert.equal(await direct.engine.resume('continue'), 'finished');
		assert.deepEqual(switched, ['on', 'off', 'on', 'off', 'on']);

		assert.deepEqual(
			direct.commands
			, ['continue', 'ev vrzno_shared', 'continue', 'ev vrzno_shared', 'continue']
		);

		assert.deepEqual(direct.events.filter(event => event.type === 'log').length, 2);

		// A runtime without the switches is told by command, around each time PHP runs.
		const told = await stoppedEngine({});

		await told.engine.resume('continue');

		assert.deepEqual(told.commands.slice(0, 5), [
			'set breaks on'
			, 'continue'
			, 'set breaks off'
			, 'ev vrzno_shared'
			, 'set breaks on'
		]);
	}
);

test('a pause asked for while a breakpoint decides waits for it, then pauses there', async () => {
	const binary = {dbgPauseRequested: false};
	let asked = null;

	const {engine, events, commands} = await stoppedEngine(binary, engine => {
		engine.pause();
		asked = binary.dbgPauseRequested;
	});

	const location = await engine.resume('continue');

	// PHP was not asked to pause inside the log; the log was printed, and the pause is here.
	assert.equal(asked, false);
	assert.deepEqual({file: location.file, line: location.line}, {file: '/main.php', line: 2});
	assert.deepEqual(events.map(event => event.type), ['state', 'log', 'paused']);
	assert.equal(events.at(-1).reason, 'pause');
	assert.equal(commands.includes('continue'), true);
	assert.equal(commands.at(-1), 'ev vrzno_shared');
	assert.equal(binary.dbgPauseRequested, false);

	// Asked while PHP runs, it is PHP that is told.
	engine.pause();
	assert.equal(binary.dbgPauseRequested, true);
});

test('a command line with other than ASCII in it is given room for its bytes', async () => {
	const {DebugEngine} = await import('../src/engine.mjs');
	const {isPhpName} = await import('../src/model.mjs');
	const engine = new DebugEngine(() => {});

	const lines = [];

	engine.process = new Promise(() => {});

	// Stands in for the runtime: the prompt comes back as soon as a line is given.
	engine.php = {

		async provideInput(line) {
			lines.push(line);

			for(const waiter of engine.waiters)
			{
				waiter.resolve();
			}
		}

		, flush() {}
	};

	await engine.command('print func caféé');
	await engine.command('print func 😀');
	await engine.command('continue');

	// Two bytes more than characters in each name, and as many spaces after it.
	assert.deepEqual(lines, ['print func caféé  ', 'print func 😀  ', 'continue']);

	// What may be put on that line as a name, and what may not.
	for(const name of ['total', 'App\\total', '\\App\\Bag', 'café', 'App\\😀', '_x9'])
	{
		assert.equal(isPhpName(name), true, name);
	}

	const refused = [
		'9x', '', 'twice; continue', 'a b', 'App\\', 'App\\\\total', 'App\\{closure}'
		, 'class@anonymous\0/main.php:3$0', null
	];

	for(const name of refused)
	{
		assert.equal(isPhpName(name), false, String(name));
	}
});

test('an evaluated value keeps its PHP type when the runtime provides debugger API 2', async () => {
	const {DebugEngine} = await import('../src/engine.mjs');

	const evaluate = async (api, expression, outcome = {0: true, 1: 3}) => {
		const engine = new DebugEngine(() => {});

		engine.paused = true;
		engine.dbgApi = api;
		const commands = [];
		const files = {};
		// Stands in for PHP: the runner answers [true, value], and a float of 3.0 in it reaches
		// JavaScript as the number 3.

		engine.writeFile = (path, content) => {files[path] = content;};

		engine.command = async line => {
			commands.push(line);
			engine.captured = {value: outcome};
		};

		engine.php = {

			async switchFrame() {return 0;}

			, async describeValue(value) {
				return {
					type: Number.isInteger(value) ? 'int' : 'float'
					, className: null
					, count: null
					, reference: false
					, value
				};
			}

			, async describeChild(parent, key) {
				return {
					type: 'float'
					, className: null
					, count: null
					, reference: false
					, value: parent[key]
				};
			}
		};

		const value = await engine.evaluate(expression);

		return {
			value
			, command: commands[0]
			, code: files['/.php-debugger/eval.php']
			, stored: engine.references.get(value.reference).value
		};
	};

	const typed = await evaluate(2, '3.0');

	assert.deepEqual(
		[typed.value.type, typed.value.displayValue, typed.value.value, typed.stored]
		, ['float', '3.0', 3, 3]
	);

	// The command is the same whatever was typed: the expression travels in a file, on lines of
	// its own, and the runner evaluates it inside a try block.
	assert.match(
		typed.command
		, /capture\(eval\(file_get_contents\('\/\.php-debugger\/run\.php'\)\)\)$/
	);

	assert.equal(typed.code, 'return (\n3.0\n);');
	// An older runtime cannot describe values, so the type is JavaScript's.
	const plain = await evaluate(1, '3.0;  ');

	assert.deepEqual([plain.value.type, plain.value.displayValue], ['number', '3']);
	assert.equal(plain.code, 'return (\n3.0\n);');

	// A failure is the runner's [false, class, message, line], reported in the user's terms.
	await assert.rejects(
		evaluate(2, 'nope()', {0: false, 1: 'Error', 2: 'Call to undefined function nope()', 3: 0})
		, {message: 'Error: Call to undefined function nope()'}
	);
});

test('a failed evaluation is worded for the expression that was typed', async () => {
	const {evaluationError} = await import('../src/model.mjs');

	const unexpected = token => `syntax error, unexpected token "${token}"`;

	// Line 1 is the wrapper's opening, the expression starts on line 2, and the wrapper closes on
	// the line after the expression's last.
	assert.equal(
		evaluationError('1 +', 'ParseError', unexpected(')'), 3)
		, 'syntax error, unexpected end of expression'
	);

	assert.equal(evaluationError('$n +* 2', 'ParseError', unexpected('*'), 2), unexpected('*'));

	// The user's own stray parenthesis closes the wrapper early; PHP's message is already right.
	assert.equal(evaluationError('1)', 'ParseError', "Unmatched ')'", 3), "Unmatched ')'");

	assert.equal(
		evaluationError('[\n1,\n2 3\n]', 'ParseError', 'syntax error, unexpected integer "3"', 4)
		, 'syntax error, unexpected integer "3" on line 3'
	);

	assert.equal(
		evaluationError('intdiv(1, 0)', 'DivisionByZeroError', 'Division by zero', 0)
		, 'DivisionByZeroError: Division by zero'
	);
});

test('only a property key that starts with a NUL byte is read as a mangled name', async () => {
	const {phpPropertyName} = await import('../src/model.mjs');

	assert.deepEqual(phpPropertyName('open'), {name: 'open', visibility: 'public'});

	assert.deepEqual(
		phpPropertyName('\0App\\Job\0secret')
		, {name: 'secret', visibility: 'private'}
	);

	assert.deepEqual(phpPropertyName('\0*\0guarded'), {name: 'guarded', visibility: 'protected'});

	// A public name with NUL bytes in it is one name, however many it has.
	assert.deepEqual(phpPropertyName('odd\0name'), {name: 'odd\0name', visibility: 'public'});

	assert.deepEqual(
		phpPropertyName('odd\0named\0key')
		, {name: 'odd\0named\0key', visibility: 'public'}
	);

	// An anonymous class's name has a NUL byte of its own, before the file that declares it.
	assert.deepEqual(
		phpPropertyName('\0class@anonymous\0/main.php:3$0\0secret')
		, {name: 'secret', visibility: 'private'}
	);

	// A key that starts with a NUL byte and has no other is not a mangled name.
	assert.deepEqual(phpPropertyName('\0'), {name: '\0', visibility: 'public'});
});

test('an anonymous class is labelled with the file and line that declare it', async () => {
	const {phpClassLabel} = await import('../src/model.mjs');
	const {DebugEngine} = await import('../src/engine.mjs');

	assert.equal(phpClassLabel('App\\Item'), 'App\\Item');
	assert.equal(phpClassLabel('class@anonymous'), 'class@anonymous');

	assert.equal(
		phpClassLabel('class@anonymous\0/srv/app/jobs.php:12$0')
		, 'class@anonymous (jobs.php:12)'
	);

	assert.equal(phpClassLabel('Job@anonymous\0/main.php:3$1f'), 'Job@anonymous (main.php:3)');

	// The value keeps PHP's own name; only what is shown is shortened.
	const engine = new DebugEngine(() => {});

	const name = 'class@anonymous\0/main.php:3$0';

	const value = engine.describe(
		'job'
		, {}
		, "${'job'}"
		, true
		, 0
		, []
		, {type: 'object', className: name, count: null}
	);

	assert.deepEqual([value.className, value.displayValue], [name, 'class@anonymous (main.php:3)']);
});

test(
	'private and protected properties are listed, read-only, when the runtime provides debugger API 2'
	, async () => {
		const {DebugEngine} = await import('../src/engine.mjs');
		// The last is a public property: PHP allows NUL bytes in a name after its first character.
		// The last is private to an anonymous class, whose name holds a NUL byte itself.
		const keys = [
			'\0App\\Job\0secret'
			, '\0*\0guarded'
			, 'open'
			, 'odd\0named\0key'
			, '\0class@anonymous\0/main.php:3$0\0hidden'
		];

		const stored = {[keys[0]]: 4, [keys[1]]: 'kept', open: 7, [keys[3]]: 9, [keys[4]]: 2};

		// Stands in for the runtime's object: every property is an own key, and only public ones
		// are enumerable.
		const job = new Proxy({}, {
			ownKeys: () => keys
			, getOwnPropertyDescriptor: (target, key) => key === 'open' || key === keys[3]
				? {value: stored[key], enumerable: true, configurable: true}
				: undefined
			, get: (target, key) => key === 'open' || key === keys[3] ? stored[key] : undefined
		});

		const evaluations = [];
		let answered = null;

		const list = async api => {
			const engine = new DebugEngine(() => {});

			engine.paused = true;
			engine.dbgApi = api;

			/** The value under the first key is a float; the others are strings or ints. */
			const type = key => typeof stored[key] === 'string'
				? 'string'
				: key === keys[0] ? 'float' : 'int';

			// As the runtime does: a child is described where it is, by its key, but its value is
			// looked for on the parent as JavaScript sees it, where a mangled key finds nothing.
			// What an evaluation hands back is such a parent too, [true, value].
			engine.php = {
				switchFrame: async () => 0
				, describeChild: async (parent, key) => ({
					type: type(parent === job ? key : parent.key)
					, className: null
					, count: null
					, reference: false
					, value: parent[key]
				})
			};

			// Stands in for PHP: the property an evaluation asks for is read as PHP would read it,
			// from inside the class named, or the object's own.

			engine.writeFile = (path, content) => {
				const [, name] = content.match(/\$object->\{'(\w+)'\}/) ?? [];
				const [, owner] = content.match(/null, '((?:[^'\\]|\\.)*)'\)\(/) ?? [];

				// A private key begins with its class, a protected one with a star.
				const start = owner ? `\0${owner.replaceAll('\\\\', '\\')}\0` : '\0*\0';
				const key = keys.find(k => k.startsWith(start) && k.endsWith(`\0${name}`));

				evaluations.push(content);
				answered = {0: true, 1: stored[key], key};
			};

			engine.command = async () => {
				engine.captured = {value: answered};
			};

			const parent = engine.describe(
				'job'
				, job
				, "${'job'}"
				, true
				, 0
				, []
				, api >= 2 ? {type: 'object', className: 'App\\Job', count: null} : null
			);

			return (await engine.children(parent.reference)).values.map(
				value => [value.name, value.visibility, value.displayValue, value.writable]
			);
		};

		assert.deepEqual(await list(2), [
			['secret', 'private', '4.0', false]
			, ['guarded', 'protected', '"kept"', false]
			, ['open', 'public', '7', true]
			, ['odd\0named\0key', 'public', '9', true]
			, ['hidden', 'private', '2', false]
		]);

		// The three the runtime gave no value for were read by PHP: a private one inside the
		// class that declares it, the protected one inside the object's own.
		assert.deepEqual(evaluations, [
			'return (\\Closure::bind(static fn($object) => $object->{\'secret\'}, null, '
				+ '\'App\\\\Job\')(\n${\'job\'}\n));'
			, 'return ((static fn($object) => \\Closure::bind(static fn($object) => '
				+ '$object->{\'guarded\'}, null, $object)($object))(\n${\'job\'}\n));'
			, 'return (\\Closure::bind(static fn($object) => $object->{\'hidden\'}, null, '
				+ '\'class@anonymous\0/main.php:3$0\')(\n${\'job\'}\n));'
		]);

		// An older runtime cannot read a property by its mangled name, so only public ones are
		// shown.
		assert.deepEqual(await list(1), [
			['open', 'public', '7', true]
			, ['odd\0named\0key', 'public', '9', true]
		]);

		// Casting an object to an array gives keys that look mangled. They are array keys, shown
		// whole.
		const engine = new DebugEngine(() => {});

		const cast = {'\0App\\Job\0secret': 4, secret: 5};

		engine.paused = true;
		engine.dbgApi = 2;

		engine.php = {
			describeChild: async (parent, key) => ({
				type: 'int'
				, className: null
				, count: null
				, reference: false
				, value: parent[key]
			})
		};

		const array = engine.describe(
			'cast'
			, cast
			, "${'cast'}"
			, true
			, 0
			, []
			, {type: 'array', className: null, count: 2}
		);

		assert.deepEqual(
			(await engine.children(array.reference)).values.map(
				value => [value.name, value.visibility, value.displayValue]
			)
			, [['\0App\\Job\0secret', undefined, '4'], ['secret', undefined, '5']]
		);
	}
);

test('a type is shown beside a value only where the value does not already say it', async () => {
	const {typeLabel} = await import('../src/model.mjs');

	const shown = (type, displayValue, more = {}) => typeLabel({type, displayValue, ...more});

	assert.equal(shown('int', '8'), 'int');
	assert.equal(shown('float', '3.0'), 'float');
	assert.equal(shown('string', '"Notebook"', {count: 8}), 'string(8)');
	// The value says these itself.
	assert.equal(shown('array', 'array(3)', {count: 3}), '');
	assert.equal(shown('object', 'Cart', {className: 'Cart'}), '');
	assert.equal(shown('bool', 'true'), '');
	assert.equal(shown('null', 'null'), '');
	assert.equal(shown('unset', 'unset'), '');
	// An older runtime reports JavaScript's types, which add nothing.
	assert.equal(shown('number', '8'), '');
	assert.equal(shown('string', '"Notebook"'), '');
	assert.equal(shown('array', 'Array'), '');
	assert.equal(shown('object', 'Object'), '');
});

