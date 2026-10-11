import {deferred} from './model.mjs';

export async function createTransport(options, assets, emit) {
  const runtimeArgs = {...options.runtimeArgs};
  // Package hooks and URL instances are resolved on the page before crossing
  // the worker boundary; the engine receives cached, normalized assets instead.
  for(const key of ['sharedLibs','dynamicLibs','files']) delete runtimeArgs[key];
  const runtimeOptions = {version:options.version, runtimeArgs};
  if(options.execution === 'main') {
    const {DebugEngine} = await import('./engine.mjs');
    const engine = new DebugEngine(emit);
    return {open:() => engine.open(assets, runtimeOptions), call:(method, ...args) => engine.invoke(method, args), destroy:() => engine.stop()};
  }
  const worker = new Worker(options.workerUrl || new URL('./worker.mjs', import.meta.url), {type:'module'});
  const pending = new Map(); let id = 0; let destroyed = false;
  const fail = error => {for(const wait of pending.values()) wait.reject(error); pending.clear();};
  worker.onmessage = ({data}) => {
    if(data.event) {emit(data.event); return;}
    const wait = pending.get(data.id); if(!wait) return;
    pending.delete(data.id);
    if(data.error) wait.reject(Object.assign(new Error(data.error.message), {name:data.error.name}));
    else wait.resolve(data.value);
  };
  const fatal = error => {fail(error); if(!destroyed) emit({type:'fatal',error});};
  worker.onerror = event => fatal(new Error(event.message || 'Debugger worker failed'));
  worker.onmessageerror = () => fatal(new Error('Debugger worker returned an invalid message'));
  function call(method, ...args) {
    if(destroyed) return Promise.reject(new Error('Debugger worker is closed'));
    const wait = deferred(); const request = ++id; pending.set(request, wait);
    try {worker.postMessage({id:request, method, args});}
    catch(error) {pending.delete(request); wait.reject(error);}
    return wait.promise;
  }
  return {
    open:() => call('open', assets, runtimeOptions), call,
    destroy() {destroyed = true; worker.terminate(); fail(new DOMException('Debugger worker closed', 'AbortError'));}
  };
}
