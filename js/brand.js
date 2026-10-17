/* Shared brand artwork. Scoped SVG IDs allow several previews on the same page. */
let capLogoID=0;
function capLogoSVG(dark=false){
  const id='cap-logo-'+(++capLogoID),ink=dark?'#fff':'#000';
  return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><filter id="${id}-shadow"><feGaussianBlur in="SourceAlpha" stdDeviation="3.5"/><feOffset dy="2.5"/><feComponentTransfer><feFuncA type="linear" slope=".35"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter><radialGradient id="${id}-core" cx="40%" cy="40%"><stop stop-color="#fff" stop-opacity=".6"/><stop offset="40%" stop-color="#fff" stop-opacity=".1"/><stop offset="100%" stop-color="#000" stop-opacity=".15"/></radialGradient><linearGradient id="${id}-sheen"><stop stop-color="#fff" stop-opacity="0"/><stop offset="30%" stop-color="#fff" stop-opacity=".4"/><stop offset="70%" stop-color="#fff" stop-opacity=".4"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><circle cx="60" cy="60" r="56.3" fill="none" stroke="${ink}" stroke-width="3" opacity=".07" filter="url(#${id}-shadow)"/><g fill="none" stroke="${ink}"><circle cx="60" cy="60" r="56" stroke-width="2.4"/><circle cx="60" cy="60" r="47" stroke-width="1.6" opacity=".6"/><circle cx="60" cy="60" r="38" stroke-width="1" opacity=".3"/><circle cx="60" cy="60" r="52" stroke-width=".8" opacity=".3"/><circle cx="60" cy="60" r="43" stroke-width=".8" opacity=".25"/></g><g fill="none"><circle cx="60" cy="60" r="56" stroke="url(#${id}-sheen)" stroke-width="2.4" opacity=".6"/><circle cx="60" cy="60" r="47" stroke="#fff" stroke-width="1.4" opacity=".35"/><circle cx="60" cy="60" r="38" stroke="#fff" stroke-width=".9" opacity=".2"/></g><circle cx="60" cy="60" r="8.2" fill="${ink}" opacity=".1"/><circle cx="60" cy="60" r="7" fill="${ink}" opacity=".9"/><circle cx="60" cy="60" r="7" fill="url(#${id}-core)"/><ellipse cx="59" cy="56" rx="2.5" ry="1.8" fill="#fff" opacity=".7"/><g fill="${ink}" opacity=".4"><circle cx="60" cy="8" r="1.2"/><circle cx="112" cy="60" r="1.2"/><circle cx="60" cy="112" r="1.2"/><circle cx="8" cy="60" r="1.2"/></g></svg>`;
}
function capLogoStyleResolved(){
  if(typeof S!='undefined'&&(S.logoStyle=='light'||S.logoStyle=='dark'))return S.logoStyle;
  const t=(typeof S!='undefined'&&S.theme)||'auto';
  return t=='dark'||(t!='light'&&matchMedia('(prefers-color-scheme:dark)').matches)?'dark':'light';
}
function capBrandLogo(style){const chosen=style||capLogoStyleResolved();return `<span class="cap-brand-logo cap-brand-${chosen=='dark'?'dark':'light'}" role="img" aria-label="Cap logo">${capLogoSVG(chosen=='dark')}</span>`}
function capLogoChoices(){const selected=capLogoStyleResolved();return `<div class="st-grp eyebrow">Logo style</div><div class="cap-logo-choices">${['light','dark'].map(style=>`<button type="button" aria-pressed="${selected==style}" onclick="setCapLogo('${style}')">${capBrandLogo(style)}<b>${style=='light'?'Light':'Dark'}</b></button>`).join('')}</div><p class="st-note">Used for the logo inside Cap. The launch animation follows your theme; the installed app uses the light icon.</p>`}
function setCapLogo(style){if(!['light','dark'].includes(style))return;S.logoStyle=style;save();stGo('appearance',1)}

/* Runs before the app scripts: resolve saved theme before the first frame. */
(function(){
  let prefs={};try{prefs=JSON.parse(localStorage.getItem('pera')||'{}')||{}}catch(_){}
  const dark=prefs.theme=='dark'||(prefs.theme!='light'&&matchMedia('(prefers-color-scheme:dark)').matches);
  let locked=false;try{locked=!!(JSON.parse(localStorage.getItem('cap_lock')||'{}')||{}).pin}catch(_){}
  const reduced=prefs.anim===0||prefs.rm===1||locked||matchMedia('(prefers-reduced-motion:reduce)').matches;
  document.documentElement.dataset.theme=dark?'dark':'light';
  window.capLaunchActive=true;
  const overlay=document.createElement('div');overlay.id='cap-launch';overlay.className=(dark?'launch-dark':'launch-light')+(reduced?' launch-reduced':'');overlay.setAttribute('role','status');overlay.setAttribute('aria-label','Opening Cap');
  overlay.innerHTML=`<div class="cap-launch-art"><i class="cap-launch-ring ring-one"></i><i class="cap-launch-ring ring-two"></i><i class="cap-launch-ring ring-three"></i><div class="cap-launch-logo">${capLogoSVG(dark)}</div></div><div class="cap-launch-dots" aria-hidden="true"><i></i><i></i><i></i></div>`;
  document.body.append(overlay);
  const started=performance.now();let done=false;
  function finish(){if(done)return;done=true;overlay.classList.add('launch-exit');setTimeout(()=>{overlay.remove();window.capLaunchActive=false;document.dispatchEvent(new Event('cap:launch-complete'))},reduced?120:300)}
  function ready(){const elapsed=performance.now()-started;if(elapsed>=8000||(document.querySelector('#app')?.children.length&&elapsed>=(reduced?150:2500))){finish();return}setTimeout(ready,80)}
  ready();
})();
