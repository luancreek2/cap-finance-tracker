function toast(m,ok){document.querySelectorAll('.toast').forEach(x=>x.remove());const e=document.createElement('div');e.className='toast';e.setAttribute('role','status');if(ok)e.insertAdjacentHTML('beforeend','<svg class="tk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>');e.appendChild(document.createTextNode(m));document.body.appendChild(e);setTimeout(()=>e.classList.add('x'),2000);setTimeout(()=>e.remove(),2350)}
function fx(){const a=$('#app');a.classList.add('fx');clearTimeout(window._fx);window._fx=setTimeout(()=>a.classList.remove('fx'),800)}
function pageAnim(){const k=tab+'|'+(tab=='Plan'?pt:''),a=$('#app');if(window._pk!==k){window._pk=k;const sn=window._seen=window._seen||{},re=sn[k];sn[k]=1;a.classList.remove('pg','pg2');void a.offsetWidth;a.classList.add(re?'pg2':'pg');if(!re)fx()}if(window._fl){const e=document.querySelector(`[data-tx="${window._fl}"]`);if(e)e.classList.add('new');window._fl=0}}
const flash=id=>{window._fl=id};
/* ---- One stable modal shell: #sheet (dimmed backdrop + blur) > #sb (the container) > #sv (the
   animated view). The backdrop and the container are built once. Moving between screens only
   swaps #sv and resizes #sb, so the background never fades out and back in, the modal never
   re-centres, and the container never jumps: the top edge is what animates. ---- */
const SV_MS=300,        /* container resize */
      SV_OUT=150,       /* current view leaving */
      SV_IN=250,        /* new view arriving */
      SV_EASE='cubic-bezier(.32,.72,.28,1)';
let SVKEY='';           /* which screen #sv currently shows */
const SVSC={},          /* per-screen scroll positions */
      SVKEEP={};        /* screens whose scroll we restore when coming back */
/* Drop every inline style the navigator set, so the shell is back to its stylesheet defaults. */
function svSettle(sb){
  sb=sb||$('#sb');if(!sb)return;
  const sv=sb.firstElementChild;
  if(sv){sv.style.transition='';sv.style.opacity='';sv.style.transform=''}
  sb.style.transition='';sb.style.height='';sb.style.overflow='';
}
/* Update the content of the screen that is already open (the payment-history year filter) and
   let the container glide to the new height instead of snapping. Keeps its own timer and bails
   out if a screen swap takes over, so it can never fight navS(). */
function svGlide(sb,apply,ms){
  if(!sb)return;
  ms=ms||220;
  const h0=Math.round(sb.offsetHeight);
  sb.style.transition='none';sb.style.height=h0+'px';sb.style.overflow='hidden';
  apply();
  sb.style.height='auto';
  const target=Math.round(sb.offsetHeight);
  if(Math.abs(target-h0)<2){                       /* nothing to glide: paint and stay unlocked */
    clearTimeout(window._nr);window._nr=0;
    sb.style.transition='';sb.style.height='';sb.style.overflow='';
    return;
  }
  sb.style.height=h0+'px';void sb.offsetHeight;
  sb.style.transition='height '+ms+'ms '+SV_EASE;
  sb.style.height=target+'px';
  clearTimeout(window._nr);
  window._nr=setTimeout(()=>{window._nr=0;if(window._navBusy)return;sb.style.transition='';sb.style.height='';sb.style.overflow=''},ms+140);
}
/* Hold a restored scroll position while the container is still resizing, so an intermediate
   height can never clamp it back to the top. Short-lived and cheap: one property write per frame. */
