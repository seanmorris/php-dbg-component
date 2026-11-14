import {test, expect} from '@playwright/test';

const setup = async page => {
	await page.goto('/test/harness.html');
	await page.waitForFunction(() => window.PhpDebugger);
};

const version = process.env.PHP_VERSION || '8.4';

const create = (page, options = {}) => page.evaluate(({options, version}) => {
	window.dbg = new window.PhpDebugger({runtimeBaseUrl: '/runtime/', version, ...options});
	window.dbg.mount(document.querySelector('#host'));
}, {options, version});

test(
	'lazy loading, clean program output, expectations, shared downloads and isolation'
	, async ({page}) => {
		await setup(page);

		await create(
			page
			, {
				code: '<?php echo "ok\\n"; fwrite(STDERR, "err");'
				, expect: {stdout: 'ok\n', stderr: 'err', exitCode: 0}
			}
		);

		expect(
			await page.evaluate(
				() => performance.getEntriesByType('resource').filter(
					r => /\.wasm|\.so(?:$|\?)/.test(r.name)
				).length
			)
		).toBe(0);

		const results = await page.evaluate(async () => {
			const second = new window.PhpDebugger(
				{
					...dbg.options
					, code: '<?php echo isset($foo) ? "leak" : "clean";'
					, expect: {
						stdout: 'clean'
					}
				}
			);

			const result = await Promise.all([dbg.run({mode: 'test'}), second.run({mode: 'test'})]);
			await second.destroy();

			return result;
		});

		expect(results.map(r => r.test.status)).toEqual(['passed', 'passed']);

		await expect(page.locator('#host [data-test-status]')).toHaveAttribute(
			'data-test-status'
			, 'passed'
		);
	}
);

test(
	'break, edit locals and nested values, step, caller frame and stale references'
	, async ({page}) => {
		await setup(page);

		await create(
			page
			, {code: '<?php\nfunction outer() {\n $outer = 2;\n return inner();\n}\nfunction inner() {\n $n = 3;\n $a = ["x" => 4];\n $o = (object)["x" => 5];\n $n += 1;\n echo "$n:{$a["x"]}:{$o->x}";\n}\nouter();', breakpoints: [10]}
		);

		const result = await page.evaluate(async () => {
			const done = dbg.run();
			await dbg.whenPaused();

			// Edit a local twice through its references, then an array element and a property.
			const locals = await dbg.inspect('variables');
			const n = locals.find(v => v.name === 'n');
			const edited = await dbg.setVariable(n.reference, '8');
			await dbg.setVariable(edited.reference, '9');
			await dbg.evaluate('$a["x"] = 20');
			await dbg.evaluate('$o->x = 30');

			// Select the caller and edit its local.
			await dbg.selectFrame(1);
			const callerLine = dbg.location.line;
			const frames = await dbg.inspect('frames');
			const caller = await dbg.inspect('variables');
			await dbg.setVariable(caller.find(v => v.name === 'outer').reference, '77');
			const editedCaller = await dbg.evaluate('$outer');

			// After a step, a reference from before it is stale.
			await dbg.selectFrame(0);
			await dbg.stepOver();
			let stale = false;

			try {await dbg.setVariable(n.reference, '1');} catch {stale = true;}

			await dbg.continue();

			return {result: await done, editedCaller, stale, callerLine, frames};
		});

		expect(result.result.stdout).toBe('10:20:30');
		expect(result.stale).toBe(true);
		// The stack is listed from the innermost frame even while the caller is selected.
		expect(result.callerLine).toBe(4);

		expect(result.frames.map(frame => [frame.frame, frame.lineNo, frame.selected])).toEqual(
			[[0, 10, false], [1, 4, true], [2, 13, false]]
		);

		expect(result.editedCaller.value).toBe(77);
	}
);

test('errors, nonzero exits and output without a trailing newline are distinct', async ({page}) => {
	await setup(page);
	await create(page);

	const results = await page.evaluate(async () => {
		const results = [];

		for(const code of ['<?php echo "[Script ended normally]";', '<?php exit(7);'
			, '<?php throw new RuntimeException("bad");', '<?php invalid syntax here'
		]){
			dbg.setCode(code);
			results.push(await dbg.run({mode: 'test'}));
		}

		return results;
	});

	expect(results[0].stdout).toBe('[Script ended normally]');
	expect(results[1].exitCode).toBe(7);
	expect(results[2].exitCode).not.toBe(0);

	expect(results[3].exitCode).not.toBe(0);
});

test('worker timeouts and cancellation settle, and the component can run again', async ({page}) => {
	await setup(page);
	await create(page, {code: '<?php while(true) {}'});

	const result = await page.evaluate(async () => {
		const timeout = await dbg.run({mode: 'test', timeoutMs: 300});
		const done = dbg.run();
		await new Promise(resolve => setTimeout(resolve, 300));
		await dbg.stop();
		const cancelled = await done;
		dbg.setCode('<?php echo "again";');

		return [timeout, cancelled, await dbg.run({mode: 'test'})];
	});

	expect(result.map(r => r.status)).toEqual(['timed-out', 'cancelled', 'completed']);
	expect(result[2].stdout).toBe('again');
});

