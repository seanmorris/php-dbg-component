/** Read Emscripten dependency metadata without compiling or instantiating a library. */
export function wasmDependencies(bytes) {
  const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);let offset=8;
  if(data.length<8 || data[0]!==0 || data[1]!==97 || data[2]!==115 || data[3]!==109)throw new Error('Invalid WASM asset');
  const leb=()=>{let value=0,shift=0,byte;do{if(offset>=data.length || shift>28)throw new Error('Invalid WASM metadata');byte=data[offset++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;};
  const string=()=>{const length=leb();if(offset+length>data.length)throw new Error('Truncated WASM string');const value=new TextDecoder().decode(data.subarray(offset,offset+length));offset+=length;return value;};
  while(offset<data.length){
    const type=data[offset++],size=leb(),end=offset+size;
    if(end>data.length)throw new Error('Truncated WASM section');
    if(type===0 && string()==='dylink.0'){
      while(offset<end){const subsection=data[offset++],length=leb(),next=offset+length;if(next>end)throw new Error('Invalid dylink metadata');
        if(subsection===2){const count=leb(),names=[];for(let i=0;i<count;i++)names.push(string());if(offset!==next)throw new Error('Invalid dependency metadata');return names;}
        offset=next;
      }
    }
    offset=end;
  }
  return [];
}