function svHold(want,ms){
  if(!(want>0))return;
  window._svWant=want;window._svUntil=performance.now()+ms+140;
  if(window._svRaf)return;
  const tick=()=>{
    window._svRaf=0;
    const sb=$('#sb');
    if(!sb||window._svWant<0)return;
    if(sb.scrollTop!==window._svWant)sb.scrollTop=window._svWant;
    if(performance.now()<window._svUntil)window._svRaf=requestAnimationFrame(tick);
    else window._svWant=-1;
  };
  window._svRaf=requestAnimationFrame(tick);
}
function openS(h){
  clearTimeout(window._cl);clearTimeout(window._nt);clearTimeout(window._nr);window._nr=0;
  const e=$('#sheet'),sb=$('#sb');if(!e||!sb)return;
  svSettle(sb);
  SVKEY=window._svKey||'';window._svKey='';
  document.body.classList.add('sheet-open');
  e.classList.remove('closing','st');
  sb.innerHTML='<div id="sv">'+h+'</div>';
  sb.scrollTop=0;
  e.classList.add('open');
}
function closeS(){
  const e=$('#sheet');if(!e||!e.classList.contains('open'))return;
  clearTimeout(window._cl);clearTimeout(window._nt);
  e.classList.add('closing');
  window._cl=setTimeout(()=>{e.classList.remove('open','closing');document.body.classList.remove('sheet-open');svSettle($('#sb'))},200);
}
/* Bundled payment-confirmation chime. Decoded once, then played sample-accurately so
   the sound lands the moment you tap Pay. Sound defaults on; Settings can mute it. */
const PAY_SOUND_URL='assets/media/payment-confirm.mp3';
let payBuf=null,payCtx=null,payStart=0,payEnd=0,payLoading=0;
function sndOn(){try{return S.snd!=0}catch(_){return true}}
function hapOn(){try{return S.hap!=0}catch(_){return true}}
/* Haptics are a nicety: unsupported devices and muted settings are simply ignored. */
function vib(p){if(!hapOn())return;try{navigator.vibrate&&navigator.vibrate(p)}catch(_){}}
function decodeClip(ctx,ab){return new Promise((res,rej)=>{const p=ctx.decodeAudioData(ab,res,rej);if(p&&p.then)p.then(res,rej);});}
function primePaymentSound(){
  try{
    if(payBuf||payLoading)return;
    const OCTX=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    if(!OCTX)return;
    payLoading=1;
    fetch(PAY_SOUND_URL).then(r=>r.ok?r.arrayBuffer():Promise.reject()).then(b=>decodeClip(new OCTX(1,1,48000),b)).then(buf=>{
      const d=buf.getChannelData(0),sr=buf.sampleRate,n=d.length,win=Math.max(1,Math.round(sr*0.01)),env=[];
      let peak=0;
      for(let i=0;i<n;i+=win){let m=0;for(let j=i;j<Math.min(i+win,n);j++){const v=Math.abs(d[j]);if(v>m)m=v;}env.push(m);if(m>peak)peak=m;}
      const thr=Math.max(0.02,peak*0.06),first=env.findIndex(v=>v>thr);
      let last=-1;
      for(let i=env.length-1;i>=0;i--){if(env[i]>thr){last=i;break;}}
      // The source clip has dead air before and after the chime; trim it so playback is instant.
      if(first>1)payStart=first*0.01;
      payEnd=last>=first?(last+1)*0.01:buf.duration;
      payBuf=buf;
    }).catch(()=>{}).then(()=>{payLoading=0;});
  }catch(_){/* Audio may be unavailable; payments must still work. */}
}
function playPaymentConfirmation(){
  vib([12,32,18]);
  if(!sndOn())return;
  try{
    primePaymentSound();
    if(!payBuf)return;
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return;
    payCtx=payCtx||new AC();
    if(payCtx.state==='suspended')payCtx.resume();
    const src=payCtx.createBufferSource(),g=payCtx.createGain();
    src.buffer=payBuf;g.gain.value=1;src.connect(g);g.connect(payCtx.destination);
    src.start(payCtx.currentTime,payStart,Math.max(0.05,(payEnd||payBuf.duration)-payStart));
  }catch(_){/* Payment must still complete if sound is blocked or unsupported. */}
}
document.addEventListener('click',e=>{const m=$('#km');if(m&&!e.target.closest('#km'))m.classList.remove('open')});


