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
		found.set(id, {id, file, line: bp.line, enabled: bp.enabled !== false});
	}

	return [...found.values()];
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
 * a NUL byte, then the name; a protected one has "*" for the class. Only a key
 * that starts with a NUL byte is mangled: PHP refuses a property name that
 * starts with one, but a public name may hold NUL bytes after its first character.
 */
export function phpPropertyName(key)
{
	const end = key.startsWith('\0') ? key.indexOf('\0', 1) : -1;

	if(end < 0)
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