test('main-thread mode exposes the page DOM through vrzno', async ({page}) => {
	await setup(page);

	await create(
		page
		, {
			execution: 'main'
			, code: '<?php vrzno_eval("document.body.dataset.php = 42"); echo "dom";'
		}
	);

	expect((await page.evaluate(() => dbg.run({mode: 'test'}))).stdout).toBe('dom');
	await expect(page.locator('body')).toHaveAttribute('data-php', '42');
});

test('worker pauses a running loop, edits it and resumes to completion', async({page}) => {
	await setup(page);

	await create(
		page
		, {
			code:
			'<?php\n$keep = true;\nwhile($keep) { $tick = ($tick ?? 0) + 1; }\necho "stopped";'
		}
	);

	const result = await page.evaluate(async() => {
		const running = new Promise(
			resolve => dbg.addEventListener(
				'statechange'
				, function onState(e){
					if(e.detail.state === 'running')
					{
						dbg.removeEventListener('statechange', onState);
						resolve();
					}
				}
			)
		);

		const done = dbg.run();
		await running;
		await dbg.pause();
		await dbg.evaluate('$keep = false');
		await dbg.continue();

		return done;
	});

	expect(result.status).toBe('completed');
	expect(result.stdout).toBe('stopped');
});

test(
	'a condition decides whether a breakpoint pauses; a logpoint logs and runs on, in tests too'
	, async({page}) => {
		await setup(page);
		await create(page);

		const report = await page.evaluate(async() => {
			const code = '<?php\n$sum = 0;\nfor($i = 0; $i < 5; $i++) {\n    $sum += $i;\n}\n'
				+ 'echo $sum, "\\n";';

			const report = {};

			// A condition: the breakpoint pauses only once $i is 3.
			dbg.setCode(code);
			await dbg.setBreakpoints([{line: 4, condition: '$i === 3'}]);

			let done = dbg.run();

			await dbg.whenPaused();
			report.pausedAt = (await dbg.evaluate('$i')).displayValue;
			await dbg.continue();
			report.conditionRun = (await done).stdout;

			// Logpoints: a string as it is, anything else exported, and no pause.
			await dbg.setBreakpoints(
				[{line: 4, log: '"i=$i sum=$sum"'}, {line: 6, log: '[$sum, $i > 2, null]'}]
			);

			const events = [];

			dbg.addEventListener('log', event => events.push(event.detail.message));

			let result = await dbg.run();

			report.logRun = {status: result.status, stdout: result.stdout, logs: result.logs};
			report.events = [...events];

			// A test run skips the plain breakpoint, keeps the logpoint and checks what it logged.
			await dbg.setBreakpoints([2, {line: 4, log: '$sum', condition: '$i % 2 === 0'}]);
			const expected = {stdout: '10\n', logs: ['0', '1', /^6$/]};

			result = await dbg.run({mode: 'test', expect: expected});
			report.testRun = {status: result.test.status, logs: result.logs.map(l => l.message)};
			result = await dbg.run({mode: 'test', expect: {logs: ['0', '2', '4']}});
			report.testFailures = result.test.failures;

			// A condition PHP cannot evaluate pauses, and the console says why. In a test run it
			// logs the reason instead.
			await dbg.setBreakpoints([{line: 4, condition: '$i ===', log: '$i'}]);
			result = await dbg.run({mode: 'test'});
			report.badConditionInTest = result.logs[0];
			await dbg.setBreakpoints([{line: 4, condition: '$i ==='}]);

			const errors = [];

			dbg.addEventListener('output', event => {
				if(event.detail.kind === 'error')
				{
					errors.push(event.detail.text);
				}
			});

			done = dbg.run();
			await dbg.whenPaused();
			report.badCondition = {state: dbg.state, errors};
			await dbg.stop();

			return report;
		});

		expect(report.pausedAt).toBe('3');
		expect(report.conditionRun).toBe('10\n');
		expect(report.logRun.status).toBe('completed');
		expect(report.logRun.stdout).toBe('10\n');

		expect(report.logRun.logs.map(entry => `${entry.line} ${entry.message}`)).toEqual([
			'4 i=0 sum=0'
			, '4 i=1 sum=0'
			, '4 i=2 sum=1'
			, '4 i=3 sum=3'
			, '4 i=4 sum=6'
			, '6 array (\n  0 => 10,\n  1 => true,\n  2 => NULL,\n)'
		]);

		expect(report.events).toEqual(report.logRun.logs.map(entry => entry.message));
		expect(report.testRun).toEqual({status: 'passed', logs: ['0', '1', '6']});

		const failed = /^The condition at \/main\.php:4 failed: /;

		const mismatch = {field: 'logs', expected: '0\n2\n4', actual: '0\n1\n6'};

		expect(report.testFailures).toEqual([mismatch]);
		expect(report.badConditionInTest).toMatchObject({line: 4, error: true});
		expect(report.badConditionInTest.message).toMatch(failed);
		expect(report.badCondition.state).toBe('paused');
		expect(report.badCondition.errors.join('')).toMatch(failed);
	}
);

