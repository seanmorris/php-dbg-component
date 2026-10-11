import {versions} from './model.mjs';

function node(tag, className, text) {const n=document.createElement(tag); if(className)n.className=className; if(text!==undefined)n.textContent=text; return n;}

export class DebuggerView {
  constructor(debuggerInstance, host) {
    if(!host?.append) throw new TypeError('mount needs a DOM element');
    this.dbg = debuggerInstance; this.host=host; this.abort=new AbortController(); this.panel='variables'; this.refreshNumber=0; this.watches=[];
    const dbg=this.dbg;
    this.root=node('section','php-debugger'); this.root.setAttribute('aria-label','PHP debugger'); host.append(this.root);
    this.toolbar=node('div','php-debugger-toolbar'); this.root.append(this.toolbar); this.buttons=new Map();
    const controls=[['Run',()=>dbg.run()],['Continue',()=>dbg.continue()],['Pause',()=>dbg.pause()],['Stop',()=>dbg.stop()],['Restart',()=>dbg.restart()],['Step into',()=>dbg.stepInto()],['Step over',()=>dbg.stepOver()],['Step out',()=>dbg.stepOut()],['Until',()=>dbg.until()],['Leave',()=>dbg.leave()]];
    for(const [label,action] of controls) {
      const button=node('button','php-debugger-button',label); button.type='button'; this.buttons.set(label,button); this.toolbar.append(button);
      button.addEventListener('click',()=>this.act(action),{signal:this.abort.signal});
    }
    this.version=node('select','php-debugger-version'); this.version.setAttribute('aria-label','PHP version');
    for(const version of dbg.options.versions || versions) {const option=node('option','',version); option.value=version; this.version.append(option);}
    this.version.value=dbg.options.version; this.version.addEventListener('change',()=>this.act(()=>dbg.setVersion(this.version.value)),{signal:this.abort.signal}); this.toolbar.append(this.version);
    this.status=node('output','php-debugger-status'); this.status.setAttribute('aria-live','polite'); this.root.append(this.status);
    this.message=node('div','php-debugger-message'); this.message.setAttribute('role','alert'); this.root.append(this.message);
    if(!dbg.source && typeof dbg.options.code !== 'function') {
      const editor=node('div','php-debugger-editor'); this.gutter=node('div','php-debugger-gutter');
      this.textarea=node('textarea','php-debugger-source'); this.textarea.setAttribute('aria-label','PHP source'); this.textarea.spellcheck=false;
      this.textarea.value=typeof dbg.options.code==='string' ? dbg.options.code : '';
      // Keep getters authoritative; the textarea is only an editor for string sources.
      if(typeof dbg.options.code!=='function') dbg.source=this.textarea;
      this.textarea.addEventListener('input',()=>this.gutterUpdate(),{signal:this.abort.signal});
      this.textarea.addEventListener('scroll',()=>{this.gutter.scrollTop=this.textarea.scrollTop;},{signal:this.abort.signal});
      editor.append(this.gutter,this.textarea); this.root.append(editor);
    }
    this.breakpoints=node('div','php-debugger-breakpoints');
    const lineInput=node('input','php-debugger-breakpoint-line'); lineInput.type='number';lineInput.min='1';lineInput.placeholder='Line';lineInput.setAttribute('aria-label','Breakpoint line');
    const add=node('button','php-debugger-button','Add breakpoint');add.type='button';
    add.addEventListener('click',()=>this.act(()=>dbg.setBreakpoints([...dbg.breakpoints,{line:Number(lineInput.value)}])),{signal:this.abort.signal});
    this.breakpointList=node('ul','php-debugger-breakpoint-list');this.breakpoints.append(lineInput,add,this.breakpointList);this.root.append(this.breakpoints);
    const body=node('div','php-debugger-body');this.root.append(body);
    this.console=node('pre','php-debugger-console');this.console.setAttribute('aria-label','PHP and debugger output');this.console.tabIndex=0;body.append(this.console);
    const right=node('div','php-debugger-inspector');body.append(right);this.tabs=node('div','php-debugger-tabs');right.append(this.tabs);
    for(const scope of ['variables','globals','constants','functions','classes','files','frames','watches']) {
      const button=node('button','php-debugger-tab',scope);button.type='button';button.dataset.panel=scope;
      button.addEventListener('click',()=>{this.panel=scope;void this.refresh();},{signal:this.abort.signal});this.tabs.append(button);
    }
    this.content=node('div','php-debugger-values');right.append(this.content);
    const form=node('form','php-debugger-expression-form');this.expression=node('input','php-debugger-expression');this.expression.setAttribute('aria-label','PHP expression');this.expression.placeholder='PHP expression';
    const evaluate=node('button','php-debugger-button','Evaluate');evaluate.type='submit';const watch=node('button','php-debugger-button','Watch');watch.type='button';
    form.append(this.expression,evaluate,watch);this.root.append(form);
    form.addEventListener('submit',event=>{event.preventDefault();void this.act(async()=>{const value=await dbg.evaluate(this.expression.value);this.appendOutput({channel:'evaluation',text:value.displayValue+'\n'});await this.refresh();});},{signal:this.abort.signal});
    watch.addEventListener('click',()=>{if(this.expression.value.trim()){this.watches.push(this.expression.value);this.panel='watches';void this.refresh();}},{signal:this.abort.signal});
    const on=(type,callback)=>dbg.addEventListener(type,event=>callback(event.detail),{signal:this.abort.signal});
    on('statechange',()=>this.update());on('testresult',()=>this.update());on('output',event=>this.appendOutput(event));
    on('pause',()=>void this.refresh());on('framechange',()=>void this.refresh());on('variablechange',()=>void this.refresh());
    on('breakpointchange',()=>this.gutterUpdate());on('locationchange',location=>this.showLocation(location));
    on('sourcechange',()=>this.gutterUpdate());on('versionchange',()=>{this.version.value=dbg.options.version;});
    on('complete',result=>{if(result.test.status==='failed')this.message.textContent=result.test.failures.map(f=>`${f.field}: expected ${f.expected ?? f.message}, received ${f.actual ?? ''}`).join('\n');if(result.status==='error')this.message.textContent=result.diagnostics.map(d=>d.message).join('\n');});
    this.adapterUnsubscribe=dbg.source?.onBreakpointChange?.(lines=>this.act(()=>dbg.setBreakpoints([
      ...dbg.breakpoints.filter(bp=>bp.file!==dbg.options.entrypoint || (!bp.enabled && !lines.some(line=>(typeof line==='number'?line:line.line)===bp.line))),
      ...lines
    ])));
    this.gutterUpdate();this.update();
  }
  async act(callback) {this.message.textContent='';try{return await callback();}catch(error){this.message.textContent=error.message || String(error);}}
  update() {
    const {state,testStatus}=this.dbg;this.root.dataset.state=state;this.root.dataset.testStatus=testStatus;this.root.setAttribute('aria-busy',String(['loading','running'].includes(state)));
    this.status.textContent=`${state}${testStatus==='unchecked'?'':` · ${testStatus}`}`;
    for(const [label,button] of this.buttons) button.disabled=label==='Run' ? !!this.dbg.active : label==='Pause' ? state!=='running' : label==='Stop' || label==='Restart' ? !this.dbg.active : state!=='paused';
    if(this.textarea)this.textarea.readOnly=!!this.dbg.active;
    this.dbg.source?.setReadOnly?.(!!this.dbg.active);
    if(!this.dbg.location)this.showLocation(null);
    if(state!=='paused') {this.refreshNumber++;this.content.replaceChildren(node('p','php-debugger-empty','Pause execution to inspect values.'));}
  }
  gutterUpdate() {
    const dbg=this.dbg;this.breakpointList.replaceChildren();
    for(const bp of dbg.breakpoints) {
      const item=node('li','php-debugger-breakpoint');const toggle=node('input');toggle.type='checkbox';toggle.checked=bp.enabled;toggle.setAttribute('aria-label',`Enable breakpoint ${bp.file}:${bp.line}`);
      toggle.addEventListener('change',()=>this.act(()=>dbg.setBreakpoints(dbg.breakpoints.map(b=>b.id===bp.id?{...b,enabled:toggle.checked}:b))));
      const remove=node('button','php-debugger-button',`Remove ${bp.file}:${bp.line}`);remove.type='button';remove.addEventListener('click',()=>this.act(()=>dbg.setBreakpoints(dbg.breakpoints.filter(b=>b.id!==bp.id))));item.append(toggle,remove);this.breakpointList.append(item);
    }
    dbg.source?.setBreakpoints?.(dbg.breakpoints.filter(bp=>bp.file===dbg.options.entrypoint));
    if(!this.gutter)return;
    this.gutter.replaceChildren();const lines=this.textarea.value.split('\n').length;
    for(let line=1;line<=lines;line++) {
      const b=node('button','php-debugger-line',String(line));b.type='button';b.setAttribute('aria-label',`Toggle breakpoint on line ${line}`);
      b.dataset.breakpoint=String(dbg.breakpoints.some(bp=>bp.file===dbg.options.entrypoint&&bp.line===line&&bp.enabled));
      b.addEventListener('click',()=>this.act(()=>dbg.setBreakpoints(dbg.breakpoints.some(bp=>bp.line===line&&bp.file===dbg.options.entrypoint)?dbg.breakpoints.filter(bp=>bp.line!==line||bp.file!==dbg.options.entrypoint):[...dbg.breakpoints,line])));this.gutter.append(b);
    }
  }
  showLocation(location) {
    this.dbg.source?.showLocation?.(location);
    if(!location && this.gutter) for(const line of this.gutter.children) line.dataset.active='false';
    if(this.textarea && location?.file===this.dbg.options.entrypoint) {
      const lines=this.textarea.value.split('\n');const start=lines.slice(0,location.line-1).reduce((a,b)=>a+b.length+1,0);
      this.textarea.setSelectionRange(start,start+(lines[location.line-1]?.length||0));
      for(const line of this.gutter.children)line.dataset.active=String(Number(line.textContent)===location.line);
    }
  }
  appendOutput({channel,text}) {
    if(channel==='debug' && !text.endsWith('\n'))text+='\n';
    const span=node('span',`php-debugger-output php-debugger-output-${channel}`,text);this.console.append(span);
    while(this.console.childNodes.length>1000)this.console.firstChild.remove();this.console.scrollTop=this.console.scrollHeight;
  }
  async refresh() {
    const generation=++this.refreshNumber;
    for(const tab of this.tabs.children)tab.setAttribute('aria-pressed',String(tab.dataset.panel===this.panel));
    if(this.dbg.state!=='paused')return;
    await this.act(async()=>{
      let values;
      if(this.panel==='watches') values=await Promise.all(this.watches.map(async expression=>{try{return {...await this.dbg.evaluate(expression),name:expression};}catch(error){return {name:expression,displayValue:error.message,writable:false};}}));
      else values=await this.dbg.inspect(this.panel);
      if(generation!==this.refreshNumber||this.dbg.state!=='paused')return;
      this.content.replaceChildren();
      if(['variables','globals','constants','watches'].includes(this.panel)) for(const value of values)this.content.append(this.valueNode(value));
      else for(const value of Array.isArray(values)?values:Object.values(values)) {
        const item=node('button','php-debugger-symbol',typeof value==='string'?value:`${value.name || `Frame ${value.frame}`} — ${value.filename}:${value.lineNo}`);item.type='button';
        item.addEventListener('click',()=>this.act(async()=>{if(this.panel==='frames')await this.dbg.selectFrame(value.frame);else this.showLocation({file:typeof value==='string'?value:value.filename,line:value.lineNo||1});}));this.content.append(item);
      }
    });
  }
  valueNode(value, depth=0) {
    const row=node('div','php-debugger-value');const name=node('span','php-debugger-value-name',value.name+': ');const preview=node('span','php-debugger-value-preview',value.displayValue);row.append(name,preview);
    if(value.expandable && depth<30) {
      const expand=node('button','php-debugger-expand','Expand');expand.type='button';expand.setAttribute('aria-label',`Expand ${value.name}`);const children=node('div','php-debugger-children');row.append(expand,children);let offset=0;
      expand.addEventListener('click',()=>this.act(async()=>{const page=await this.dbg.children(value.reference,{offset,limit:100});for(const child of page.values)children.append(this.valueNode(child,depth+1));offset+=page.values.length;expand.disabled=offset>=page.total;expand.textContent=expand.disabled?'Expanded':'More';}));
    }
    if(value.writable) {
      const edit=node('button','php-debugger-edit','Edit');edit.type='button';edit.setAttribute('aria-label',`Edit ${value.name}`);row.append(edit);
      edit.addEventListener('click',()=>{
        const input=node('input','php-debugger-edit-expression');input.setAttribute('aria-label',`New PHP expression for ${value.name}`);input.value=value.type==='string'?"'"+String(value.value).replaceAll('\\','\\\\').replaceAll("'","\\'")+"'":value.displayValue;
        const save=node('button','php-debugger-button','Apply');save.type='button';row.append(input,save);edit.disabled=true;input.focus();
        save.addEventListener('click',()=>this.act(async()=>{await this.dbg.setVariable(value.reference,input.value);await this.refresh();}));
      });
    }
    return row;
  }
  destroy() {this.abort.abort();this.adapterUnsubscribe?.();this.dbg.source?.showLocation?.(null);this.dbg.source?.setReadOnly?.(false);if(this.dbg.source===this.textarea){this.dbg.options.code=this.textarea.value;this.dbg.source=null;}this.root.remove();}
}
