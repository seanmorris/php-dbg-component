import {Compartment, StateEffect, StateField, RangeSet, EditorState} from '@codemirror/state';
import {gutter, GutterMarker, Decoration, EditorView} from '@codemirror/view';

/** Optional CodeMirror 6 integration; these peer imports never enter the core. */
export function createCodeMirror6Adapter(view,{file='/main.php'}={}) {
  const compartment=new Compartment();const readOnlyCompartment=new Compartment();const change=StateEffect.define();const position=StateEffect.define();const listeners=new Set();let lines=[];let disposed=false;
  class Marker extends GutterMarker {toDOM(){const n=document.createElement('span');n.className='php-debugger-breakpoint-marker';n.textContent='●';return n;}}
  const marker=new Marker();
  const markers=StateField.define({create:()=>RangeSet.empty,update(value,tr){value=value.map(tr.changes);for(const effect of tr.effects)if(effect.is(change))value=RangeSet.of(effect.value.map(from=>marker.range(from)),true);return value;}});
  const active=StateField.define({create:()=>Decoration.none,update(value,tr){value=value.map(tr.changes);for(const effect of tr.effects)if(effect.is(position))value=effect.value===null?Decoration.none:Decoration.set([Decoration.line({class:'php-debugger-active-line'}).range(effect.value)]);return value;},provide:field=>EditorView.decorations.from(field)});
  const extension=[markers,active,gutter({class:'php-debugger-cm6-gutter',markers:view=>view.state.field(markers),initialSpacer:()=>marker,
    domEventHandlers:{mousedown(view,line){const number=view.state.doc.lineAt(line.from).number;const next=lines.filter(bp=>bp.line!==number);if(next.length===lines.length)next.push({file,line:number});for(const listener of listeners)listener(next);return true;}}})];
  view.dispatch({effects:StateEffect.appendConfig.of([compartment.of(extension),readOnlyCompartment.of([])])});
  return {
    getCode:()=>view.state.doc.toString(),setCode:code=>view.dispatch({changes:{from:0,to:view.state.doc.length,insert:code}}),
    setReadOnly:value=>view.dispatch({effects:readOnlyCompartment.reconfigure(value?[EditorState.readOnly.of(true),EditorView.editable.of(false)]:[])}),
    onBreakpointChange(callback){listeners.add(callback);return()=>listeners.delete(callback);},
    setBreakpoints(breakpoints){lines=breakpoints.filter(bp=>bp.file===file&&bp.enabled);view.dispatch({effects:change.of(lines.filter(bp=>bp.line<=view.state.doc.lines).map(bp=>view.state.doc.line(bp.line).from))});},
    showLocation(location){const from=location?.file===file&&location.line<=view.state.doc.lines?view.state.doc.line(location.line).from:null;view.dispatch({effects:[position.of(from),...(from===null?[]:[EditorView.scrollIntoView(from,{y:'center'})])]});},
    dispose(){if(disposed)return;disposed=true;view.dispatch({effects:[compartment.reconfigure([]),readOnlyCompartment.reconfigure([])]});listeners.clear();}
  };
}