test(
	'inspection pagination, cycles, readonly edit failure and multiline expressions'
	, async({page}) => {
		await setup(page);

		await create(
			page
			, {code: '<?php\nclass Box { public int $n = 2; }\n$o = new Box;\n$cycle = new stdClass; $cycle->self = $cycle;\n$a = range(1, 205);\necho $o->n;\n$later = 1;', breakpoints: [6]}
		);

		const values = await page.evaluate(async() => {
			const done = dbg.run();
			await dbg.whenPaused();
			const vars = await dbg.inspect();
			const array = vars.find(v => v.name === 'a');
			const chunk = await dbg.children(array.reference, {offset: 100, limit: 100});
			const cycle = await dbg.children(vars.find(v => v.name === 'cycle').reference);
			let rejected = false;

			try {await dbg.evaluate('$o->n = "invalid"');}catch {rejected = true;}

			const valid = await dbg.evaluate('(\n  6 * 7\n)');
			const ratio = await dbg.evaluate('1.5 * 2');
			await dbg.continue();

			return {
				chunk
				, cycle
				, rejected
				, valid
				, ratio
				, later: vars.find(v => v.name === 'later')
				, result: await done
			};
		});

		expect([values.later.type, values.later.displayValue]).toEqual(['unset', 'unset']);

		// A runtime that reports PHP types keeps a whole-number float a float; an older one only
		// has JavaScript's number.
		expect([values.ratio.type, values.ratio.displayValue]).toEqual(
			values.valid.type === 'int' ? ['float', '3.0'] : ['number', '3']
		);

		expect(values.chunk.total).toBe(205);
		expect(values.chunk.values).toHaveLength(100);
		expect(values.cycle.values[0].circular).toBe(true);
		expect(values.rejected).toBe(true);
		expect(values.valid.value).toBe(42);

		expect(values.result.stdout).toBe('2');
	}
);

test('shared binary download is fetched once despite disabled HTTP cache', async({page}) => {
	await setup(page);

	const requests = [];

	page.on(
		'request'
		, request => {
			if(new URL(request.url()).pathname.endsWith('.wasm'))
			{
				requests.push(request.url());
			}
		}
	);

	const results = await page.evaluate(async version => {
		const components = [];

		// Each one writes its own number to the same path and reads it back.
		for(const i of [0, 1, 2])
		{
			const code = `<?php file_put_contents('/own.txt', '${i}');`
				+ " echo file_get_contents('/own.txt');";

			components.push(new PhpDebugger({runtimeBaseUrl: '/runtime/', version, code}));
		}

		const results = await Promise.all(components.map(d => d.run({mode: 'test'})));

		await Promise.all(components.map(d => d.destroy()));

		return results;
	}, version
	);

	expect(results.map(r => r.stdout)).toEqual(['0', '1', '2']);
	expect(requests).toHaveLength(1);
});

test(
	'explicit extension selection loads just the requested package and retries failed manifests'
	, async({page}) => {
		await setup(page);
		const requests = [];
		page.on('request', r => requests.push(new URL(r.url()).pathname));
		let attempts = 0;

		await page.route(
			`**/php${version}-dbg-worker.mjs.assets.json`
			, route => ++attempts === 1
				? route.fulfill({status: 503, body: 'retry'})
				: route.continue()
		);

		const results = await page.evaluate(async version => {
			const d = new PhpDebugger(
				{
					runtimeBaseUrl: '/runtime/'
					, version
					, extensions: ['curl']
					, code: '<?php echo extension_loaded("curl") ? "curl" : "missing";'
				}
			);

			const first = await d.run({mode: 'test'});

			const second = await d.run({mode: 'test'});
			await d.destroy();

			return [first, second];
		}, version
		);

		expect(results[0].status).toBe('error');
		expect(results[1].stdout).toBe('curl');
		const libraries = [...new Set(requests.filter(p => p.endsWith('.so')))];

		expect(libraries).toEqual([`/php-wasm-curl/php${version}-curl.so`]);
	}
);

test(
	'cancel during loading and disconnect a custom element without leaving a run alive'
	, async({page}) => {
		await setup(page);

		await page.route(
			'**/*.assets.json'
			, async route => {await new Promise(r => setTimeout(r, 250)); await route.continue();}
		);

		const result = await page.evaluate(async() => {
			const element = document.createElement('php-debugger');

			element.options = {runtimeBaseUrl: '/runtime/', code: '<?php while(true) {}'};
			document.body.append(element);
			const controller = element.debugger;
			const done = element.run();
			element.remove();
			const result = await done;
			await new Promise(r => setTimeout(r, 400));

			return {
				result
				, state: controller.state
			};
		});

		expect(result.result.status).toBe('cancelled');
		expect(result.state).toBe('destroyed');
	}
);

