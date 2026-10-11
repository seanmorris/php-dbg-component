import {PhpDebugger} from './index.mjs';

/** Registration is explicit, so importing this module has no DOM side effects. */
export function definePhpDebugger(name = 'php-debugger', registry = customElements) {
  if(registry.get(name)) return registry.get(name);
  class PhpDebuggerElement extends HTMLElement {
    static observedAttributes = ['version'];
    connectedCallback() {
      if(this.debugger) return;
      const sourceSelector = this.getAttribute('source');
      const source = this.source || (sourceSelector ? this.ownerDocument.querySelector(sourceSelector) : this.querySelector('textarea,pre,code,script[type="text/php"]'));
      const options = {...this.options, version:this.getAttribute('version') || this.options?.version || '8.4',
        execution:this.getAttribute('execution') || this.options?.execution || 'worker', source,
        runtimeBaseUrl:this.getAttribute('runtime-base-url') || this.options?.runtimeBaseUrl};
      if(this._code !== undefined) {options.code=this._code;options.source=null;}
      if(this.hasAttribute('breakpoints')) options.breakpoints=JSON.parse(this.getAttribute('breakpoints'));
      if(this.hasAttribute('extensions')) options.extensions=this.getAttribute('extensions').split(/[\s,]+/).filter(Boolean);
      const expectation = this.querySelector('script[type="application/json"][data-expect]');
      if(expectation) options.expect=JSON.parse(expectation.textContent);
      if(this.expect !== undefined) options.expect=this.expect;
      this.debugger = new PhpDebugger(options);
      this.forwarding = new AbortController();
      for(const name of ['statechange','output','pause','complete','testresult','variablechange','breakpointchange','locationchange','diagnostic'])
        this.debugger.addEventListener(name,event=>this.dispatchEvent(new CustomEvent(`phpdbg-${name}`,{detail:event.detail,bubbles:true})),{signal:this.forwarding.signal});
      this.debugger.mount(this);
      if(this.hasAttribute('autorun')) queueMicrotask(()=>{if(this.isConnected)void this.run({mode:this.getAttribute('mode') || 'debug'});});
    }
    disconnectedCallback() {
      // Moving a node within the same document should not terminate its run.
      queueMicrotask(()=>{if(!this.isConnected){this.forwarding?.abort();void this.debugger?.destroy();this.debugger=null;}});
    }
    attributeChangedCallback(name, old, value) {if(name==='version' && old!==value && this.debugger)void this.debugger.setVersion(value).catch(error=>this.dispatchEvent(new CustomEvent('phpdbg-error',{detail:error,bubbles:true})));}
    get code() {return this._code;}
    set code(value) {this._code=value;this.debugger?.setCode(value);}
    get state() {return this.debugger?.state || 'idle';}
    get result() {return this.debugger?.result || null;}
    prepare() {return this.debugger.prepare();}
    run(options) {return this.debugger.run(options);}
    stop() {return this.debugger.stop();}
    restart(options) {return this.debugger.restart(options);}
    whenPaused() {return this.debugger.whenPaused();}
    inspect(...args) {return this.debugger.inspect(...args);}
    evaluate(...args) {return this.debugger.evaluate(...args);}
    setVariable(...args) {return this.debugger.setVariable(...args);}
    setBreakpoints(...args) {return this.debugger.setBreakpoints(...args);}
  }
  registry.define(name, PhpDebuggerElement); return PhpDebuggerElement;
}
