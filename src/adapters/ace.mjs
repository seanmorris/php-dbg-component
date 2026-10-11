/** Bind an existing Ace instance without importing Ace or replacing its session. */
export function createAceAdapter(editor, {file='/main.php'} = {}) {
  const listeners=new Set(); const originalReadOnly=editor.getReadOnly(); let marker=null; let disposed=false; let owned=new Map();
  const session=editor.session;
  const clear=()=>{for(const [row,previous] of owned){session.clearBreakpoint(row);if(previous)session.setBreakpoint(row,previous);}owned.clear();};
  const gutter=event=>{
    const target=event.domEvent?.target;
    if(target && !target.closest('.ace_gutter-cell'))return;
    const row=event.getDocumentPosition().row;
    const lines=[...owned.keys()].filter(n=>n!==row).map(n=>({file,line:n+1}));
    if(!owned.has(row))lines.push({file,line:row+1});
    event.stop?.();event.domEvent?.preventDefault();for(const listener of listeners)listener(lines);
  };
  editor.on('guttermousedown',gutter);
  return {
    getCode:()=>session.getValue(), setCode:code=>session.setValue(code),
    setReadOnly:readOnly=>editor.setReadOnly(readOnly || originalReadOnly),
    onBreakpointChange(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    setBreakpoints(breakpoints){
      if(disposed)return;clear();
      for(const bp of breakpoints){if(bp.file!==file||!bp.enabled)continue;const row=bp.line-1;const previous=session.getBreakpoints()[row];owned.set(row,previous);session.setBreakpoint(row,[previous,'php-debugger-breakpoint-marker'].filter(Boolean).join(' '));}
    },
    showLocation(location){
      if(marker!==null)session.removeMarker(marker);marker=null;
      if(!location||location.file!==file)return;
      const Range=editor.getSelectionRange().constructor;
      marker=session.addMarker(new Range(location.line-1,0,location.line-1,Infinity),'php-debugger-active-line','fullLine');
      editor.scrollToLine(location.line-1,true,true,()=>{});
    },
    dispose(){if(disposed)return;disposed=true;editor.off('guttermousedown',gutter);clear();if(marker!==null)session.removeMarker(marker);editor.setReadOnly(originalReadOnly);listeners.clear();}
  };
}
