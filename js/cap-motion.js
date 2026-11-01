/* Optional, presentation-only Anime.js V4 bridge for classic-script Cap.
   Underlying DOM/CSS is always the final state. Never queue a late entrance. */
(function(){
  'use strict';
  if(window.CapMotion)return;
  const jobs=new Map(),media=matchMedia('(prefers-reduced-motion: reduce)');
  let animate=null;
  const reduced=()=>media.matches||document.documentElement.matches('.rm,.noanim');
  function cancel(root){
    for(const [el,job] of jobs){
      if(!root||el===root||root.contains(el)){
        jobs.delete(el);job.revert();
      }
    }
  }
  function reveal(el){
    if(!el)return;
    cancel(el);
    if(!animate||reduced()||document.hidden||!el.isConnected||el.closest('[hidden]'))return;
    // Caller owns this child exclusively: no CSS/WAAPI transform on this target.
    const job=animate(el,{
      opacity:[.72,1],translateY:[4,0],duration:180,ease:'outCubic',
      onComplete:()=>{if(jobs.get(el)===job){jobs.delete(el);job.revert();}}
    });
    jobs.set(el,job);
  }
  const ready=import('../assets/vendor/animejs/anime.esm.min.js').then(module=>{
    animate=module.animate;return true;
  }).catch(()=>false); // Failed/offline import must never block a control or hide content.
  window.CapMotion=Object.freeze({reveal,cancel,reduced,ready,activeCount:()=>jobs.size});
  const settle=()=>{if(document.hidden||reduced())cancel();};
  document.addEventListener('visibilitychange',settle);
  addEventListener('pagehide',()=>cancel());
  if(media.addEventListener)media.addEventListener('change',settle);
  else media.addListener(settle); // Older iOS WebViews.
  new MutationObserver(()=>{
    if(!jobs.size)return;
    if(reduced()){cancel();return;}
    for(const [el] of jobs)if(!el.isConnected||el.closest('[hidden]'))cancel(el);
  }).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});
})();
