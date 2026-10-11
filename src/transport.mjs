import {deferred} from './model.mjs';

export async function createTransport(options, assets, emit) {
  if(options.execution === 'main') {
    const {DebugEngine} = await import('./engine.mjs');
    const engine = new DebugEngine(emit);
    return {open:() => engine.open(assets, options), call:(method, ...args) => engine.invoke(method, args), destroy:() => engine.stop()};
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
  worker.onerror = event => fail(new Error(event.message || 'Debugger worker failed'));
  worker.onmessageerror = () => fail(new Error('Debugger worker returned an invalid message'));
  function call(method, ...args) {
    if(destroyed) return Promise.reject(new Error('Debugger worker is closed'));
    const wait = deferred(); const request = ++id; pending.set(request, wait);
    try {worker.postMessage({id:request, method, args});}
    catch(error) {pending.delete(request); wait.reject(error);}
    return wait.promise;
  }
  return {
    open:() => call('open', assets, {version:options.version, runtimeArgs:options.runtimeArgs}), call,
    destroy() {destroyed = true; worker.terminate(); fail(new DOMException('Debugger worker closed', 'AbortError'));}
  };
}
