import {DebugEngine} from './engine.mjs';
import {errorRecord} from './model.mjs';
let engine;
self.onmessage = async ({data}) => {
  const {id, method, args} = data;
  try {
    let value;
    if(method === 'open') {
      engine = new DebugEngine(event => postMessage({event}));
      value = await engine.open(...args);
    } else value = await engine.invoke(method, args);
    postMessage({id, value});
  } catch(error) {postMessage({id, error:errorRecord(error)});}
};
