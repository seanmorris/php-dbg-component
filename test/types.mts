import {PhpDebugger, AssetRegistry, type RunResult} from 'php-dbg-component';
import {definePhpDebugger} from 'php-dbg-component/element';
import {createAceAdapter} from 'php-dbg-component/adapters/ace';
import {createCodeMirror6Adapter} from 'php-dbg-component/adapters/codemirror6';

const dbg = new PhpDebugger(
	{
		code: () => '<?php echo 1;'
		, version: '8.4'
		, expect: {stdout: /1/}
		, assetRegistry: new AssetRegistry()
	}
);

const result: RunResult = await dbg.run({mode: 'test', signal: new AbortController().signal});

// A breakpoint may check a condition or log a value; a test run lists what was logged.
await dbg.setBreakpoints([{line: 4, condition: '$i > 2'}, {line: 5, log: '$sum'}]);
const logged: string[] = result.logs.map(entry => entry.message);
void [logged, dbg.run({mode: 'test', expect: {logs: ['1', /3/]}})];
// @ts-expect-error a log is PHP, as a string
void dbg.setBreakpoints([{line: 4, log: 3}]);
await dbg.setBreakpoints([3, {file: '/main.php',line: 5,enabled: false}]);
const values = await dbg.inspect('variables');

if(values[0].reference) await dbg.setVariable(values[0].reference, '42');

// The selected frame's function, the script, a function or a class; each op has its opcode.
const listing = await dbg.opcodes();
const ops: string[] = listing.functions.flatMap(listed => listed.ops.map(op => op.opcode));

const script = await dbg.opcodes({script: true});

void [ops, listing.current?.index, script, await dbg.opcodes({class: 'C'})];

// @ts-expect-error a target names one thing
void dbg.opcodes({function: 'f', class: 'C'});

const ElementClass = definePhpDebugger(); const element = new ElementClass(); element.code
	= '<?php echo 1;';

void [result, element, createAceAdapter, createCodeMirror6Adapter];

// An adapter names its editor's element, which mount() moves into the interface from inside
// the mount point.
const aceAdapter = createAceAdapter(null);
const hostedEditor: HTMLElement = aceAdapter.element;
aceAdapter.layout();
void hostedEditor;
// @ts-expect-error unsupported PHP version
new PhpDebugger({version: '7.4'});
// @ts-expect-error execution mode
new PhpDebugger({execution: 'node'});
dbg.addEventListener('complete', event => {const result: RunResult = event.detail; void result;});

new PhpDebugger(
	{
		// A library as a URL, as its text, and as a definition.
		sharedLibs: [
			new URL('https://example.test/curl.so')
			, 'https://example.test/curl.so'
			, [{url: 'https://example.test/curl.so', ini: true}]

			// A package module, which names its library for the PHP version that loads it.
			, {
				getLibs: php => [
					{url: `https://example.test/php${php.phpVersion}-curl.so`, ini: true}
				]
				, getFiles: () => [{url: 'https://example.test/data', path: '/preload/data'}]
			}
		]

		, dynamicLibs: [{getLibs: () => []}]
		, runtimeArgs: {
			files: [{url: 'https://example.test/data', parent: '/preload/', name: 'data'}]
		}
	}
);
