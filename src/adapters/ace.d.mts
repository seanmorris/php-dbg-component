import type {EditorAdapter} from '../index.js';
/** Pass an existing Ace Editor instance. Ace remains owned by the host. */
export function createAceAdapter(editor: any, options?: {file?: string}): EditorAdapter & {dispose(): void};
