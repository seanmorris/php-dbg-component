export const versions = Object.freeze(['8.0', '8.1', '8.2', '8.3', '8.4', '8.5']);

export function normalizePath(path)
{
	if(typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x20\x7f:'"\\]/.test(path)
		|| path.split('/').some(p => p === '..' || p === '.') || path.startsWith('/.php-debugger')
	){
		throw new TypeError(
			'Source paths must be absolute, without whitespace, command delimiters, or relative segments'
		);
	}

	return path.replace(/\/+/g, '/');
}

export function normalizeBreakpoints(input = [], entrypoint = '/main.php')
{
	const found = new Map();

	for(const value of input)
	{
		const bp = typeof value === 'number' ? {line: value} : value;

		if(!bp || !Number.isInteger(bp.line) || bp.line < 1)
		{
			throw new TypeError('Breakpoint lines are positive, one-based integers');
		}

		const file = normalizePath(bp.file || entrypoint);
		const id = `${file}:${bp.line}`;
		const breakpoint = {id, file, line: bp.line, enabled: bp.enabled !== false};

		// A condition or a log the breakpoint does not have is left out, not empty.
		const condition = breakpointExpression(bp.condition);
		const log = breakpointExpression(bp.log);

		found.set(id, {...breakpoint, ...condition && {condition}, ...log && {log}});
	}

	return [...found.values()];
}

/** A breakpoint's condition or log expression: PHP as a string, or nothing when it is blank. */
function breakpointExpression(value)
{
	if(value === undefined || value === null)
	{
		return '';
	}

	if(typeof value !== 'string')
	{
		throw new TypeError('A breakpoint condition or log is a PHP expression, as a string');
	}

	return value.trim();
}

export function deferred()
{
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {resolve = yes; reject = no;});

	// Consumers may attach after an event has already rejected a wait.
	promise.catch(() => {});

	return {promise, resolve, reject};
}

export function errorRecord(error)
{
	return {name: error?.name || 'Error', message: error?.message || String(error)};
}

export function phpString(value)
{
	return "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
}

/**
 * Splits an object's property key, as PHP stores it, into the name and its
 * visibility. A private property is stored as a NUL byte, the declaring class,
 * a NUL byte, then the name; a protected one has "*" for the class.
 *
 * Only a key that starts with a NUL byte is mangled: PHP refuses a property
 * name that starts with one, but a public, dynamic name may hold NUL bytes
 * after its first character. In a mangled key the name is what follows the
 * last NUL byte. A private or protected property is always a declared one, so
 * its name is an identifier, while the class in front of it may be an
 * anonymous class, whose own name contains a NUL byte.
 */
export function phpPropertyName(key)
{
	const end = key.startsWith('\0') ? key.lastIndexOf('\0') : 0;

	if(end < 1)
	{
		return {name: key, visibility: 'public'};
	}

	return {
		name: key.slice(end + 1)
		, visibility: key.slice(1, end) === '*' ? 'protected' : 'private'
	};
}

/**
 * A class name as people read it. PHP names an anonymous class
 * "class@anonymous", a NUL byte, then the file and line that declare it;
 * the declaring file's name and line are kept so two such classes differ.
 */
export function phpClassLabel(name)
{
	const [shown, declared] = String(name).split('\0');

	if(!declared)
	{
		return shown;
	}

	return `${shown} (${declared.replace(/\$[0-9a-f]+$/, '').split('/').pop()})`;
}

/**
 * Word a failed evaluation for the person who typed the expression. `line` is the line PHP
 * gave a syntax error, counted in the wrapper evaluate() puts around the expression (one line
 * before it and one after), or 0 for an error raised while the expression ran.
 */
export function evaluationError(expression, className, message, line)
{
	if(!line)
	{
		return `${className}: ${message}`;
	}

	const lines = expression.split('\n').length;

	// PHP read to the wrapper's closing parenthesis and was still expecting more.
	if(line > lines + 1 && message.startsWith('syntax error, unexpected'))
	{
		return 'syntax error, unexpected end of expression';
	}

	return lines > 1 && line > 1 && line <= lines + 1 ? `${message} on line ${line - 1}` : message;
}

/**
 * The PHP type worth showing beside a value, or '' when the value says it already: "array(3)"
 * needs no "array" after it, quotes mark a string, and true is a bool. A runtime without
 * debugger API 2 reports JavaScript's types, which say nothing PHP would.
 */
