import {PhpDebugger, AssetRegistry, type RunResult} from 'php-dbg-component';
import {definePhpDebugger} from 'php-dbg-component/element';
import {createAceAdapter} from 'php-dbg-component/adapters/ace';
import {createCodeMirror6Adapter} from 'php-dbg-component/adapters/codemirror6';
const dbg = new PhpDebugger({code: () => '<?php echo 1;', version: '8.4', expect: {stdout: /1/}, assetRegistry: new AssetRegistry()});
const result: RunResult = await dbg.run({mode: 'test', signal: new AbortController().signal});
await dbg.setBreakpoints([3, {file:'/main.php',line:5,enabled:false}]);
const values = await dbg.inspect('variables');
if(values[0].reference) await dbg.setVariable(values[0].reference, '42');
const ElementClass = definePhpDebugger(); const element = new ElementClass(); element.code = '<?php echo 1;';
void [result, element, createAceAdapter, createCodeMirror6Adapter];
// @ts-expect-error unsupported PHP version
new PhpDebugger({version:'7.4'});
// @ts-expect-error execution mode
new PhpDebugger({execution:'node'});
dbg.addEventListener('complete', event => {const result: RunResult = event.detail; void result;});