test(
	'run joins an in-flight prepare and cancelled async source never starts a runtime'
	, async({page}) => {
		await setup(page);

		const result = await page.evaluate(async version => {
			const d = new PhpDebugger(
				{runtimeBaseUrl: '/runtime/', version, code: '<?php echo "prepared";'}
			);

			const prepared = d.prepare();
			const done = d.run({mode: 'test'});
			await prepared;
			const result = await done;
			await d.destroy();
			let release;

			const loading = new PhpDebugger(
				{runtimeBaseUrl: '/runtime/', version, code: () => new Promise(r => release = r)}
			);

			const states = [];
			loading.addEventListener('statechange', e => states.push(e.detail.state));
			const cancelled = loading.run();
			await loading.stop();
			release('<?php echo "late";');
			await new Promise(r => setTimeout(r, 300));
			await loading.destroy();

			return {result, cancelled: await cancelled, states};
		}, version
		);

		expect(result.result.stdout).toBe('prepared');

		expect(result.cancelled.status).toBe('cancelled');

		expect(result.states).not.toContain('loading');
	}
);

test('explicit support packages load without fetching unrelated extensions', async({page}) => {
	await setup(page);

	const requests = [];
	page.on('request', r => requests.push(new URL(r.url()).pathname));

	const result = await page.evaluate(async version => {
		const d = new PhpDebugger(
			{runtimeBaseUrl: '/runtime/', version, extensions: ['dom', 'libxml'], code: '<?php $doc=new DOMDocument(); $doc->loadXML("<root>yes</root>"); echo $doc->documentElement->textContent;'}
		);

		const result = await d.run({mode: 'test'});
		await d.destroy();

		return result;
	}, version
	);

	expect(result.stdout).toBe('yes');

	expect(requests.filter(p => p.endsWith('.so')).sort()).toEqual(
		[`/php-wasm-dom/php${version}-dom.so`, '/php-wasm-libxml/libxml2.so'].sort()
	);
});

test('main-thread cooperative stop and explicit pause in test mode settle', async({page}) => {
	await setup(page);

	const results = await page.evaluate(async version => {
		const results = [];

		for(const execution of ['main', 'worker'])
		{
			const d = new PhpDebugger(
				{
					runtimeBaseUrl: '/runtime/'
					, version
					, execution
					, code: '<?php $keep=true; while($keep) {} echo "resumed";'
				}
			);

			const running = new Promise(
				resolve => d.addEventListener(
					'statechange'
					, function state(e){
						if(e.detail.state === 'running')
						{
							d.removeEventListener('statechange', state);
							resolve();
						}
					}
				)
			);

			const done = d.run({mode: 'test'});

			await running;
			const paused = await d.pause();
			await d.evaluate('$keep=false');
			await d.continue();
			results.push({pause: paused.reason, result: await done});
			d.setCode('<?php while(true) {}');
			const stopped = d.run({mode: 'test', timeoutMs: 150});
			results.push({result: await stopped});
			await d.destroy();
		}

		return results;
	}, version
	);

	expect(results.map(r => r.result.status)).toEqual(
		['completed', 'timed-out', 'completed', 'timed-out']
	);

	expect(results[0].pause).toBe('pause');

	expect(results[2].pause).toBe('pause');
});

test('changing PHP versions is lazy and uses the selected interpreter', async({page}) => {
	await setup(page);

	const requests = [];
	page.on('request', r => requests.push(new URL(r.url()).pathname));

	const result = await page.evaluate(async version => {
		const other = version === '8.4' ? '8.0' : '8.4';

		const d = new PhpDebugger(
			{
				runtimeBaseUrl: '/runtime/'
				, version
				, code: '<?php echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;'
			}
		);

		const first = await d.run({mode: 'test'});

		await d.setVersion(other);
		window.versionSwitchDebugger = d;

		return {
			first
			, other
		};
	}, version
	);

	expect(result.first.stdout).toBe(version);
	expect(requests.some(p => p.includes(`php${result.other}-dbg-worker`))).toBe(false);

	const second = await page.evaluate(
		async() => {
			const d = window.versionSwitchDebugger;
			const result = await d.run({mode: 'test'});
			await d.destroy();

			return result;
		}
	);

	expect(second.stdout).toBe(result.other);
	expect(second.version).toBe(result.other);
});

test('variable handles cannot be reused after restarting a runtime', async({page}) => {
	await setup(page);
	await create(page, {code: '<?php\n$n=1;\necho $n;', breakpoints: [3]});

	const result = await page.evaluate(async() => {
		const first = dbg.run();
		await dbg.whenPaused();
		const old = (await dbg.inspect()).find(v => v.name === 'n').reference;
		await dbg.stop();
		await first;
		const done = dbg.run();
		await dbg.whenPaused();
		await dbg.inspect();
		let rejected = false;

		try{await dbg.setVariable(old, '99');}catch{rejected = true;}

		await dbg.continue();

		return {rejected, result: await done};
	});

	expect(result.rejected).toBe(true);
	expect(result.result.stdout).toBe('1');
});

