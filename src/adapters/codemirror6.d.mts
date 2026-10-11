import type {EditorAdapter} from '../index.js';
import type {EditorView} from '@codemirror/view';
export function createCodeMirror6Adapter(editor: EditorView, options?: {file?: string}): EditorAdapter & {dispose(): void};
