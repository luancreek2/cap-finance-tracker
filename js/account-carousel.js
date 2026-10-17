/* Recycle real card elements, not clones: every account keeps one set of controls. */
let accountCarouselCleanups=[];
function accountViewSelect(view){if(!['all','carousel'].includes(view))return;S.accountView=view;render()}
function accountCarouselMarkup(accounts,title){return `<section class="account-carousel" tabindex="0" aria-label="${esc(title)}. Use arrow keys to browse."><div class="account-carousel-track">${accounts.map(a=>`<div class="account-carousel-slide"><div class="account-carousel-tilt">${cardH(a,1)}</div></div>`).join('')}</div></section>`}
function initAccountCarousels(){
  accountCarouselCleanups.forEach(fn=>fn());accountCarouselCleanups=[];
  document.querySelectorAll('.account-carousel').forEach(viewport=>{
    const track=viewport.firstElementChild,controller=new AbortController(),signal=controller.signal;
    let offset=0,step=1,loop=false,maxOffset=0,velocity=0,frame=0,lastFrame=0,gesture=null,suppressUntil=0;
    const reduced=()=>S.rm===1||S.anim===0||matchMedia('(prefers-reduced-motion:reduce)').matches;
    const listen=(el,type,fn,options={})=>el.addEventListener(type,fn,{...options,signal});
    const stop=()=>{cancelAnimationFrame(frame);frame=0;velocity=0};
    const resetTilt=()=>track.querySelectorAll('.account-carousel-tilt').forEach(el=>{el.style.transform='';el.classList.remove('hovering')});
    function paint(){
      if(loop){
        while(offset>=step){track.append(track.firstElementChild);offset-=step}
        while(offset<0){track.prepend(track.lastElementChild);offset+=step}
      }else offset=Math.max(0,Math.min(maxOffset,offset));
      track.style.transform=`translate3d(${-offset}px,0,0)`;
    }
    function coast(now){const dt=Math.min(32,now-lastFrame);lastFrame=now;offset+=velocity*dt;velocity*=Math.pow(.92,dt/16);paint();if(Math.abs(velocity)>.015&&!reduced())frame=requestAnimationFrame(coast)}
    listen(viewport,'pointerdown',e=>{
      if(e.button!==0||!e.isPrimary||e.target.closest('button,a,input'))return;
      stop();resetTilt();suppressUntil=0;gesture={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,time:performance.now(),drag:false};
    });
    listen(viewport,'pointermove',e=>{
      if(!gesture){
        if(e.pointerType!=='mouse'||reduced())return;
        const el=e.target.closest('.account-carousel-tilt');if(!el||el.querySelector('.is-flipped'))return;
        const r=el.parentElement.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
        el.style.transform=`perspective(1000px) rotateX(${y*12}deg) rotateY(${-x*16}deg) scale(1.02)`;el.classList.add('hovering');return;
      }
      if(gesture.id!==e.pointerId)return;
      if(!gesture.drag){
        const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;
        if(Math.max(Math.abs(dx),Math.abs(dy))<11)return;
        if(Math.abs(dy)>Math.abs(dx)){gesture=null;return}
        gesture.drag=true;viewport.setPointerCapture(e.pointerId);viewport.classList.add('dragging');
      }
      e.preventDefault();const now=performance.now(),delta=gesture.lastX-e.clientX;
      velocity=Math.max(-3,Math.min(3,delta/Math.max(1,now-gesture.time)));offset+=delta;paint();gesture.lastX=e.clientX;gesture.time=now;
    });
    function end(e){
      if(!gesture||gesture.id!==e.pointerId)return;
      const drag=gesture.drag,glide=drag&&e.type==='pointerup'&&performance.now()-gesture.time<100;
      gesture=null;viewport.classList.remove('dragging');if(drag)suppressUntil=performance.now()+600;
      if(viewport.hasPointerCapture(e.pointerId))viewport.releasePointerCapture(e.pointerId);
      if(glide&&!reduced()){lastFrame=performance.now();frame=requestAnimationFrame(coast)}else stop();
    }
    listen(window,'pointerup',end);listen(window,'pointercancel',end);
    // Capture at window before the existing document-level flip/click handlers.
    listen(window,'click',e=>{if(viewport.contains(e.target)&&performance.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation()}},{capture:true});
    listen(viewport,'pointerleave',resetTilt);
    listen(viewport,'dragstart',e=>e.preventDefault());
    listen(viewport,'keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key)||e.target.closest('button'))return;e.preventDefault();stop();offset+=(e.key==='ArrowRight'?1:-1)*step;paint();viewport.focus({preventScroll:true})});
    listen(viewport,'wheel',e=>{if(Math.abs(e.deltaX)<=Math.abs(e.deltaY))return;e.preventDefault();stop();resetTilt();offset+=e.deltaX;paint()},{passive:false});
    listen(viewport,'focusin',e=>{const slide=e.target.closest('.account-carousel-slide');if(slide){stop();if(loop){while(track.firstElementChild!==slide)track.append(track.firstElementChild);offset=0}else offset=[...track.children].indexOf(slide)*step;paint()}});
    function layout(){
      stop();resetTilt();
      const width=viewport.clientWidth,columns=Math.max(1,Math.round(width/360));
      const cardWidth=columns===1?Math.min(350,width*.9):(width-(columns-1)*16)/columns;
      viewport.style.setProperty('--carousel-card-width',cardWidth+'px');step=cardWidth+16;
      const total=track.children.length*step-16;
      loop=total>=width+step-.5;maxOffset=Math.max(0,total-width);offset=0;paint();
    }
    const resize=new ResizeObserver(layout);resize.observe(viewport);layout();
    accountCarouselCleanups.push(()=>{stop();resize.disconnect();controller.abort()});
  });
}
