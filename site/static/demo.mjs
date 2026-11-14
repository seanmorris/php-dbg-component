// The live examples on the documentation pages. Everything is found relative to this file, so
// the site works under any base path.
import {PhpDebugger} from './assets/component/index.mjs';

const $ = selector => document.querySelector(selector);

const asset = path => new URL('./assets/' + path, import.meta.url).href;
const runtimeBaseUrl = asset('runtime/');

// Three items, a running total, and a discount once the subtotal reaches 50: enough to step
// through, to watch a value grow, and to change one on the way.
const code = `<?php
function discount(int $subtotal): int {
    return $subtotal >= 50 ? intdiv($subtotal, 10) : 0;
}
function total(array $cart): int {
    $sum = 0;
    foreach ($cart as $item) {
        $line = $item['price'] * $item['quantity'];
        echo "{$item['name']}: {$item['quantity']} x {$item['price']} = $line\\n";
        $sum += $line;
    }
    $off = discount($sum);
    echo "Discount: $off\\n";
    return $sum - $off;
}
$cart = [
    ['name' => 'Notebook', 'price' => 8, 'quantity' => 3],
    ['name' => 'Pen', 'price' => 2, 'quantity' => 5],
    ['name' => 'Backpack', 'price' => 30, 'quantity' => 1],
];
echo "Total: " . total($cart) . "\\n";`;

// The debugger reports its own state. This line is only for what goes wrong around it.

const problem = message => {
	const output = $('#demo-problem');

	if(output)
	{
		output.textContent = message;
	}
};

const versions = await fetch(asset('versions.json')).then(
	response => {
		if(!response.ok)
		{
			throw Error('The runtime files are not here yet. Run "npm run build:docs".');
		}

		return response.json();
	}
).catch(
	error => {
		problem(error.message);

		return [];
	}
);

const dark = () => document.documentElement.dataset.theme === 'dark';
const loaded = new Map();

/** Load a script or stylesheet once, and resolve when the browser has applied it. */
function load(tag, attributes)
{
	const key = attributes.src || attributes.href;

	if(!loaded.has(key))
	{
		loaded.set(key, new Promise((resolve, reject) => {
			const element = Object.assign(document.createElement(tag), attributes);

			element.onload = resolve;

			element.onerror = () => reject(Error(`Could not load ${key}`));
			document.head.append(element);
		}));
	}

	return loaded.get(key);
}

// Each editor: how to make one holding the code, and how to give it the page's colours.
const editors = {

	async ace(host, value) {
		await load('script', {src: asset('editors/ace.js')});

		ace.config.set('basePath', asset('editors/'));

		const editor = ace.edit(document.createElement('div'));

		host.append(editor.container);
		editor.setValue(value, -1);
		editor.setOptions({fontSize: 14, showPrintMargin: false, useWorker: false});
		editor.session.setMode('ace/mode/php');

		const {createAceAdapter} = await import(asset('component/adapters/ace.mjs'));

		return {
			adapter: createAceAdapter(editor)
			, recolour: () => editor.setTheme(
				dark() ? 'ace/theme/tomorrow_night' : 'ace/theme/textmate'
			)
			, destroy: () => editor.destroy()
		};
	}

	, async codemirror5(host, value) {
		// The stylesheet first: CodeMirror measures its gutters when it is created, and without
		// its styles it measures them a page wide.
		await Promise.all([
			load('script', {src: asset('editors/codemirror5.js')})
			, load('link', {rel: 'stylesheet', href: asset('editors/codemirror5.css')})
			, load('link', {rel: 'stylesheet', href: asset('editors/codemirror5-dark.css')})
		]);

		const editor = CodeMirror(
			host
			, {value, lineNumbers: true, mode: 'application/x-httpd-php'}
		);

		const {createCodeMirror5Adapter} = await import(
			asset('component/adapters/codemirror5.mjs')
		);

		return {
			adapter: createCodeMirror5Adapter(editor)
			, recolour: () => editor.setOption('theme', dark() ? 'material-darker' : 'default')
			, destroy: () => {}
		};
	}

	, async codemirror6(host, value) {
		const cm = await import(asset('editors/codemirror6.mjs'));
		const colours = new cm.Compartment();

		const state = cm.EditorState.create(
			{doc: value, extensions: [cm.lineNumbers(), cm.php(), colours.of(cm.light)]}
		);

		const editor = new cm.EditorView({state, parent: host});

		return {
			adapter: cm.createCodeMirror6Adapter(editor)
			, recolour: () => editor.dispatch(
				{effects: colours.reconfigure(dark() ? cm.dark : cm.light)}
			)
			, destroy: () => editor.destroy()
		};
	}
};

