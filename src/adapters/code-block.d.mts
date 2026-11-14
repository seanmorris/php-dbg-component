import type {EditorAdapter} from '../index.js';

/**
 * Pass a code block already on the page: highlight.js output, Pandoc's (as SMGen builds it), or a
 * plain <pre><code>. `highlight` colours the block again after setCode().
 */
export function createCodeBlockAdapter(
	block: Element,
	options?: {file?: string; highlight?: (code: HTMLElement) => void}
): EditorAdapter & {
	element: HTMLElement;
	layout(): void;
	setCode(code: string): void;
	dispose(): void;
};
