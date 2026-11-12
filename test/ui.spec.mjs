import {test, expect} from '@playwright/test';

test.beforeEach(
	async({page}) => {
		await page.addInitScript(
			version => {window.phpVersionUnderTest = version;}
			, process.env.PHP_VERSION || '8.4'
		);
	}
);

test('declarative autorun, CSS overrides, and generic element/variable sources', async({page}) => {
	await page.goto('/test/harness.html');
	await page.waitForFunction(() => window.PhpDebugger);

	await page.addStyleTag(
		{
			content: '.php-debugger { --php-debugger-bg: rgb(7, 8, 9); border-radius: 19px; }'
				+ ' .php-debugger .php-debugger-button { font-family: serif; }'
		}
	);

	const results = await page.evaluate(async() => {
		const element = document.createElement('php-debugger');

		element.setAttribute('runtime-base-url', '/runtime/');
		element.setAttribute('version', window.phpVersionUnderTest);
		element.setAttribute('autorun', '');
		element.setAttribute('mode', 'test');
		element.code = '<?php echo "auto";';
		element.expect = {stdout: 'auto'};

		const done = new Promise(
			resolve => element.addEventListener(
				'phpdbg-complete'
				, event => resolve(event.detail)
				, {once: true}
			)
		);

		document.body.append(element);
		const result = await done;
		const source = document.createElement('pre');
		source.textContent = '<?php echo "pre";';
		document.body.append(source);

		const fromElement = new PhpDebugger(
			{source, version: window.phpVersionUnderTest, runtimeBaseUrl: '/runtime/'}
		);

		const second = await fromElement.run({mode: 'test'});
		await fromElement.destroy();
		let code = '<?php echo "first";';

		const fromVariable = new PhpDebugger(
			{code: () => code, version: window.phpVersionUnderTest, runtimeBaseUrl: '/runtime/'}
		);

		code = '<?php echo "second";';
		const third = await fromVariable.run({mode: 'test'});
		await fromVariable.destroy();

		return [result, second, third];
	});

	expect(results[0].test.status).toBe('passed');

	expect(results.slice(1).map(r => r.stdout)).toEqual(['pre', 'second']);

	await expect(page.locator('php-debugger .php-debugger')).toHaveCSS(
		'background-color'
		, 'rgb(7, 8, 9)'
	);

	await expect(page.locator('php-debugger .php-debugger')).toHaveCSS('border-radius', '19px');

	await expect(page.getByRole('button', {name: 'Run', exact: true})).toHaveCSS(
		'font-family'
		, 'serif'
	);
});

for(const kind of ['ace', 'codemirror5', 'codemirror6'])
{
	test(
		`${kind}: existing editor, breakpoints, edits, highlighting and cleanup`
		, async({page}) => {
			await page.goto('/test/harness.html');
			await page.waitForFunction(() => window.PhpDebugger);

			if(kind === 'ace')
			{
				await page.addScriptTag({url: '/node_modules/ace-builds/src-noconflict/ace.js'});
			}

			if(kind === 'codemirror5')
			{
				await page.addScriptTag({url: '/node_modules/codemirror/lib/codemirror.js'});
				await page.addStyleTag({url: '/node_modules/codemirror/lib/codemirror.css'});
			}

			const result = await page.evaluate(async kind => {
				const host = document.createElement('div');
				host.style.height = '200px';
				document.body.append(host);
				const code = '<?php\n$n = 2;\n$n += 3;\necho $n;';
				let editor;
				let adapter;

				if(kind === 'ace')
				{
					editor = ace.edit(host);
					editor.setValue(code);
					adapter = (await import('/src/adapters/ace.mjs')).createAceAdapter(editor);
				}
				else if(kind === 'codemirror5')
				{
					editor = CodeMirror(host, {value: code, lineNumbers: true});

					adapter = (await import('/src/adapters/codemirror5.mjs'))
						.createCodeMirror5Adapter(editor);
				}
				else
				{
					const {EditorState, EditorView, lineNumbers, createCodeMirror6Adapter}
					= await import(
						'/editors.mjs'
					);

					editor = new EditorView(
						{
							state: EditorState.create({doc: code, extensions: [lineNumbers()]})
							, parent: host
						}
					);

					adapter = createCodeMirror6Adapter(editor);
				}

				const dbg = new PhpDebugger(
					{
						source: adapter
						, version: window.phpVersionUnderTest
						, runtimeBaseUrl: '/runtime/'
						, breakpoints: [
							3
						]
					}
				);

				dbg.mount(document.querySelector('#host'));
				const done = dbg.run();
				await dbg.whenPaused();

				// Ace draws its markers on the next frame.
				await new Promise(
					resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))
				);

				// CodeMirror 6 keeps an invisible marker in its gutter to reserve the width.

				const box = selector => [...host.querySelectorAll(selector)].find(
					element => element.getClientRects().length
						&& getComputedStyle(element).visibility === 'visible'
				).getBoundingClientRect();

				const line = [...host.querySelectorAll('.ace_line,.CodeMirror-line,.cm-line')].find(
					element => element.textContent === '$n += 3;'
				).getBoundingClientRect();

				const paused = box('.php-debugger-active-line');
				const dot = box('.php-debugger-breakpoint-marker');

				const marks = {
					paused: Math.abs(paused.top - line.top)
					, pausedHeight: paused.height
					, dot: Math.abs(dot.top + dot.height / 2 - line.top - line.height / 2)
					, lineHeight: line.height
				};

				const values = await dbg.inspect('variables');
				await dbg.setVariable(values.find(v => v.name === 'n').reference, '10');
				await dbg.continue();
				const result = await done;
				await dbg.destroy();
				adapter.dispose();
				const text = adapter.getCode();

				if(kind !== 'codemirror5')
				{
					editor.destroy();
				}

				return {
					result
					, text
					, marks
				};
			}, kind
			);

			expect(result.result.stdout).toBe('13');
			expect(result.text).toContain('$n = 2;');
			// The paused line's marker and the breakpoint's sit on line 3, where execution stopped.
			expect(result.marks.paused).toBeLessThan(2);
			expect(result.marks.pausedHeight).toBeGreaterThan(result.marks.lineHeight / 2);
			expect(result.marks.dot).toBeLessThan(result.marks.lineHeight / 2);
		}
	);
}

