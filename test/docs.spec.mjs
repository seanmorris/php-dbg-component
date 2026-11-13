import {test, expect} from '@playwright/test';
import fs from 'node:fs';

// Where the built site is served: /docs by "npm start", or the path it was built for.
const docs = (process.env.DOCS_BASE_URL || '/docs').replace(/\/+$/, '');

/** Text as a reader sees it, without the line breaks Pandoc wraps it at. */
const words = text => text.replace(/\s+/g, ' ').trim();

// Uncaught errors on the pages of the test that is running; any one fails it.
let errors = [];

test.beforeEach(({page}) => {
	test.skip(
		!fs.existsSync('docs/assets/versions.json')
		, 'Build the docs before running the published-site tests: npm run build:docs'
	);

	errors = [];
	page.on('pageerror', error => errors.push(error.message));
});

test.afterEach(() => {
	expect(errors).toEqual([]);
});

test('the home page demo does what it asks of the reader', async({page}) => {
	await page.goto(docs + '/');
	await page.waitForFunction(() => window.phpDebuggerDemo);

	const status = page.locator('.php-debugger-status');
	const values = page.locator('.php-debugger-values');
	const output = page.locator('.php-debugger-console');

	// "Click Run to pause on line 5. Open item and change price to 10, then click Continue."
	await page.getByRole('button', {name: 'Run', exact: true}).click();
	await expect(status).toHaveText('Paused at line 5 of /main.php, on a breakpoint.');
	await values.getByRole('button', {name: 'item', exact: true}).click();
	await values.getByRole('button', {name: 'Edit price', exact: true}).click();
	await page.keyboard.type('10');
	await page.keyboard.press('Enter');

	await expect(
		values.locator('.php-debugger-value-line').filter({hasText: /^price: /})
	).toContainText('10');

	await page.getByRole('button', {name: 'Continue', exact: true}).click();
	await expect(status).toHaveText('Finished with exit code 0.');
	await expect.poll(() => output.evaluate(element => element.innerText)).toBe('Cart total: 30\n');

	// The page has no status line of its own to go stale beside the debugger's.
	await expect(page.locator('#demo-problem')).toHaveText('');
	await expect(page.locator('#asset-status')).toHaveCount(0);

	await page.getByRole('button', {name: 'Run PHP assertion', exact: true}).click();
	await expect(page.locator('#test-result')).toHaveAttribute('data-status', 'passed');

	// The tab has an icon.
	const icon = await page.locator('link[rel=icon]').evaluate(link => link.href);
	const response = await page.request.get(icon);

	expect(response.ok()).toBe(true);
	expect(response.headers()['content-type']).toContain('image/svg+xml');
});

for(const kind of ['ace', 'codemirror5', 'codemirror6'])
{
	test(
		`${kind} on the home page highlights PHP, follows the theme and marks the pause`
		, async({page}) => {
			await page.goto(docs + '/');
			await page.waitForFunction(() => window.phpDebuggerDemo);
			await page.selectOption('#editor-kind', kind);
			await expect(page.locator('#editor-kind')).toBeEnabled();

			const host = page.locator('#debugger-host .php-debugger-hosted-editor');

			// What each editor calls its frame and a highlighted keyword.
			const [frame, keyword] = {
				ace: ['.ace_editor', '.ace_keyword']
				, codemirror5: ['.CodeMirror', '.cm-keyword']
				, codemirror6: ['.cm-editor', '.cm-line span[class]']
			}[kind];

			await expect(host.locator(keyword).first()).toBeVisible();

			// How light the ground behind the code is, from 0 to 1. An editor with no background of
			// its own shows the page's.

			const lightness = () => host.locator(frame).evaluate(element => {
				let colour = [0, 0, 0, 0];

				for(let node = element; node && !colour[3]; node = node.parentElement)
				{
					const parts = getComputedStyle(node).backgroundColor.match(/[\d.]+/g).map(
						Number
					);

					colour = [...parts.slice(0, 3), parts[3] ?? 1];
				}

				return (colour[0] + colour[1] + colour[2]) / 765;
			});

			expect(await lightness()).toBeGreaterThan(.8);
			await page.getByRole('button', {name: 'Switch to dark theme', exact: true}).click();
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
			await expect.poll(lightness).toBeLessThan(.3);

			await page.getByRole('button', {name: 'Run', exact: true}).click();
			await expect(page.locator('.php-debugger-status')).toContainText('Paused at line 5');

			// The paused line's marker is on line 5, and the line numbers are a column, not a page:
			// CodeMirror 5 created before its stylesheet measures a gutter a thousand pixels wide.
			const marks = await host.evaluate(async element => {
				await new Promise(
					resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))
				);

				const lines = [...element.querySelectorAll(
					'.ace_line, .CodeMirror-line, .cm-line'
				)];

				const line = lines.find(
					node => node.textContent.includes('$sum +=')
				).getBoundingClientRect();

				const paused = element.querySelector(
					'.php-debugger-active-line'
				).getBoundingClientRect();

				return {
					offset: Math.abs(paused.top - line.top)
					, indent: line.left - element.getBoundingClientRect().left
				};
			});

			expect(marks.offset).toBeLessThan(2);
			expect(marks.indent).toBeLessThan(120);

			const result = await page.evaluate(async() => {
				const dbg = window.phpDebuggerDemo;
				const done = dbg.whenPaused().catch(() => {});

				await dbg.setBreakpoints([]);
				await dbg.continue();
				await done;

				return dbg.result;
			});

			expect(result.stdout).toBe('Cart total: 24\n');
		}
	);
}

