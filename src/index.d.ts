export type PhpVersion = '8.0' | '8.1' | '8.2' | '8.3' | '8.4' | '8.5';
export const versions: readonly PhpVersion[];
export type DebuggerState = 'idle' | 'loading' | 'ready' | 'running' | 'paused' | 'completed' | 'stopped' | 'error' | 'destroyed';
export type InspectionScope = 'variables' | 'globals' | 'constants' | 'functions' | 'classes' | 'files' | 'frames';
export interface Breakpoint { line: number; file?: string; enabled?: boolean; id?: string }
export interface Location { file: string; line: number; frame?: number; pauseId?: number }
export interface Pause { location: Location; reason?: 'breakpoint' | 'step' | 'exception' }
export interface Variable {
  name: string; type: string; displayValue: string; value?: string | number | boolean | bigint | null;
  reference?: string; writable: boolean; expandable: boolean; circular?: boolean;
}
export interface Diagnostic { name?: string; message: string; file?: string; line?: number; phase?: string }
export interface TestResult { status: 'unchecked' | 'passed' | 'failed'; failures: Array<{field?: string; expected?: unknown; actual?: unknown; message?: string}> }
export interface RunResult {
  runId: number; version: PhpVersion; status: 'completed' | 'cancelled' | 'timed-out' | 'error';
  exitCode: number | null; stdout: string; stderr: string; diagnostics: Diagnostic[]; durationMs: number; test: TestResult;
}
export interface Expectations { stdout?: string | RegExp; stderr?: string | RegExp; exitCode?: number; error?: string | RegExp }
export interface RunOptions {
  mode?: 'debug' | 'test'; timeoutMs?: number; stdin?: string; signal?: AbortSignal;
  files?: Record<string, string | Uint8Array>; expect?: Expectations;
  assert?: (result: Omit<RunResult, 'test'>) => boolean | void | Promise<boolean | void>;
}
export interface EditorAdapter {
  getCode(): string | Promise<string>; setCode?(code: string): void;
  setReadOnly?(readOnly: boolean): void; setBreakpoints?(breakpoints: Breakpoint[]): void;
  showLocation?(location: Location | null): void;
  onBreakpointChange?(listener: (breakpoints: Array<number | Breakpoint>) => void): () => void;
  dispose?(): void;
}
export interface DebuggerOptions extends Omit<RunOptions, 'signal'> {
  version?: PhpVersion; versions?: readonly PhpVersion[]; execution?: 'worker' | 'main'; entrypoint?: string;
  code?: string | (() => string | Promise<string>); source?: Element | EditorAdapter | (() => string | Promise<string>);
  breakpoints?: Array<number | Breakpoint>; runtimeBaseUrl?: string | URL; workerUrl?: string | URL;
  extensions?: Array<string | {module: string | URL}>; extensionUrls?: Record<string, string | URL>;
  libraryUrls?: Record<string, string | URL>;
  assetRegistry?: AssetRegistry; runtimeArgs?: Record<string, unknown>; loadTimeoutMs?: number; outputLimit?: number;
}
export class AssetRegistry {
  constructor(options?: {fetch?: typeof fetch});
  bytes(url: string | URL): Promise<ArrayBuffer>;
  json(url: string | URL): Promise<any>;
  module(url: string | URL, sha256?: string): Promise<WebAssembly.Module>;
  objectUrl(url: string | URL): Promise<string>;
  clear(): Promise<void>;
}
export function sharedAssets(): AssetRegistry;
export interface DebuggerView { root: HTMLElement; destroy(): void }
export class PhpDebugger extends EventTarget {
  constructor(options?: DebuggerOptions);
  readonly state: DebuggerState; readonly testStatus: TestResult['status']; readonly result: RunResult | null;
  readonly location: Location | null; readonly breakpoints: Breakpoint[]; readonly options: DebuggerOptions;
  readonly capabilities: {hardStop: boolean; pause: boolean; variableEditing: boolean};
  readCode(): Promise<string>; setCode(code: DebuggerOptions['code']): void;
  setBreakpoints(breakpoints: Array<number | Breakpoint>): Promise<Breakpoint[]>;
  setVersion(version: PhpVersion): Promise<void>; prepare(): Promise<void>;
  run(options?: RunOptions): Promise<RunResult>; restart(options?: RunOptions): Promise<RunResult>;
  stop(): Promise<RunResult | void>; destroy(): Promise<void>;
  whenPaused(): Promise<Pause>; pause(): Promise<Pause>;
  continue(): Promise<Location | void>; stepInto(): Promise<Location | void>; stepOver(): Promise<Location | void>;
  stepOut(): Promise<Location | void>; until(): Promise<Location | void>; leave(): Promise<Location | void>;
  inspect(scope?: 'variables' | 'globals' | 'constants', options?: {frame?: number}): Promise<Variable[]>;
  inspect(scope: 'functions' | 'classes' | 'files' | 'frames', options?: {frame?: number}): Promise<any>;
  children(reference: string, options?: {offset?: number; limit?: number}): Promise<{values: Variable[]; total: number; offset: number}>;
  evaluate(expression: string, options?: {frame?: number}): Promise<Variable>;
  setVariable(reference: string, expression: string): Promise<Variable>; selectFrame(frame: number): Promise<{frame: number}>;
  mount(host: Element): DebuggerView;
}