test(
	'virtual files, supplied stdin, Unicode and shutdown output reach the result'
	, async({page}) => {
		await setup(page);

		await create(
			page
			, {code: '<?php echo strtoupper(trim(fgets(STDIN))); require "/helper.php"; register_shutdown_function(function() { echo ":shutdown"; });', files: {'/helper.php': '<?php echo ":λ";'}, stdin: 'input\n'}
		);

		const result = await page.evaluate(
			() => dbg.run({mode: 'test', expect: {stdout: 'INPUT:λ:shutdown', exitCode: 0}})
		);

		expect(result.test.status).toBe('passed');
	}
);

test(
	'shutdown callbacks, destructors, output handlers and early exits complete exactly once'
	, async({page}) => {
		await setup(page);
		await create(page);

		const results = await page.evaluate(async() => {
			const sources = [
				'<?php ob_start(function($s){return strtoupper($s);}); class Gone { function __destruct(){echo ":destroy";} } $o=new Gone; register_shutdown_function(function(){echo ":shutdown";}); echo "body";'
				, '<?php register_shutdown_function(function(){echo "last";}); exit(7);'
				, '<?php register_shutdown_function(function(){throw new RuntimeException("shutdown failure");});'
			];

			const results = [];

			for(const code of sources)
			{
				dbg.setCode(code);
				results.push(await dbg.run({mode: 'test'}));
			}

			return results;
		});

		expect(results[0].stdout).toBe('BODY:SHUTDOWN:DESTROY');
		expect(results[0].exitCode).toBe(0);
		expect(results[1].stdout).toBe('last');
		expect(results[1].exitCode).toBe(7);
		expect(results[2].exitCode).toBe(255);

		expect(results[2].diagnostics.map(d => d.message).join('\n')).toContain('shutdown failure');
	}
);


test('shutdown processing remains cancellable in both execution modes', async({page}) => {
	await setup(page);

	const results = await page.evaluate(async version => {
		const results = [];

		for(const execution of ['main', 'worker'])
		{
			const d = new PhpDebugger(
				{
					runtimeBaseUrl: '/runtime/'
					, version
					, execution
					, code: '<?php register_shutdown_function(function(){while(true) {}});'
				}
			);

			results.push(await d.run({mode: 'test', timeoutMs: 200}));
			await d.destroy();
		}

		return results;
	}, version
	);

	expect(results.map(r => r.status)).toEqual(['timed-out', 'timed-out']);
});

test('reports the interpreter download while loading', async({page}) => {
	await setup(page);
	await create(page, {code: '<?php echo 1;'});

	const result = await page.evaluate(
		async() => {
			const seen = [];
			dbg.addEventListener('progress', event => seen.push(event.detail));
			const run = await dbg.run();

			return {seen, status: run.status};
		}
	);

	expect(result.status).toBe('completed');
	expect(result.seen.length).toBeGreaterThan(0);
	const last = result.seen.at(-1);
	expect(last.total).toBeGreaterThan(1_000_000);

	expect(last.loaded).toBe(last.total);
});

test('a failed expression names its own problem and leaves the exit code alone', async({page}) => {
	await setup(page);
	await create(page, {code: '<?php\n$n = 2;\necho $n;', breakpoints: [3]});

	const result = await page.evaluate(async() => {
		const done = dbg.run();
		await dbg.whenPaused();

		const expressions = [
			'1 +', '$n +* 2', '1)', 'nope()', 'intdiv(1, 0)'
			, '$n + 1;', '$n // the count', '[\n1,\n2 3\n]'
		];

		const answers = {};

		for(const expression of expressions)
		{
			answers[expression] = await dbg.evaluate(expression).then(
				value => value.displayValue
				, error => error.message
			);
		}

		const n = (await dbg.inspect('variables')).find(value => value.name === 'n');
		let edit;

		try
		{
			await dbg.setVariable(n.reference, '5 +');
		}
		catch(error)
		{
			edit = error.message;
		}

		const locals = (await dbg.inspect('variables')).map(value => value.name);
		await dbg.continue();
		const {exitCode, status, stdout, diagnostics} = await done;

		return {answers, edit, locals, exitCode, status, stdout, diagnostics};
	});

	expect(result.answers).toEqual(
		{
			'1 +': 'syntax error, unexpected end of expression'
			, '$n +* 2': 'syntax error, unexpected token "*"'
			, '1)': "Unmatched ')'"

			, 'nope()': 'Error: Call to undefined function nope()'
			, 'intdiv(1, 0)': 'DivisionByZeroError: Division by zero'

			, '$n + 1;': '3'
			, '$n // the count': '2'
			, '[\n1,\n2 3\n]': 'syntax error, unexpected integer "3", expecting "]" on line 3'
		}
	);

	expect(result.edit).toBe('syntax error, unexpected end of expression');
	// Nothing the evaluation used is left behind in the frame.
	expect(result.locals).not.toContain('__phpDebuggerError');
	// The script itself ran to its end: the failures above are not its failures.
	expect(result.stdout).toBe('2');
	expect(result.status).toBe('completed');
	expect(result.exitCode).toBe(0);
	expect(result.diagnostics).toEqual([]);
});

