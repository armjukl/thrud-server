'use strict';
// 彻底跳过 loginLoop 视频预载: replace PreLoadVideo -> 只触发 prepare 回调
function emit(ev,m){try{send(Object.assign({ev:ev},m));}catch(e){}}
(function(){
 var il2=Process.findModuleByName('libil2cpp.so');if(!il2){emit('err',{m:'no il2'});return;}
 var base=il2.base;
 function g(n,r,a){return new NativeFunction(il2.findExportByName(n),r,a);}
 var runtimeInvoke=g('il2cpp_runtime_invoke','pointer',['pointer','pointer','pointer','pointer']);
 var objGetClass=g('il2cpp_object_get_class','pointer',['pointer']);
 var clsGetMethods=g('il2cpp_class_get_methods','pointer',['pointer','pointer']);
 var mGetName=g('il2cpp_method_get_name','pointer',['pointer']);
 var threadAttach=g('il2cpp_thread_attach','pointer',['pointer']);
 var domainGet=g('il2cpp_domain_get','pointer',[]);
 function cs(p){try{return p&&!p.isNull()?p.readCString():'';}catch(e){return '';}}
 function il2s(p){try{if(!p||p.isNull())return '';var n=p.add(16).readS32();if(n<0||n>2000)return '';var s='';for(var i=0;i<n;i++)s+=String.fromCharCode(p.add(20+i*2).readU16());return s;}catch(e){return '';}}
 function invokeDelegate(cb){
  try{var cls=objGetClass(cb);var it=Memory.alloc(8);it.writePointer(ptr(0));var m;
   while(!(m=clsGetMethods(cls,it)).isNull()){ if(cs(mGetName(m))==='Invoke'){ try{threadAttach(domainGet());}catch(e){} runtimeInvoke(m,cb,ptr(0),ptr(0)); emit('cb-invoked',{}); return; } }
  }catch(e){emit('err',{m:'invoke '+e});}
 }
 try{
  var cb=new NativeCallback(function(self,path,b,cbp,n){
    emit('PreLoadVideo(NOOP)',{path:il2s(path),hasCb:!!(cbp&&!cbp.isNull())});
    if(cbp&&!cbp.isNull()) setTimeout(function(){invokeDelegate(cbp);},50);
  },'void',['pointer','pointer','int','pointer','int']);
  Interceptor.replace(base.add(0xf6fb54),cb);
  emit('replaced',{m:'PreLoadVideo'});
 }catch(e){emit('err',{m:'replace '+e});}
 emit('ready',{});
})();