test(
	'guide and reference pages link up, highlight their code and run their examples'
	, async({page}) => {
		await page.goto(docs + '/');

		await page.getByRole('navigation', {name: 'Site'}).getByRole(
			'link'
			, {name: 'Guide', exact: true}
		).click();

		await expect(page.getByRole('heading', {level: 1})).toHaveText('Guide');

		const contents = page.getByRole('navigation', {name: 'Contents'});

		await contents.getByRole('link', {name: 'Get started', exact: true}).click();
		await expect(page.getByRole('heading', {level: 1})).toHaveText('Get started');
		await expect(contents.locator('[aria-current]')).toHaveText('Get started');
		expect(await page.locator('pre > code.sourceCode').count()).toBeGreaterThan(2);

		await contents.getByRole('link', {name: 'Custom element', exact: true}).click();
		await expect(page.locator('pre').first()).toContainText('<php-debugger runtime-base-url');

		await contents.getByRole('link', {name: 'Run PHP tests', exact: true}).click();
		await page.getByRole('button', {name: 'Run PHP assertion', exact: true}).click();
		await expect(page.locator('#test-result')).toHaveAttribute('data-status', 'passed');

		await contents.getByRole(
			'link'
			, {name: 'PHP versions and extensions', exact: true}
		).click();

		await page.getByRole('button', {name: 'Check curl extension', exact: true}).click();
		await expect(page.locator('#curl-result')).toHaveAttribute('data-status', 'passed');

		// Every page fits a phone without scrolling sideways.
		await page.setViewportSize({width: 390, height: 800});

		for(
			const path of [
				'/'
				, '/guide/getting-started.html'
				, '/reference/api.html'
				, '/reference/styling.html'
			]
		){
			await page.goto(docs + path);

			expect(
				await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
			).toBeLessThanOrEqual(0);
		}
	}
);

test(
	'every article is listed in llms.txt and describes itself as its heading does'
	, async({page}) => {
		const index = await page.request.get(docs + '/llms.txt');

		expect(index.ok()).toBe(true);
		expect(index.headers()['content-type']).toContain('text/plain');

		// Each entry is "- [title](link): description".
		const listed = {};

		for(const [, title, link, description] of (await index.text()).matchAll(
			/^- \[(.+)\]\((.+)\): (.+)$/gm
		)){
			listed[new URL(link, index.url()).href] = {title, description};
		}

		const sitemap = await (await page.request.get(docs + '/sitemap.xml')).text();

		const pages = [...sitemap.matchAll(/<loc>(.+?)<\/loc>/g)].map(
			match => new URL(match[1], index.url()).href
		);

		// What the pages say about themselves, and the site and component the home page defines.
		const articles = {};
		const references = new Set();
		let defined = [];

		for(const url of pages)
		{
			await page.goto(url);

			const data = JSON.parse(
				await page.locator('script[type="application/ld+json"]').textContent()
			);

			const discovery = await page.locator('link[rel=describedby]').evaluate(
				link => link.href
			);

			expect(data['@context']).toBe('https://schema.org');
			expect(discovery).toBe(index.url());

			if(data['@graph'])
			{
				const software = data['@graph'].find(
					entity => entity['@type'] === 'SoftwareSourceCode'
				);

				const lede = await page.locator('.hero p').first().textContent();

				expect(software.description).toBe(words(lede));
				defined = data['@graph'].map(entity => entity['@id']);

				continue;
			}

			const heading = words(await page.getByRole('heading', {level: 1}).textContent());
			const summary = await page.locator('meta[name=description]').getAttribute('content');

			expect(data.headline ?? data.name).toBe(heading);
			expect(data.description).toBe(words(summary));

			for(const entity of [data.isPartOf, data.about].filter(Boolean))
			{
				references.add(entity['@id']);
			}

			if(['TechArticle', 'APIReference'].includes(data['@type']))
			{
				articles[url] = {title: heading, description: data.description};
			}
		}

		expect(listed).toEqual(articles);
		expect(Object.keys(articles).length).toBeGreaterThan(9);
		expect(defined).toEqual(expect.arrayContaining([...references]));
	}
);