test('opcodes() lists what phpdbg prints, and marks the op the frame stands on', async({page}) => {
	await setup(page);

	await create(
		page
		, {
			code: [
				'<?php'
				, 'function twice($n) {'
				, '    return $n * 2;'
				, '}'
				, 'class Shop { function open() { return 1; } }'
				, 'echo twice(4);'
			].join('\n')
			, breakpoints: [3]
		}
	);

	const result = await page.evaluate(async() => {
		const output = [];

		dbg.addEventListener('output', event => output.push(event.detail));

		const done = dbg.run();

		await dbg.whenPaused();

		/** A listing in brief: each function's name and opcodes, and the op marked current. */
		const brief = ({functions, current}) => ({
			names: functions.map(listed => listed.name)
			, opcodes: functions.map(listed => listed.ops.map(op => op.opcode))
			, current: current && functions[0].ops[current.index]?.opcode
		});

		const frame = brief(await dbg.opcodes());

		await dbg.selectFrame(1);

		const caller = brief(await dbg.opcodes());
		const script = brief(await dbg.opcodes({script: true}));
		const twice = brief(await dbg.opcodes({function: 'twice'}));
		const shop = brief(await dbg.opcodes({class: 'Shop'}));

		/** Why opcodes() refused a target. */
		const refusal = target => dbg.opcodes(target).catch(error => error.message);

		const missing = await refusal({function: 'nope'});
		const unsafe = await refusal({function: 'twice; continue'});

		await dbg.continue();

		const {stdout, diagnostics} = await done;

		return {frame, caller, script, twice, shop, missing, unsafe, stdout, diagnostics, output};
	});

	// Paused in twice(): its ops, the statement on line 3 current.
	expect(result.frame.names).toEqual(['twice']);
	expect(result.frame.opcodes[0]).toEqual(expect.arrayContaining(['RECV', 'MUL']));
	expect(result.frame.current).toBe('EXT_STMT');

	// The caller's frame is the script, stopped at the call.
	expect(result.caller.names).toEqual(['{main}']);
	expect(result.caller.current).toMatch(/^DO_U?FCALL$/);
	expect(result.script).toEqual({...result.caller, current: null});
	expect(result.twice).toEqual({...result.frame, current: null});
	expect(result.shop.names).toEqual(['Shop::open']);

	expect(result.missing).toBe('The function nope could not be found');
	expect(result.unsafe).toBe('Not a PHP function or class name: twice; continue');

	// None of it reached the console or the run's diagnostics, and the run went on as before.
	const listing = /EXT_STMT|\d+ ops\)|could not be found/;

	expect(result.output.filter(event => listing.test(event.text))).toEqual([]);
	expect(result.diagnostics).toEqual([]);
	expect(result.stdout).toBe('8');
});

test(
	'opcodes() reads a string with line breaks, a class that extends a built-in, a long opcode'
	, async({page}) => {
		await setup(page);

		await create(
			page
			, {
				code: [
					'<?php'
					, 'function show() { echo "Usage:\\nOptions:\\n  -h\\n"; return 1; }'
					, 'class Broke extends Exception { function why() { return "x"; } }'
					, 'class Bag { static function put($a) { return strlen($a); } }'
					, 'echo Bag::put("q");'
				].join('\n')
				, breakpoints: [5]
			}
		);

		const result = await page.evaluate(async() => {
			const done = dbg.run();

			await dbg.whenPaused();

			const show = (await dbg.opcodes({function: 'show'})).functions;
			const broke = (await dbg.opcodes({class: 'Broke'})).functions;
			const [script] = (await dbg.opcodes()).functions;

			// Line 5 is met again when its call returns.
			while(dbg.state === 'paused')
			{
				await dbg.continue();
			}

			await done;

			return {show, broke, call: script.ops.find(op => op.opcode.startsWith('INIT_STATIC'))};
		});

		// The string's second line, "Options:", is not a function, and its ops stay in order.
		expect(result.show.map(listed => listed.name)).toEqual(['show']);

		const [{ops}] = result.show;

		expect(ops.map(op => op.index)).toEqual(ops.map((op, index) => index));
		expect(ops.find(op => op.opcode === 'ECHO').operands).toContain('Options:');

		// The eleven internal methods phpdbg names after why() are not operands of its last op.
		expect(result.broke.map(listed => listed.name)).toEqual(['Broke::why']);
		expect(result.broke[0].ops.at(-1).operands).toBe('null');

		// PHP 8.0 writes this opcode wider than its column; the operands are still its own.
		expect(result.call.opcode).toMatch(/^INIT_STATIC_METHOD_CALL(<1>)?$/);

		expect(result.call.operands).toMatch(/^(1 string\("Bag"\) string\("put"\)|"Bag" "put")$/);
	}
);