test('GUI edits a live value and exposes symbols, globals, constants and frames', async({page}) => {
	await page.goto('/test/harness.html');
	await page.waitForFunction(() => window.PhpDebugger);

	await page.evaluate(() => {
		window.dbg = new PhpDebugger(
			{version: window.phpVersionUnderTest, runtimeBaseUrl: '/runtime/', code: '<?php\nconst EXAMPLE = 7;\nclass Example {}\n$globalValue = 5;\nfunction example() {\n $n = 2;\n echo $n;\n}\nexample();', breakpoints: [7]}
		);

		dbg.mount(document.querySelector('#host'));
	});

	await page.getByRole('button', {name: 'Run', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('paused');
	await page.getByRole('button', {name: 'Edit n', exact: true}).click();
	await page.getByRole('textbox', {name: 'New PHP expression for n', exact: true}).fill('42');
	await page.getByRole('button', {name: 'Apply', exact: true}).click();
	await expect(page.locator('.php-debugger-value-preview')).toContainText('42');
	await page.getByRole('button', {name: 'globals', exact: true}).click();
	await expect(page.locator('.php-debugger-values')).toContainText('globalValue');
	await page.getByRole('button', {name: 'constants', exact: true}).click();
	await expect(page.locator('.php-debugger-values')).toContainText('EXAMPLE');

	await expect(
		page.locator('.php-debugger-values').getByRole('button', {name: /^Edit /})
	).toHaveCount(0);

	await page.getByRole('button', {name: 'functions', exact: true}).click();
	await expect(page.locator('.php-debugger-values')).toContainText('example');
	await page.getByRole('button', {name: 'classes', exact: true}).click();
	await expect(page.locator('.php-debugger-values')).toContainText('Example');
	await page.getByRole('button', {name: 'files', exact: true}).click();
	await expect(page.locator('.php-debugger-values')).toContainText('/main.php');
	await page.getByRole('button', {name: 'frames', exact: true}).click();
	await expect(page.locator('.php-debugger-values')).toContainText('Frame 0');
	// Selecting the caller keeps the whole stack listed, marks the selection and moves the
	// highlight to the call site.
	const frames = page.locator('.php-debugger-symbol');
	await expect(frames).toHaveCount(2);
	await expect(frames.nth(0)).toHaveAttribute('aria-current', 'true');

	await frames.nth(1).click();
	await expect(frames.nth(1)).toHaveAttribute('aria-current', 'true');
	await expect(frames).toHaveCount(2);
	await expect(frames.nth(0)).toHaveText(/^Frame 0( · example\(\))? — \/main\.php:7$/);
	await expect(frames.nth(0)).not.toHaveAttribute('aria-current', 'true');

	await expect(page.locator('.php-debugger-line[data-active=true]')).toHaveText('9');
	await page.getByRole('button', {name: 'Continue', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('completed');
	expect(await page.evaluate(() => dbg.result.stdout)).toBe('42');
	// Program output is visible by default; phpdbg's own notices appear only once the log is
	// switched on.

	const visible = () => page.locator('.php-debugger-console').evaluate(
		element => element.innerText
	);

	expect(await visible()).toContain('42');
	expect(await visible()).not.toContain('Breakpoint #0');
	await page.getByRole('checkbox', {name: 'Debugger log', exact: true}).check();

	expect(await visible()).toContain('Breakpoint #0');
});

test('editing an array starts from an empty expression, a number from its value', async({page}) => {
	await page.goto('/test/harness.html');
	await page.waitForFunction(() => window.PhpDebugger);

	await page.evaluate(() => {
		window.dbg = new PhpDebugger(
			{
				version: window.phpVersionUnderTest
				, runtimeBaseUrl: '/runtime/'
				, code: '<?php\n$list = ["a", "b"];\n$n = 2;\necho implode(",", $list);'
				, breakpoints: [4]
			}
		);

		dbg.mount(document.querySelector('#host'));
	});

	await page.getByRole('button', {name: 'Run', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('paused');
	// An array's preview, such as "array(2)", is valid PHP for a different array, so applying it
	// unchanged would replace the contents.
	await page.getByRole('button', {name: 'Edit list', exact: true}).click();

	await expect(
		page.getByRole('textbox', {name: 'New PHP expression for list', exact: true})
	).toHaveValue('');

	await page.getByRole('button', {name: 'Edit n', exact: true}).click();

	await expect(
		page.getByRole('textbox', {name: 'New PHP expression for n', exact: true})
	).toHaveValue('2');

	await page.getByRole('button', {name: 'Continue', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('completed');

	expect(await page.evaluate(() => dbg.result.stdout)).toBe('a,b');
});

test('bare-element page rules cannot move line numbers or reveal hidden lines', async({page}) => {
	await page.goto('/test/harness.html');
	await page.waitForFunction(() => window.PhpDebugger);

	// A reset, a classless framework, a typography wrapper and rules scoped by an ID.
	await page.addStyleTag(
		{
			content: `
				* { margin: 0; padding: 0; box-sizing: content-box; }
				button, select, input, textarea {
					margin: .25rem; padding: .8rem 1.4rem; min-height: 44px;
					font: inherit; line-height: 2; text-transform: uppercase;
					color: white; background: purple; border: 3px solid purple; border-radius: 999px;
				}
				button { display: flex; width: 100%; }
				span { display: block; }
				pre { padding: 2rem; color: lime; background: black; }
				.prose button { padding: 1rem; }
				.prose pre { padding: 3rem; }
				.prose span { display: block; }
				#host textarea { padding: 2rem; font-size: 20px; line-height: 3; border: 4px solid; }
				#host .php-debugger-gutter { padding: 1rem; font-size: 11px; line-height: 1; }
				#host .php-debugger-gutter button { padding: 12px; font-size: 20px; line-height: 40px; }
			`
		}
	);

	await page.evaluate(() => {
		document.querySelector('#host').classList.add('prose');

		window.dbg = new PhpDebugger(
			{
				version: window.phpVersionUnderTest
				, runtimeBaseUrl: '/runtime/'
				, code: '<?php\n' + Array.from({length: 10}, (_, i) => `$v${i} = ${i};\n`).join('')
					+ 'echo "done";'
				, breakpoints: [11]
			}
		);

		dbg.mount(document.querySelector('#host'));
	});

	// How far each line number sits from the source line it names, in pixels.

	const drift = () => page.evaluate(() => {
		const source = document.querySelector('.php-debugger-source');
		const style = getComputedStyle(source);
		const pitch = parseFloat(style.lineHeight);

		const first = source.getBoundingClientRect().top + parseFloat(style.borderTopWidth)
			+ parseFloat(style.paddingTop) - source.scrollTop;

		return [...document.querySelectorAll('.php-debugger-line')].map(
			(line, index) => Math.abs(line.getBoundingClientRect().top - first - index * pitch)
		);
	});

	const before = await drift();

	expect(before).toHaveLength(12);
	expect(Math.max(...before)).toBeLessThan(.5);

	await page.getByRole('button', {name: 'Run', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('paused');
	await expect(page.locator('.php-debugger-line[data-active=true]')).toHaveText('11');

	expect(Math.max(...await drift())).toBeLessThan(.5);

	// Line 11 is below the fold of a twelve-line file; pausing there scrolls it into view, and
	// its band reaches across the source.
	const paused = await page.evaluate(() => {
		const editor = document.querySelector('.php-debugger-editor').getBoundingClientRect();
		const line = document.querySelector('.php-debugger-line[data-active=true]');
		const number = line.getBoundingClientRect();
		const band = getComputedStyle(line, '::after');
		const source = getComputedStyle(document.querySelector('.php-debugger-source'));

		return {
			inView: number.top >= editor.top && number.bottom <= editor.bottom
			, bandWidth: parseFloat(band.width)
			, editorWidth: editor.width
			, band: band.backgroundColor
			, source: source.backgroundColor
		};
	});

	expect(paused.inView).toBe(true);
	expect(paused.bandWidth).toBeGreaterThan(paused.editorWidth);
	expect(paused.band).toBe('rgb(255, 242, 176)');
	expect(paused.source).toBe('rgba(0, 0, 0, 0)');

	// Rules for bare elements and for elements inside a wrapper stop at the root.
	const run = page.getByRole('button', {name: 'Run', exact: true});
	const output = page.locator('.php-debugger-console');

	await expect(run).toHaveCSS('text-transform', 'none');
	await expect(run).toHaveCSS('border-top-width', '1px');
	await expect(run).toHaveCSS('background-color', 'rgb(255, 255, 255)');
	await expect(output).toHaveCSS('color', 'rgb(32, 39, 52)');
	await expect(output).toHaveCSS('padding-top', '9.6px');

	// The page's "span { display: block }" must not bring phpdbg's notices back.
	const notices = page.locator('.php-debugger-output-notice');

	expect(await notices.count()).toBeGreaterThan(0);

	for(const notice of await notices.all())
	{
		await expect(notice).toBeHidden();
	}

	await page.getByRole('checkbox', {name: 'Debugger log', exact: true}).check();
	await expect(notices.first()).toBeVisible();
	await page.evaluate(() => dbg.destroy());
});

test('the breakpoint dot clears long line numbers; colours follow a dark page', async({page}) => {
	await page.emulateMedia({colorScheme: 'dark'});
	await page.goto('/test/harness.html');
	await page.waitForFunction(() => window.PhpDebugger);

	await page.evaluate(() => {
		window.dbg = new PhpDebugger(
			{
				version: window.phpVersionUnderTest
				, runtimeBaseUrl: '/runtime/'
				, code: '<?php\n' + '// filler\n'.repeat(1198) + 'echo "end";'
				, breakpoints: [8, 1200]
			}
		);

		dbg.mount(document.querySelector('#host'));
	});

	// How far the digits start from the right edge of the dot, in pixels.

	const clearance = text => page.evaluate(
		text => {
			const line = [...document.querySelectorAll('.php-debugger-line')].find(
				element => element.textContent === text
			);

			const digits = document.createRange();
			const dot = getComputedStyle(line, '::before');

			digits.selectNodeContents(line);

			return digits.getBoundingClientRect().left - line.getBoundingClientRect().left
				- parseFloat(dot.left) - parseFloat(dot.width) / 2;
		}
		, text
	);

	expect(await clearance('8')).toBeGreaterThan(1);
	expect(await clearance('1200')).toBeGreaterThan(1);

	// A page that has not declared a colour scheme is a light page, whatever the system prefers.
	const root = page.locator('.php-debugger');
	const breakpoint = page.locator('.php-debugger-line[data-breakpoint=true]').first();

	await expect(root).toHaveCSS('background-color', 'rgb(255, 255, 255)');
	await expect(breakpoint).toHaveCSS('color', 'rgb(181, 33, 50)');

	await page.addStyleTag({content: ':root { color-scheme: light dark; }'});
	await expect(root).toHaveCSS('background-color', 'rgb(21, 27, 35)');
	await expect(root).toHaveCSS('color', 'rgb(230, 237, 243)');
	await expect(breakpoint).toHaveCSS('color', 'rgb(255, 142, 142)');
	await page.evaluate(() => dbg.destroy());
});

test('Evaluate answers beside its box and keeps the exchange in the console', async({page}) => {
	await page.goto('/test/harness.html');
	await page.waitForFunction(() => window.PhpDebugger);

	await page.evaluate(() => {
		window.dbg = new PhpDebugger(
			{
				version: window.phpVersionUnderTest
				, runtimeBaseUrl: '/runtime/'
				, code: '<?php\n$n = 2;\necho $n;'
				, breakpoints: [3]
			}
		);

		dbg.mount(document.querySelector('#host'));
	});

	const expression = page.getByRole('textbox', {name: 'PHP expression', exact: true});
	const problem = page.locator('.php-debugger-expression-error');
	const output = page.locator('.php-debugger-console');
	const evaluate = page.getByRole('button', {name: 'Evaluate', exact: true});

	// Before a pause there is nothing to evaluate in, and the box says so itself.
	await expression.fill('$n');
	await evaluate.click();
	await expect(problem).toContainText('where execution is paused');
	await expect(output).toHaveText('');

	await page.getByRole('button', {name: 'Run', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('paused');

	await expression.fill('$n +');
	await expression.press('Enter');
	await expect(problem).toHaveText('syntax error, unexpected end of expression');
	await expect(expression).toHaveAttribute('aria-invalid', 'true');
	await expect(page.locator('.php-debugger-message')).toHaveText('');

	// The message sits under the box it is about, not at the top of the debugger.

	const gap = await page.evaluate(() => {

		const top = selector => document.querySelector(selector).getBoundingClientRect();

		return top('.php-debugger-expression-error').top - top('.php-debugger-expression').bottom;
	});

	expect(gap).toBeGreaterThanOrEqual(0);
	expect(gap).toBeLessThan(24);

	await expression.fill('$n + 40');
	await expect(problem).toHaveText('');
	await expression.press('Enter');
	await expect(output).toContainText('> $n + 40\n42');

	expect(await output.evaluate(element => element.innerText)).toBe(
		'> $n +\nsyntax error, unexpected end of expression\n> $n + 40\n42\n'
	);

	await page.getByRole('button', {name: 'Continue', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('completed');
	expect(await page.evaluate(() => dbg.result.exitCode)).toBe(0);
	await page.evaluate(() => dbg.destroy());
});

test('a textarea inside the custom element is the editor, and is handed back', async({page}) => {
	await page.goto('/test/harness.html');
	await page.waitForFunction(() => window.PhpDebugger);

	// The README's example.
	await page.evaluate(() => {
		document.querySelector('#host').innerHTML = `<php-debugger runtime-base-url="/runtime/"
			version="${window.phpVersionUnderTest}" breakpoints="[3]">
  <textarea class="mine"><?php
$n = 2;
echo $n;
</textarea>
</php-debugger>`;
	});

	const element = page.locator('php-debugger');
	const source = page.getByRole('textbox', {name: 'PHP source', exact: true});
	const lines = page.locator('.php-debugger-line');

	await expect(element).toHaveCSS('display', 'block');
	await expect(page.locator('.php-debugger-editor > textarea.mine')).toHaveCount(1);
	await expect(lines).toHaveCount(4);
	await expect(lines.nth(2)).toHaveAttribute('data-breakpoint', 'true');

	// Its line numbers set breakpoints, and the paused line is marked on it.
	await lines.nth(2).click();
	await lines.nth(1).click();
	await expect(lines.nth(1)).toHaveAttribute('data-breakpoint', 'true');
	await page.getByRole('button', {name: 'Run', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('paused');
	await expect(page.locator('.php-debugger-line[data-active=true]')).toHaveText('2');
	await expect(source).toHaveJSProperty('readOnly', true);
	await page.getByRole('button', {name: 'Continue', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('completed');

	// It is still the source: an edit is what runs next.
	await lines.nth(1).click();
	await source.fill('<?php\necho "edited";');
	await expect(lines).toHaveCount(2);
	await page.getByRole('button', {name: 'Run', exact: true}).click();
	await expect(page.getByRole('status')).toHaveText('completed');
	expect(await element.evaluate(node => node.result.stdout)).toBe('edited');

	// Removing the debugger gives the page its textarea back as it was.
	const restored = await page.evaluate(async() => {
		const element = document.querySelector('php-debugger');

		await element.debugger.destroy();
		const textarea = element.querySelector(':scope > textarea');

		return {
			className: textarea?.className
			, readOnly: textarea?.readOnly
			, label: textarea?.getAttribute('aria-label')
			, spellcheck: textarea?.getAttribute('spellcheck')
			, value: textarea?.value
		};
	});

	expect(restored).toEqual(
		{
			className: 'mine'
			, readOnly: false
			, label: null
			, spellcheck: null
			, value: '<?php\necho "edited";'
		}
	);

	await expect(page.locator('.php-debugger')).toHaveCount(0);
});