export function typeLabel({type, className, count, displayValue})
{
	const plain = [
		'unset'
		, 'null'
		, 'bool'
		, 'boolean'
		, 'number'
		, 'undefined'
		, 'function'
		, 'unavailable'
	];

	if(!type || plain.includes(type) || (type === 'string' && count == null))
	{
		return '';
	}

	const label = className
		? phpClassLabel(className)
		: type === 'string' ? `string(${count})` : type;

	return String(displayValue).toLowerCase().startsWith(label.toLowerCase()) ? '' : label;
}

/*
 * phpdbg's print command, read into functions and their ops.
 *
 * From PHP 8.1 it hands each function to PHP's own dumper, which writes to standard error:
 *
 *     total:
 *          ; (lines=17, args=1, vars=3, tmps=6)
 *          ; /main.php:2-8
 *     L0005 0007 T5 = FETCH_DIM_R CV2($item) string("price")
 *
 * PHP 8.0's phpdbg prints them itself, the opcode padded to 23 columns and op1, op2 and the
 * result to 20 each, after the address of the function's first op:
 *
 *     L2-8 total() /main.php - 0x23492f0 + 17 ops
 *      L5    #7     FETCH_DIM_R             $item                "price"              ~5
 */

/** The width of a zend_op in a 32-bit WebAssembly build, from one op's address to the next. */
const opSize = 28;

/** One op in the dumper's words: the result, if there is one, then the opcode and operands. */
function dumpedOp(line, index, text)
{
	const [, result = '', opcode = text, operands = ''] = text.match(
		/^(?:(\S+) = )?([A-Z][A-Z0-9_]*)(?: (.*))?$/s
	) ?? [];

	return {line, index, result, opcode, operands};
}

/**
 * Where a column that began at `start` ends. printf pads a column to a width in bytes, so a
 * variable named in other than ASCII fills its column in fewer characters.
 */
function columnEnd(text, start, width)
{
	let at = start;

	for(let bytes = 0; at < text.length && bytes < width; at++)
	{
		const code = text.codePointAt(at);

		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		at += code > 0xFFFF ? 1 : 0;
	}

	return at;
}

/**
 * One op in PHP 8.0's columns: the opcode padded to 23 and op1, op2 and the result to 20 each,
 * a space between them. phpdbg cuts a string or a variable's name to fit its column but not an
 * opcode, so a long one, "INIT_STATIC_METHOD_CALL<1>", moves the columns after it along.
 */
function paddedOp(line, index, text)
{
	const opcode = text.match(/^\S*/)[0];
	const first = Math.max(opcode.length, 23) + 1;
	const second = columnEnd(text, first, 20) + 1;
	const third = columnEnd(text, second, 20) + 1;

	const [op1, op2, result] = [[first, second], [second, third], [third]].map(
		([start, end]) => text.slice(start, end).trim()
	);

	return {line, index, result, opcode, operands: [op1, op2].filter(Boolean).join(' ')};
}

/**
 * Whether the dumper is inside a string once it has written `text`. It writes a string as
 * string("…"), its quotes and backslashes escaped and its line breaks as they are, so a string
 * with a line break in it carries its op onto the lines that follow.
 */
function insideString(text, inside = false)
{
	for(let at = 0; at < text.length; at++)
	{
		if(!inside)
		{
			inside = text.startsWith('string("', at);
			at += inside ? 7 : 0;

			continue;
		}

		// A backslash takes the character after it with it; a bare quote ends the string.
		if(text[at] === '\\')
		{
			at++;
		}
		else if(text[at] === '"')
		{
			inside = false;
		}
	}

	return inside;
}

/** A function the listing begins, named as phpdbg's frames name it: the script is {main}. */
function listedFunction(name, fields = {})
{
	return {
		name: name === '$_main' ? '{main}' : name
		, file: null
		, start: null
		, end: null

		, info: null
		, address: null
		, ops: []
		, ...fields
	};
}

/**
 * The functions in what a print command wrote, each with its ops in order. Lines that are not a
 * function, an op or a detail of one, such as phpdbg's own "Stack in total() (17 ops)" and the
 * internal methods it names after a class, are passed over.
 *
 * A string may hold anything, a line that reads as a function or an op included, so a line is
 * read for what it is only outside a string, a function begins only where the dumper's count of
 * its lines follows, and an op must be the next in number.
 */
