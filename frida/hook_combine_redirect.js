'use strict';
// 记录所有 UWR.Get/Post URL, 并把 Combine* 改写为原始索引
function emit(ev,m){try{send(Object.assign({ev:ev},m));}catch(e){}}
(function(){
 var il2=Process.findModuleByName('libil2cpp.so');if(!il2){emit('err',{m:'no il2'});return;}
 function g(n,r,a){return new NativeFunction(il2.findExportByName(n),r,a);}
 var exp=il2.findExportByName('il2cpp_string_new'); if(!exp){emit('err',{m:'no strnew'});return;}
 var strNew=new NativeFunction(exp,'pointer',['pointer']);
 var domainGet=g('il2cpp_domain_get','pointer',[]),getAssemblies=g('il2cpp_domain_get_assemblies','pointer',['pointer','pointer']);
 var asmGetImage=g('il2cpp_assembly_get_image','pointer',['pointer']),imgName=g('il2cpp_image_get_name','pointer',['pointer']);
 var classFromName=g('il2cpp_class_from_name','pointer',['pointer','pointer','pointer']),clsGetMethods=g('il2cpp_class_get_methods','pointer',['pointer','pointer']);
 var mGetName=g('il2cpp_method_get_name','pointer',['pointer']),mGetParamCount=g('il2cpp_method_get_param_count','uint32',['pointer']);
 var threadAttach=g('il2cpp_thread_attach','pointer',['pointer']);
 function cs(p){try{return p&&!p.isNull()?p.readCString():'';}catch(e){return '';}}
 function il2s(p){try{if(!p||p.isNull())return '';var n=p.add(16).readS32();if(n<0||n>4000)return '';var s='';for(var i=0;i<n;i++)s+=String.fromCharCode(p.add(20+i*2).readU16());return s;}catch(e){return '';}}
 var d=domainGet();if(!d||d.isNull()){emit('err',{m:'no domain'});return;}threadAttach(d);
 var cnt=Memory.alloc(8);cnt.writeU64(0);var as=getAssemblies(d,cnt),n=cnt.readU64().toNumber();
 var found=null;for(var i=0;i<n;i++){var im=asmGetImage(as.add(i*8).readPointer());
   var kl=classFromName(im,Memory.allocUtf8String('UnityEngine.Networking'),Memory.allocUtf8String('UnityWebRequest'));
   if(!kl.isNull()){found=kl;break;}}
 if(!found){emit('err',{m:'no uwr'});return;}
 var MAP={'CombineAbIndex.json':'abIndex.json','CombineAssetBundleDepData.json':'AssetBundleDepData.json'};
 var it=Memory.alloc(8),m;it.writePointer(ptr(0));
 while(!(m=clsGetMethods(found,it)).isNull()){var mn=cs(mGetName(m));if(['Get','Post','Put','Delete','Head'].indexOf(mn)<0)continue;if(mGetParamCount(m)<1)continue;
  (function(mn2,ad){try{Interceptor.attach(ad,{onEnter:function(a){var u=il2s(a[0]);var orig=u;
    for(var key in MAP){if(u.indexOf(key)>=0){u=u.split(key).join(MAP[key]);a[0]=strNew(Memory.allocUtf8String(u));break;}}
    emit('url',{fn:mn2,from:orig,to:uRw(u)});} });}catch(e){}
   function uRw(u){return u;}})(mn,m.readPointer());}
 emit('ready',{});
})();
