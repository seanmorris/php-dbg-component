function matches(actual, expected)
{
	if(expected instanceof RegExp)
	{
		return new RegExp(expected.source, expected.flags).test(String(actual));
	}

	return actual === expected;
}

export async function checkExpectations(result, expectations, assertion)
{
	if(expectations === undefined && !assertion)
	{
		return {status: 'unchecked', failures: []};
	}

	const failures = [];
	const expect = expectations || {};

	if(result.status !== 'completed')
	{
		failures.push({field: 'status', expected: 'completed', actual: result.status});
	}

	for(const field of ['stdout', 'stderr', 'exitCode'])
	{
		if(field in expect && !matches(result[field], expect[field]))
		{
			failures.push({field, expected: String(expect[field]), actual: result[field]});
		}
	}

	// What the logpoints printed, in order: each entry is a string or a pattern for one message.
	if('logs' in expect)
	{
		const actual = result.logs.map(entry => entry.message);

		const same = actual.length === expect.logs.length
			&& expect.logs.every((expected, index) => matches(actual[index], expected));

		if(!same)
		{
			const expected = expect.logs.map(String).join('\n');

			failures.push({field: 'logs', expected, actual: actual.join('\n')});
		}
	}

	if(!('exitCode' in expect) && !('error' in expect) && result.exitCode !== 0)
	{
		failures.push({field: 'exitCode', expected: 0, actual: result.exitCode});
	}

	if('error' in expect)
	{
		const text = result.diagnostics.map(d => d.message).join('\n');

		if(!result.diagnostics.length || !matches(text, expect.error))
		{
			failures.push({field: 'error', expected: String(expect.error), actual: text});
		}
	}

	if(assertion)
	{
		let message = null;

		try
		{
			message = await assertion(result) === false ? 'Assertion returned false' : null;
		}
		catch(error)
		{
			message = error.message || String(error);
		}

		if(message !== null)
		{
			failures.push({field: 'assertion', message});
		}
	}

	return {status: failures.length ? 'failed' : 'passed', failures};
}
