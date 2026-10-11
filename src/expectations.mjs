function matches(actual, expected) {
  if(expected instanceof RegExp) return new RegExp(expected.source, expected.flags).test(String(actual));
  return actual === expected;
}
export async function checkExpectations(result, expectations, assertion) {
  if(expectations === undefined && !assertion) return {status:'unchecked', failures:[]};
  const failures = [];
  const expect = expectations || {};
  if(result.status !== 'completed') failures.push({field:'status', expected:'completed', actual:result.status});
  for(const field of ['stdout','stderr','exitCode']) {
    if(field in expect && !matches(result[field], expect[field])) failures.push({field, expected:String(expect[field]), actual:result[field]});
  }
  if(!('exitCode' in expect) && !('error' in expect) && result.exitCode !== 0) failures.push({field:'exitCode', expected:0, actual:result.exitCode});
  if('error' in expect) {
    const text = result.diagnostics.map(d => d.message).join('\n');
    if(!result.diagnostics.length || !matches(text, expect.error)) failures.push({field:'error', expected:String(expect.error), actual:text});
  }
  if(assertion) {
    try {if(await assertion(result) === false) failures.push({field:'assertion', message:'Assertion returned false'});}
    catch(error) {failures.push({field:'assertion', message:error.message || String(error)});}
  }
  return {status:failures.length ? 'failed' : 'passed', failures};
}
