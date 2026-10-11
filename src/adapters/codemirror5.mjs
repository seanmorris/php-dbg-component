/** CodeMirror 5 adapter; the editor and its library remain owned by the host. */
export function createCodeMirror5Adapter(editor,{file='/main.php'}={}) {
  const gutter='php-debugger-cm5-gutter';const listeners=new Set();const previousGutters=editor.getOption('gutters') || [];
  const added=!previousGutters.includes(gutter);if(added)editor.setOption('gutters',[...previousGutters,gutter]);
  const readOnly=editor.getOption('readOnly');let markers=[];let active=null;let lines=[];let disposed=false;
  const click=(cm,line,id)=>{if(id!==gutter)return;const next=lines.filter(bp=>bp.line!==line+1);if(next.length===lines.length)next.push({file,line:line+1});for(const callback of listeners)callback(next);};
  editor.on('gutterClick',click);
  return {
    getCode:()=>editor.getValue(),setCode:code=>editor.setValue(code),
    setReadOnly:next=>editor.setOption('readOnly',next || readOnly),
    onBreakpointChange(callback){listeners.add(callback);return()=>listeners.delete(callback);},
    setBreakpoints(breakpoints){
      for(const marker of markers)editor.setGutterMarker(marker,gutter,null);markers=[];
      lines=breakpoints.filter(bp=>bp.file===file&&bp.enabled);
      for(const bp of lines){const marker=document.createElement('span');marker.className='php-debugger-breakpoint-marker';marker.textContent='●';markers.push(editor.setGutterMarker(bp.line-1,gutter,marker));}
    },
    showLocation(location){if(active)editor.removeLineClass(active,'background','php-debugger-active-line');active=null;if(location?.file===file){active=editor.addLineClass(location.line-1,'background','php-debugger-active-line');editor.scrollIntoView({line:location.line-1,ch:0},60);}},
    dispose(){if(disposed)return;disposed=true;editor.off('gutterClick',click);for(const marker of markers)editor.setGutterMarker(marker,gutter,null);if(active)editor.removeLineClass(active,'background','php-debugger-active-line');if(added)editor.setOption('gutters',editor.getOption('gutters').filter(id=>id!==gutter));editor.setOption('readOnly',readOnly);listeners.clear();}
  };
}
