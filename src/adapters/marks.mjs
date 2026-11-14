/**
 * How an editor's gutter shows a breakpoint, as the debugger's own gutter does: a dot for one that
 * pauses and a diamond for a logpoint, either of them hollow when it has a condition. Answers the
 * classes for the mark, the character that draws it where a character does, and what it does in
 * words, for a tooltip.
 */
export function breakpointMark(bp)
{
	const log = !!bp?.log;
	const condition = !!bp?.condition;

	const classes = [
		'php-debugger-breakpoint-marker'
		, log && 'php-debugger-breakpoint-log'
		, condition && 'php-debugger-breakpoint-condition'
	];

	const does = [log && `logs ${bp.log}`, condition && `when ${bp.condition}`];

	return {
		className: classes.filter(Boolean).join(' ')
		, glyph: log ? condition ? '◇' : '◆' : condition ? '○' : '●'
		, title: does.filter(Boolean).join(' ')
	};
}