test(
	'Step out stops in the caller; Until stops past its line, or at a breakpoint'
	, async({page}) => {
		await setup(page);

		await create(
			page
			, {
				code: [
					'<?php'
					, 'function total($items) {'
					, '    $sum = 0;'
					, '    foreach($items as $item) {'
					, '        $sum += $item;'
					, '    }'

					, '    return $sum;'
					, '}'
					, '$t = total([1, 2, 3]);'
					, 'echo $t;'
				].join('\n')
			}
		);

		const report = await page.evaluate(async() => {
			const pauses = [];

			dbg.addEventListener('pause', event => pauses.push(event.detail.reason));

			/** Where a resume ended, why, and what the sum was there. */
			const landed = async resumed => {
				const {line} = await resumed;
				const sum = dbg.state === 'paused'
					? (await dbg.evaluate('$sum ?? null')).value
					: null;

				return `${line} ${pauses.at(-1)} sum=${sum}`;
			};

			const report = {};

			// Until, on the loop's last line, finishes the loop: three times round, then line 7.
			await dbg.setBreakpoints([5]);

			let done = dbg.run();

			await dbg.whenPaused();
			await dbg.setBreakpoints([]);
			report.until = await landed(dbg.until());

			// Step out of total() stops where it was called, with nothing more run there.
			report.out = await landed(dbg.stepOut());
			report.assigned = (await dbg.evaluate('isset($t)')).value;
			await dbg.continue();
			report.stdout = (await done).stdout;

			// Where the next line is a later one, Until is a step to it. From the loop's last line,
			// with its breakpoint left on, it stops there the next time round, as Continue would.
			await dbg.setBreakpoints([3, 5]);
			done = dbg.run();
			await dbg.whenPaused();
			report.next = await landed(dbg.until());
			report.again = await landed(dbg.until());
			report.round = await landed(dbg.until());

			// Step out from the main script runs it to its end.
			await dbg.setBreakpoints([]);
			await dbg.stepOut();
			await dbg.stepOut();
			report.ended = (await done).status;

			return report;
		});

		expect(report.until).toBe('7 step sum=6');
		expect(report.out).toBe('9 step sum=null');
		expect(report.assigned).toBe(false);
		expect(report.stdout).toBe('6');
		expect(report.next).toBe('4 step sum=0');
		expect(report.again).toBe('5 step sum=0');
		expect(report.round).toBe('5 breakpoint sum=1');
		expect(report.ended).toBe('completed');
	}
);

test('a name in other than ASCII reaches phpdbg whole', async({page}) => {
	await setup(page);

	await create(
		page
		, {
			code: [
				'<?php'
				, 'function café() { return 1; }'
				, 'function caféé() { return 2; }'
				, 'function 😀() { return 3; }'
				, 'class Naïveté { function où() { return 4; } }'
				, 'echo café() + caféé() + 😀();'
			].join('\n')
			, breakpoints: [3]
		}
	);

	const names = await page.evaluate(async() => {
		const done = dbg.run();

		await dbg.whenPaused();

		/** The names of the functions a target lists. */
		const listed = async target => (await dbg.opcodes(target)).functions.map(f => f.name);

		const names = [
			...await listed({function: 'caféé'})
			, ...await listed({function: '😀'})
			, ...await listed({class: 'Naïveté'})
		];

		await dbg.continue();
		await done;

		return names;
	});

	// The runtime cut a command line at as many bytes as it had characters: "caféé" was listed
	// as café(), and a name further from ASCII was not found.
	expect(names).toEqual(['caféé', '😀', 'Naïveté::où']);
});