let dbg;
let editor;

/** Build the example debugger for the chosen editor, keeping the code unless it is a reset. */
async function mount(reset = false)
{
	const value = reset ? code : await dbg?.readCode() || code;
	const version = dbg?.options.version || (versions.includes('8.4') ? '8.4' : versions[0]);
	const kind = $('#editor-kind').value;

	await dbg?.destroy();
	editor?.adapter.dispose();
	editor?.destroy();
	editor = null;
	$('#debugger-host').replaceChildren();

	if(editors[kind])
	{
		// Made inside the mount point, the editor moves into the debugger, where the textarea is.
		editor = await editors[kind]($('#debugger-host'), value);
		editor.recolour();
	}

	dbg = new PhpDebugger(
		{runtimeBaseUrl, version, versions, code: value, source: editor?.adapter, breakpoints: [8]}
	);

	dbg.mount($('#debugger-host'));
	window.phpDebuggerDemo = dbg;
}

/** Lock or release the controls that rebuild the example. */
function lock(locked)
{
	for(const control of [$('#editor-kind'), $('#reset')])
	{
		control.disabled = locked;
	}
}

async function change(reset = false)
{
	problem('');
	lock(true);

	// mount() is async, so whatever it throws arrives as a rejection.
	await mount(reset).catch(error => problem(error.message));

	lock(false);
}

/** Run PHP without an interface and report the outcome beside the button that asked. */
async function runExample(button, output, options)
{
	button.disabled = true;
	output.textContent = 'Running…';

	let test;

	try
	{
		test = new PhpDebugger(
			{
				runtimeBaseUrl
				, version: dbg?.options.version || (versions.includes('8.4') ? '8.4' : versions[0])
				, ...(typeof options === 'function' ? await options() : options)
			}
		);

		const result = await test.run({mode: 'test', timeoutMs: 5000});
		const said = result.stdout.trim() || result.diagnostics.map(d => d.message).join(' ');
		const time = Math.round(result.durationMs);

		output.dataset.status = result.test.status;
		output.textContent = `${result.test.status} · ${said} · ${time} ms`;
	}
	catch(error)
	{
		output.dataset.status = 'failed';
		output.textContent = error.message;
	}

	// Nothing above escapes its catch, so this runs however the example went.
	await test?.destroy();
	button.disabled = false;
}

$('#run-test')?.addEventListener(
	'click'
	, event => void runExample(
		event.currentTarget
		, $('#test-result')
		, {code: '<?php echo 6 * 7, "\\n";', expect: {stdout: '42\n', exitCode: 0}}
	)
);

/** What the curl example runs with. The extension is fetched when the button is used. */
const curlExample = async() => ({
	sharedLibs: [await import(asset('php-wasm-curl/index.mjs'))]
	, code: '<?php echo extension_loaded("curl") ? "curl ready" : "curl missing";'
	, expect: {stdout: 'curl ready', exitCode: 0}
});

$('#run-curl')?.addEventListener(
	'click'
	, event => void runExample(event.currentTarget, $('#curl-result'), curlExample)
);

if($('#debugger-host') && versions.length)
{
	$('#editor-kind').addEventListener('change', () => void change());
	$('#reset').addEventListener('click', () => void change(true));

	// The header's theme switch changes data-theme on the root; the editor follows.
	new MutationObserver(() => editor?.recolour()).observe(
		document.documentElement
		, {attributes: true, attributeFilter: ['data-theme']}
	);

	await change(true);
}
