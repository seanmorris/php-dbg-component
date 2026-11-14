// Build the documentation site into docs/.
//
// The pages load the component, the editors and the PHP runtimes from assets/. Those are staged
// into the SMGen project's static directory, which SMGen copies into its output; SMGen replaces
// the whole output directory on every build, so nothing can be staged there directly.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {stageRuntime} from './runtime-assets.mjs';
import {smgenCommand} from './setup-smgen.mjs';

const root = path.resolve(import.meta.dirname, '..');
const site = path.join(root, 'site');
const staged = path.join(site, 'static/assets');
const output = path.join(root, 'docs');
const modules = path.join(root, 'node_modules');

if(process.env.RUNTIME_BUNDLE && path.resolve(process.env.RUNTIME_BUNDLE) === staged)
{
	throw Error('Keep RUNTIME_BUNDLE outside the generated site/static/assets directory');
}

await fs.rm(staged, {recursive: true, force: true});
await fs.mkdir(staged, {recursive: true});

await fs.cp(
	path.join(root, 'src')
	, path.join(staged, 'component')
	, {recursive: true, filter: filename => !filename.endsWith('.ts') && !filename.endsWith('.mts')}
);

if(process.env.RUNTIME_BUNDLE)
{
	await fs.cp(path.resolve(process.env.RUNTIME_BUNDLE), staged, {recursive: true});
}
else
{
	const versions = (process.env.DOCS_PHP_VERSIONS || '8.4').split(',');

	await stageRuntime(process.env.PHP_WASM_ROOT || '/app', staged, versions);
}

// The editors the home page offers, each with PHP highlighting and a dark theme.
const editors = path.join(staged, 'editors');

await fs.mkdir(editors, {recursive: true});

const copies = [
	['ace-builds/src-noconflict/ace.js', 'ace.js']
	, ['ace-builds/src-noconflict/mode-php.js', 'mode-php.js']
	, ['ace-builds/src-noconflict/theme-tomorrow_night.js', 'theme-tomorrow_night.js']
	, ['ace-builds/LICENSE', 'LICENSE-ace']

	, ['codemirror/lib/codemirror.css', 'codemirror5.css']
	, ['codemirror/theme/material-darker.css', 'codemirror5-dark.css']
	, ['codemirror/LICENSE', 'LICENSE-codemirror5']

	, ['@codemirror/view/LICENSE', 'LICENSE-codemirror6-view']
	, ['@codemirror/state/LICENSE', 'LICENSE-codemirror6-state']
	, ['@codemirror/language/LICENSE', 'LICENSE-codemirror6-language']
	, ['@codemirror/lang-php/LICENSE', 'LICENSE-codemirror6-lang-php']
	, ['@codemirror/theme-one-dark/LICENSE', 'LICENSE-codemirror6-theme-one-dark']
];

for(const [source, name] of copies)
{
	await fs.copyFile(path.join(modules, source), path.join(editors, name));
}

// CodeMirror 5 with its PHP mode and the modes that one builds on, as the global it expects.
const codemirror5 = "import CodeMirror from 'codemirror'; import 'codemirror/mode/php/php.js';"
	+ ' globalThis.CodeMirror = CodeMirror;';

await build(
	{
		stdin: {contents: codemirror5, resolveDir: root}
		, bundle: true
		, format: 'iife'
		, minify: true
		, outfile: path.join(editors, 'codemirror5.js')
	}
);

// CodeMirror 6 and the adapter in one module, so they share one copy of the editor's state.
const codemirror6 = `
	import {syntaxHighlighting, defaultHighlightStyle} from '@codemirror/language';
	export {EditorState, Compartment} from '@codemirror/state';
	export {EditorView, lineNumbers} from '@codemirror/view';
	export {php} from '@codemirror/lang-php';
	export {oneDark as dark} from '@codemirror/theme-one-dark';
	export {createCodeMirror6Adapter} from './src/adapters/codemirror6.mjs';
	export const light = syntaxHighlighting(defaultHighlightStyle);
`;

await build(
	{
		stdin: {contents: codemirror6, resolveDir: root}
		, bundle: true
		, format: 'esm'
		, minify: true
		, outfile: path.join(editors, 'codemirror6.mjs')
	}
);

// Every link SMGen writes starts with this path. /docs suits "npm start", which serves the
// repository; a site published at its own path passes that path instead.
const base = process.env.DOCS_BASE_URL ?? '/docs';
const smgen = process.env.SMGEN || await smgenCommand();

execFileSync(
	smgen
	, ['build']
	, {cwd: site, stdio: 'inherit', env: {...process.env, BASE_URL: base, OUTPUT_DIR: output}}
);

await fs.writeFile(path.join(output, '.nojekyll'), '');
console.log(`Built docs/ for ${base || '/'} with the component, editors and selected runtimes.`);