test(
	'a breakpoint acts once each time its line is reached, and nothing evaluated stops at one'
	, async({page}) => {
		await setup(page);
		await create(page);

		const report = await page.evaluate(async() => {
			const code = [
				'<?php'
				, 'function put($a) {'
				, '    return strlen($a);'
				, '}'
				, '$n = 0;'
				, 'for($i = 0; $i < 2; $i++) {'
				, '    $n += put("q") + put("rr");'
				, '}'
				, 'echo $n;'
			].join('\n');

			const report = {};

			/** Continue from each pause to the end of the run, noting where each one was. */
			const pauses = async done => {
				const seen = [];

				await dbg.whenPaused();

				while(dbg.state === 'paused')
				{
					seen.push(`${dbg.location.line} i=${(await dbg.evaluate('$i ?? "-"')).value}`);
					await dbg.continue();
				}

				return {seen, result: await done};
			};

			dbg.setCode(code);

			// Line 7 makes two calls. phpdbg reports the line reached again as each returns; a
			// logpoint there logs once each time round the loop.
			await dbg.setBreakpoints([{line: 7, log: '"i=$i"'}]);
			report.logged = (await dbg.run()).logs.map(entry => entry.message);

			// A breakpoint that pauses does so again as each call returns, as phpdbg's do.
			await dbg.setBreakpoints([7]);
			report.paused = (await pauses(dbg.run())).seen;

			// The loop's own line is reached for its start and for each step of it.
			await dbg.setBreakpoints([{line: 6, log: '"at " . ($i ?? "-")'}]);
			report.loop = (await dbg.run()).logs.map(entry => entry.message);

			// A log that calls a function with a breakpoint in it: the log is the call's value,
			// and the breakpoint is first reached by the program's own call.
			await dbg.setBreakpoints([3, {line: 5, log: 'put("abc")'}]);

			const done = dbg.run();
			const first = await dbg.whenPaused();

			report.nested = {
				line: first.location.line
				, argument: (await dbg.evaluate('$a')).value
				, logs: [...dbg.active.logs]
			};

			// So is an expression evaluated there, and the pause is where it was.
			report.evaluated = (await dbg.evaluate('put("zz") + put("z")')).value;
			report.after = {line: dbg.location.line, argument: (await dbg.evaluate('$a')).value};
			await dbg.setBreakpoints([]);
			await dbg.continue();
			report.stdout = (await done).stdout;

			return report;
		});

		expect(report.logged).toEqual(['i=0', 'i=1']);
		expect(report.paused).toEqual(['7 i=0', '7 i=0', '7 i=0', '7 i=1', '7 i=1', '7 i=1']);
		expect(report.loop).toEqual(['at -', 'at 0', 'at 1']);

		expect(report.nested).toEqual({
			line: 3
			, argument: 'q'
			, logs: [{file: '/main.php', line: 5, message: '3'}]
		});

		expect(report.evaluated).toBe(3);
		expect(report.after).toEqual({line: 3, argument: 'q'});
		expect(report.stdout).toBe('6');
	}
);

test(
	'a step onto a logpoint prints its message and pauses; a return to its line does not'
	, async({page}) => {
		await setup(page);
		await create(page);

		const report = await page.evaluate(async() => {
			const code = [
				'<?php'
				, 'function put($a) {'
				, '    return strlen($a);'
				, '}'
				, '$n = 0;'
				, 'for($i = 0; $i < 2; $i++) {'
				, '    $n += put("q") + put("rr");'
				, '}'
				, 'echo $n;'
			].join('\n');

			const logs = [];
			const visited = [];

			/** Where a step landed, and what has been logged by then. */
			const landed = async step => {
				const {line} = await step;

				visited.push(`${line}: ${logs.join(' ')}`);
			};

			dbg.addEventListener('log', event => logs.push(event.detail.message));
			dbg.setCode(code);
			await dbg.setBreakpoints([5, {line: 7, log: '"i=$i"'}]);

			const done = dbg.run();

			await dbg.whenPaused();
			await landed(dbg.stepOver());
			await landed(dbg.stepOver());
			await landed(dbg.stepInto());
			await landed(dbg.stepOut());
			await dbg.continue();

			return {visited, logs, stdout: (await done).stdout};
		});

		// Over the loop's line onto line 7, which logs; into put() and out again, which does not.
		expect(report.visited).toEqual(['6: ', '7: i=0', '3: i=0', '7: i=0']);
		expect(report.logs).toEqual(['i=0', 'i=1']);
		expect(report.stdout).toBe('6');
	}
);

test('a run ends as a failed test whatever shape its expectations have', async({page}) => {
	await setup(page);
	await create(page, {code: '<?php echo "ok";'});

	const report = await page.evaluate(async() => {

		/** A test run in brief: how it ended and what failed. */
		const brief = ({status, test}) => ({status, test: test.status, failures: test.failures});

		const logs = brief(await dbg.run({mode: 'test', expect: {logs: 'ok'}}));
		const text = brief(await dbg.run({mode: 'test', expect: 'ok'}));

		// An expectation that throws when it is read is the worst there is: the run still ends.
		const unreadable = {get stdout() {throw new Error('unreadable');}};
		const thrown = brief(await dbg.run({mode: 'test', expect: unreadable}));

		// And the debugger is free for the next run.
		const after = brief(await dbg.run({mode: 'test', expect: {stdout: 'ok'}}));

		return {logs, text, thrown, after, state: dbg.state};
	});

	const message = 'expect.logs must be an array of strings or patterns';

	expect(report.logs).toEqual({
		status: 'completed'
		, test: 'failed'
		, failures: [{field: 'logs', message}]
	});

	expect(report.text.failures).toEqual(
		[{field: 'expect', message: 'Expectations must be an object'}]
	);

	expect(report.thrown).toEqual({
		status: 'completed'
		, test: 'failed'
		, failures: [{field: 'expect', message: 'unreadable'}]
	});

	expect(report.after).toEqual({status: 'completed', test: 'passed', failures: []});
	expect(report.state).toBe('completed');
});