export function parseOpcodes(text)
{
	const functions = [];

	// A carriage return in a string is dumped as it is; it is shown as PHP writes it.
	const lines = text.replaceAll('\r', '\\r').split('\n');
	let current = null;

	// The dumped op whose string is still open: the lines that follow are the rest of it.
	let unfinished = null;

	lines.forEach((line, at) => {
		if(unfinished)
		{
			unfinished.operands += '\\n' + line;
			unfinished = insideString(line, true) ? unfinished : null;

			return;
		}

		const dumped = line.match(/^L(\d+) (\d+) (.*)$/s);
		const padded = line.match(/^\s*L(\d+)\s+#(\d+)\s+(.*)$/s);
		const [, number, index, rest] = dumped || padded || [];
		const expected = current?.ops.length ? current.ops.at(-1).index + 1 : null;

		if(rest !== undefined && (expected === null || Number(index) === expected))
		{
			if(!current)
			{
				functions.push(current = listedFunction('?'));
			}

			const op = (dumped ? dumpedOp : paddedOp)(Number(number), Number(index), rest);

			current.ops.push(op);
			unfinished = dumped && insideString(op.operands) ? op : null;

			return;
		}

		const heading = line.match(/^L(\d+)-(\d+) (.+)\(\) (.*) - (0x[0-9a-f]+) \+ \d+ ops$/);

		if(heading)
		{
			const [, start, end, name, file, address] = heading;

			functions.push(current = listedFunction(name, {
				file
				, start: Number(start)
				, end: Number(end)
				, address: parseInt(address, 16)
			}));

			return;
		}

		// The dumper names a function on a line of its own, then counts its lines.
		if(/^[^\s;].*:$/.test(line) && /^\s+; \(lines=\d+/.test(lines[at + 1] ?? ''))
		{
			functions.push(current = listedFunction(line.slice(0, -1)));

			return;
		}

		const detail = line.match(/^\s+; (?:\((.+)\)|(.+):(\d+)-(\d+))$/);

		// A function's details come before its first op.
		if(detail && current && !current.ops.length)
		{
			const [, info, file, start, end] = detail;
			const range = {file, start: Number(start), end: Number(end)};

			Object.assign(current, info ? {info} : range);
		}
	});

	// Which ops each op can jump to, once its operands are whole.
	for(const listed of functions)
	{
		for(const op of listed.ops)
		{
			op.jumps = operandParts(op, listed.ops.length).flatMap(part => part.jump ?? []);
		}
	}

	return functions;
}

/**
 * An op's operands in pieces: text, and the jumps to other ops of its function, as {text, jump}.
 * The dumper writes a target as four digits or more ("0005"), PHP 8.0 as "J5". A number inside
 * a quoted string, an INIT_ op's sizes, and a number past the function's last op are text.
 */
export function operandParts({opcode, operands}, count = Infinity)
{
	const quoted = [...operands.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(
		match => [match.index, match.index + match[0].length]
	);

	const parts = [];
	let from = 0;

	for(const match of operands.matchAll(/(?<![\w$(.\\])(?:J(\d+)|(\d{4,}))(?![\w(])/g))
	{
		const jump = Number(match[1] ?? match[2]);
		const inQuotes = quoted.some(([start, end]) => match.index > start && match.index < end);

		if(inQuotes || jump >= count || opcode.startsWith('INIT_'))
		{
			continue;
		}

		parts.push({text: operands.slice(from, match.index)}, {text: match[0], jump});
		from = match.index + match[0].length;
	}

	parts.push({text: operands.slice(from)});

	return parts.filter(part => part.text);
}

/**
 * The op a print opline names, found among the listed functions' ops: {line, index}, with the
 * index null when only the line is known. PHP 8.0 gives its address, not its number.
 */
export function parseOpline(text, functions)
{
	const dumped = text.match(/^L(\d+) (\d+) /m);

	if(dumped)
	{
		return {line: Number(dumped[1]), index: Number(dumped[2])};
	}

	const padded = text.match(/^\s*L(\d+)\s+(0x[0-9a-f]+) (\S+)/m);

	if(!padded)
	{
		return null;
	}

	const line = Number(padded[1]);
	const address = parseInt(padded[2], 16);

	// The address names an op only where it lands on one with the same line and opcode.
	for(const listed of functions.filter(listed => listed.address !== null))
	{
		const index = (address - listed.address) / opSize;
		const op = listed.ops[index];

		if(op && op.line === line && op.opcode === padded[3])
		{
			return {line, index};
		}
	}

	return {line, index: null};
}