function initGlobalNoSelection() {

/* Blocks selection start, long-press menus and drags on all non-editable UI.
   Typing, selecting and copying inside inputs / textareas / editable content is untouched. */
(function(){
  if(window.__noselAll)return;window.__noselAll=1;
  const EDIT='input,textarea,select,[contenteditable]:not([contenteditable="false"])';
  const el=n=>n&&(n.nodeType===1?n:n.parentElement);
  const ui=n=>{const e=el(n);return !!(e&&!(e.closest&&e.closest(EDIT)));};
  const block=e=>{if(ui(e.target))e.preventDefault();};
  document.addEventListener('selectstart',block,true);
  document.addEventListener('contextmenu',block,true);
  document.addEventListener('dragstart',block,true);
  /* iOS: a long press can start a selection before selectstart is cancelled - drop it right away */
  document.addEventListener('selectionchange',function(){
    const s=window.getSelection&&getSelection();
    if(!s||s.isCollapsed||!s.rangeCount)return;
    const a=el(s.anchorNode),f=el(s.focusNode),ae=document.activeElement;
    if(ae&&/^(INPUT|TEXTAREA)$/.test(ae.tagName))return;        // selection inside a field
    if((a&&a.closest&&a.closest(EDIT))||(f&&f.closest&&f.closest(EDIT)))return;
    if(a&&a.closest&&a.closest('[contenteditable]:not([contenteditable="false"])'))return;
    s.removeAllRanges();
  });
})();

}


