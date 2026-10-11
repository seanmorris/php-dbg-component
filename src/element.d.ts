import type {PhpDebugger, DebuggerOptions, RunOptions, RunResult, Breakpoint, PhpVersion} from './index.js';
export interface PhpDebuggerElement extends HTMLElement {
  debugger: PhpDebugger | null; options?: DebuggerOptions; source?: DebuggerOptions['source'];
  code?: DebuggerOptions['code']; expect?: DebuggerOptions['expect'];
  readonly state: PhpDebugger['state']; readonly result: RunResult | null;
  prepare(): Promise<void>; run(options?: RunOptions): Promise<RunResult>; restart(options?: RunOptions): Promise<RunResult>;
  stop(): Promise<RunResult | void>; whenPaused: PhpDebugger['whenPaused']; pause: PhpDebugger['pause'];
  continue: PhpDebugger['continue']; stepInto: PhpDebugger['stepInto']; stepOver: PhpDebugger['stepOver']; stepOut: PhpDebugger['stepOut'];
  until: PhpDebugger['until']; leave: PhpDebugger['leave']; inspect: PhpDebugger['inspect']; inspectChildren: PhpDebugger['children'];
  selectFrame: PhpDebugger['selectFrame']; evaluate: PhpDebugger['evaluate']; setVariable: PhpDebugger['setVariable'];
  setBreakpoints(breakpoints: Array<number | Breakpoint>): Promise<Breakpoint[]>; setVersion(version: PhpVersion): Promise<void>;
}
export function definePhpDebugger(name?: string, registry?: CustomElementRegistry): {new(): PhpDebuggerElement};
