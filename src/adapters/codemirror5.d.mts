import type {EditorAdapter} from '../index.js';

/** Pass an existing CodeMirror 5 Editor instance. */
export function createCodeMirror5Adapter(editor: any, options?: {file?: string}):
	EditorAdapter & {element: HTMLElement; layout(): void; dispose(): void};