function initPullToRefresh() {

/* ===== Cap pull-to-refresh: native-feeling, data-safe (never reloads the page) ===== */
(function () {
  "use strict";
  const THRESH = 58, MAX = 120, HOLD = 52, SLOP = 8, SIZE = 40;
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const st = document.createElement("style");
  st.textContent =
    "html,body{overscroll-behavior-y:contain}" + // stop the browser's own pull-to-refresh / bounce chaining
    "#cap-ptr{position:fixed;left:50%;top:0;z-index:6;width:" + SIZE + "px;height:" + SIZE + "px;margin-left:-" + SIZE / 2 + "px;border-radius:50%;display:grid;place-items:center;color:#8a8a8e;background:none;border:0;box-shadow:none;opacity:0;pointer-events:none;will-change:transform,opacity;transform:translate3d(0,-60px,0) scale(.5)}" +
    "#cap-ptr svg{grid-area:1/1;width:26px;height:26px;transition:opacity .2s,transform .25s}" +
    "#cap-ptr .ring{transform-origin:50% 50%}" +
    "#cap-ptr .off{opacity:0;transform:scale(.6)}" +
    "#cap-ptr[data-s=spin] .ring,#cap-ptr[data-s=ok] .ring{animation:capPtrSpin .9s linear infinite}" +
    "#cap-ptr[data-s=off] .ring{opacity:0}" +
    "#cap-ptr[data-s=off] .off{opacity:1;transform:none}" +
    "@keyframes capPtrSpin{to{transform:rotate(360deg)}}" +
    "#app.cap-ptr-anim{transition:transform .38s cubic-bezier(.2,.8,.2,1)}" +
    "#cap-ptr.cap-ptr-anim{transition:transform .38s cubic-bezier(.2,.8,.2,1),opacity .3s}";
  document.head.appendChild(st);

  const el = document.createElement("div");
  el.id = "cap-ptr";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><g class="ring"><line class="b" x1="12" y1="6.4" x2="12" y2="2.6" transform="rotate(0 12 12)" stroke-opacity="1"/><line class="b" x1="12" y1="6.4" x2="12" y2="2.6" transform="rotate(-45 12 12)" stroke-opacity=".85"/><line class="b" x1="12" y1="6.4" x2="12" y2="2.6" transform="rotate(-90 12 12)" stroke-opacity=".7"/><line class="b" x1="12" y1="6.4" x2="12" y2="2.6" transform="rotate(-135 12 12)" stroke-opacity=".56"/><line class="b" x1="12" y1="6.4" x2="12" y2="2.6" transform="rotate(-180 12 12)" stroke-opacity=".44"/><line class="b" x1="12" y1="6.4" x2="12" y2="2.6" transform="rotate(-225 12 12)" stroke-opacity=".34"/><line class="b" x1="12" y1="6.4" x2="12" y2="2.6" transform="rotate(-270 12 12)" stroke-opacity=".26"/><line class="b" x1="12" y1="6.4" x2="12" y2="2.6" transform="rotate(-315 12 12)" stroke-opacity=".2"/></g></svg>' +
    '<svg class="off" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8a15 15 0 0 0-9.3-3.7M5 12.5a10 10 0 0 1 3.1-2M19 12.5a10 10 0 0 0-3-2M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r=".6" fill="#f59e0b"/><path d="M3 3l18 18"/></svg>';
  document.body.appendChild(el);
  const ring = el.querySelector(".ring"), bars = Array.from(el.querySelectorAll(".b")), base = bars.map((b) => +b.getAttribute("stroke-opacity"));
  const showBars = (n) => bars.forEach((b, i) => { b.style.strokeOpacity = n === null ? "" : Math.max(0, Math.min(1, n - i)) * base[i]; });

  let gap = 0, top0 = 0, busy = false, raf = 0, pull = 0, cooldown = 0;
  const app = () => document.getElementById("app");
  const scrollTop = () => (document.scrollingElement || root).scrollTop;

  function navBottom() {
    const n = document.querySelector("nav");
    return n ? Math.max(0, n.getBoundingClientRect().bottom) : 0;
  }
  function paint(p, animate) {
    pull = p;
    const a = app();
    if (animate) { a.classList.add("cap-ptr-anim"); el.classList.add("cap-ptr-anim"); }
    else { a.classList.remove("cap-ptr-anim"); el.classList.remove("cap-ptr-anim"); }
    a.style.transform = p > 0.5 ? "translate3d(0," + p + "px,0)" : "";
    const prog = Math.min(1, p / THRESH);
    const y = top0 + Math.max(0, p / 2 - SIZE / 2);
    el.style.opacity = Math.min(1, p / 26);
    el.style.transform = "translate3d(0," + (p > 0 ? y : y - 30) + "px,0) scale(" + (0.55 + 0.45 * Math.min(1, p / 40)) + ")";
    if (el.dataset.s !== "spin" && el.dataset.s !== "ok") showBars(prog * 8);
  }
  function schedule(p) { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => paint(p, false)); }
  const rubber = (dy) => MAX * (1 - Math.exp(-dy / (MAX * 1.2)));

  function settle() {
    cancelAnimationFrame(raf);
    paint(0, true);
    setTimeout(() => {
      if (busy) return;
      el.dataset.s = "";
      el.style.opacity = 0;
      const a = app(); a.style.transform = ""; a.classList.remove("cap-ptr-anim");
      el.classList.remove("cap-ptr-anim");
      ring.style.transform = ""; showBars(0);
    }, 420);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function refresh() {
    if (busy) return;
    busy = true;
    el.dataset.s = "spin";
    ring.style.transform = ""; showBars(null);
    paint(HOLD, true);
    try { navigator.vibrate && navigator.vibrate(8); } catch (e) {}
    let msg = "", state = "ok";
    const t0 = Date.now();
    try {
      if (!navigator.onLine) {
        state = "off"; msg = "You're offline — showing your saved data. Changes will sync when you're back online.";
      } else {
        // Check for a newer app version (service worker), and sync pending changes with the cloud if connected.
        try { navigator.serviceWorker && navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {}); } catch (e) {}
        if (window.CapOff) {
          await Promise.race([CapOff.sync(), sleep(12000)]);
          const s = CapOff.status();
          if (s.cloud && s.status === "error") { state = "off"; msg = "Couldn't sync right now — your changes are safe on this device and will retry."; }
          else msg = "";
        } else msg = "";
        try { render(); } catch (e) {} // redraw from the stored data (nothing is reloaded or erased)
      }
    } catch (e) { state = "off"; msg = "Couldn't refresh — your data is safe."; }
    const left = 650 - (Date.now() - t0);
    if (left > 0) await sleep(left); // let the spinner be seen
    el.dataset.s = state;
    await sleep(state === "off" ? 900 : 550);
    busy = false;
    cooldown = Date.now() + 600;
    settle();
  }

  /* ---------- eligibility ---------- */
  const BLOCK = 'input,textarea,select,[contenteditable],#sheet,#pop,.fab,#chw,#calwrap,.goal-card,.sw-c,.sw';
  function blockedBy(t) {
    if (!(t instanceof Element)) return true;
    if (t.closest(BLOCK)) return true;
    if (document.body.classList.contains("sheet-open")) return true;
    const sh = document.getElementById("sheet"), pp = document.getElementById("pop");
    if ((sh && sh.classList.contains("open")) || (pp && pp.classList.contains("open"))) return true;
    for (let n = t; n && n !== document.body && n !== root; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 2) return true; // horizontal scroller (tabs, carousels)
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2 && n.scrollTop > 0) return true;
    }
    return false;
  }

  /* ---------- touch (iPhone, iPad, Android) ---------- */
  let sx = 0, sy = 0, mode = 0; // 0 idle, 1 tracking, 2 pulling, -1 ignore
  addEventListener("touchstart", (e) => {
    mode = 0;
    if (busy || e.touches.length !== 1 || Date.now() < cooldown) { mode = -1; return; }
    if (scrollTop() > 0 || blockedBy(e.target)) { mode = -1; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; mode = 1; top0 = navBottom();
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (mode < 1) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY, dx = x - sx, dy = y - sy;
    if (mode === 1) {
      if (scrollTop() > 0) { mode = -1; return; }
      if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy) * 0.7) { mode = -1; return; } // sideways swipe
      if (dy < -SLOP) { mode = -1; return; } // scrolling down the page
      if (dy < SLOP || dy < Math.abs(dx) * 1.5) return; // not clearly a downward pull yet
      mode = 2; sy = y - SLOP; // start the pull from here so it doesn't jump
    }
    if (mode === 2) {
      const d = y - sy;
      if (d <= 0) { schedule(0); return; }
      if (e.cancelable) e.preventDefault(); // blocks browser pull-to-refresh / iOS rubber-band while we own the gesture
      const p = rubber(d);
      el.dataset.s = p >= THRESH ? "ready" : "";
      if (p >= THRESH && !el._r) { el._r = 1; try { navigator.vibrate && navigator.vibrate(6); } catch (_) {} }
      if (p < THRESH) el._r = 0;
      schedule(p);
    }
  }, { passive: false });
  function end() {
    const was = mode; mode = 0; el._r = 0;
    if (was !== 2) return;
    if (pull >= THRESH) refresh(); else settle();
  }
  addEventListener("touchend", end, { passive: true });
  addEventListener("touchcancel", () => { if (mode === 2) { mode = 0; settle(); } else mode = 0; }, { passive: true });

  /* ---------- desktop trackpad (two-finger pull at the top of the page) ---------- */
  let acc = 0, wt = 0, wlast = 0;
  addEventListener("wheel", (e) => {
    if (busy || Date.now() < cooldown) return;
    const t = Date.now();
    if (e.deltaY >= 0 || scrollTop() > 0 || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { if (acc) { acc = 0; settle(); } return; }
    if (Math.abs(e.deltaY) >= 60 && e.deltaMode === 0 && !acc) return; // a notched mouse wheel, not a trackpad
    if (blockedBy(e.target)) return;
    if (!acc) top0 = navBottom();
    acc = Math.min(acc - e.deltaY, 420);
    wlast = t;
    const p = rubber(acc * 0.9);
    el.dataset.s = p >= THRESH ? "ready" : "";
    schedule(p);
    clearTimeout(wt);
    wt = setTimeout(() => {
      const go = pull >= THRESH; acc = 0;
      if (go) refresh(); else settle();
    }, 140);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
})();


}


bindStaticEvents();
CapOff.init({ get: () => S, set: (value) => (S = value) });
CapOff.boot();
initUiEnhancements();
initTransactionV2();
initCardAnimations();
initTransactionNoSelection();
initGlobalNoSelection();
initPullToRefresh();
primePaymentSound();
try{stBoot()}catch(e){}
