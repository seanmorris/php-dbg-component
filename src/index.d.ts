export type PhpVersion = '8.0' | '8.1' | '8.2' | '8.3' | '8.4' | '8.5';
export const versions: readonly PhpVersion[];
export type DebuggerState = 'idle' | 'loading' | 'ready' | 'running' | 'paused' | 'completed' | 'stopped' | 'error' | 'destroyed';
export type InspectionScope = 'variables' | 'globals' | 'constants' | 'functions' | 'classes' | 'files' | 'frames';
export interface Breakpoint { line: number; file?: string; enabled?: boolean; id?: string }
export interface Location { file: string; line: number; frame?: number; pauseId?: number }
export interface Pause { location: Location; reason?: 'breakpoint' | 'step' | 'exception' | 'pause' }
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
export interface PreloadFile { url: string | URL; parent: string; name: string; path?: string }
export interface PackagePreloadFile { url: string | URL; path: string; name?: string }
export interface SharedLibrary { name?: string; url: string | URL; ini?: boolean }
export interface ExtensionContext { phpVersion: PhpVersion; phpArgs: Record<string, unknown> }
export interface ExtensionPackage {
  getLibs(runtime: ExtensionContext): Array<string | URL | SharedLibrary>;
  getFiles?(runtime: ExtensionContext): PackagePreloadFile[];
}
export type LibraryDefinition = string | URL | SharedLibrary | ExtensionPackage;
export type LibraryList = Array<LibraryDefinition | LibraryDefinition[]>;
export interface RuntimeArgs extends Record<string, unknown> {
  sharedLibs?: LibraryList; dynamicLibs?: LibraryList; files?: PreloadFile[];
}
export interface DebuggerOptions extends Omit<RunOptions, 'signal'> {
  version?: PhpVersion; versions?: readonly PhpVersion[]; execution?: 'worker' | 'main'; entrypoint?: string;
  code?: string | (() => string | Promise<string>); source?: Element | EditorAdapter | (() => string | Promise<string>);
  breakpoints?: Array<number | Breakpoint>; runtimeBaseUrl?: string | URL; workerUrl?: string | URL;
  extensions?: Array<string | {module: string | URL}>; extensionUrls?: Record<string, string | URL>;
  sharedLibs?: LibraryList; dynamicLibs?: LibraryList;
  libraryUrls?: Record<string, string | URL>;
  assetRegistry?: AssetRegistry; runtimeArgs?: RuntimeArgs; loadTimeoutMs?: number; outputLimit?: number;
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
export interface DebuggerEvents {
  statechange: {state: DebuggerState; previous: DebuggerState}; output: {channel: 'stdout' | 'stderr' | 'debug'; text: string};
  pause: Pause; complete: RunResult; testresult: TestResult; diagnostic: Diagnostic; locationchange: Location | null;
  framechange: {frame: number}; variablechange: {reference: string; value: Variable};
  breakpointchange: {breakpoints: Breakpoint[]}; versionchange: {version: PhpVersion}; sourcechange: {code?: string; pending: boolean};
}
export class PhpDebugger extends EventTarget {
  constructor(options?: DebuggerOptions);
  readonly state: DebuggerState; readonly testStatus: TestResult['status']; readonly result: RunResult | null;
  readonly location: Location | null; readonly breakpoints: Breakpoint[]; readonly options: DebuggerOptions;
  readonly capabilities: {hardStop: boolean; pause: boolean; variableEditing: boolean};
  readCode(): Promise<string>; setCode(code: NonNullable<DebuggerOptions['code']>): void;
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
  addEventListener<K extends keyof DebuggerEvents>(type: K, listener: (event: CustomEvent<DebuggerEvents[K]>) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof DebuggerEvents>(type: K, listener: (event: CustomEvent<DebuggerEvents[K]>) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
}
