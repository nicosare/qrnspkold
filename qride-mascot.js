/* QRide mascot motion engine.
 * The shell remains untouched; only the two solid SVG eye paths and small
 * in-screen effects are animated. The cycle starts automatically.
 */
(() => {
  'use strict';

  const icon = document.querySelector('.start-brand-icon');
  if (!icon) return;

  const nodes = {
    left: icon.querySelector('#qrideEyeLeft'),
    right: icon.querySelector('#qrideEyeRight'),
    scan: icon.querySelector('#qrideScanBeam'),
    ball: icon.querySelector('#qridePongBall'),
    ring: icon.querySelector('#qridePulseRing')
  };
  if (!nodes.left || !nodes.right || !nodes.scan || !nodes.ball || !nodes.ring) return;

  const DURATION = 3600;
  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const baseEye = {
    left:  { cx:185, cy:256, rx:34, ry:46, rot:0, smile:0 },
    right: { cx:327, cy:256, rx:34, ry:46, rot:0, smile:0 }
  };
  const baseFx = {
    scan: { opacity:0, y:252, height:5 },
    ball: { opacity:0, x:376, y:256, r:3 },
    ring: { opacity:0, rx:20, ry:20, width:7 }
  };
  const baseState = {
    left:{...baseEye.left}, right:{...baseEye.right},
    fx:{
      scan:{...baseFx.scan},
      ball:{...baseFx.ball},
      ring:{...baseFx.ring}
    }
  };

  const key = (at, left = {}, right = {}, fx = {}) => ({
    at,
    state:{
      left:{...baseEye.left,...left},
      right:{...baseEye.right,...right},
      fx:{
        scan:{...baseFx.scan,...(fx.scan || {})},
        ball:{...baseFx.ball,...(fx.ball || {})},
        ring:{...baseFx.ring,...(fx.ring || {})}
      }
    }
  });

  const animations = {
    look:[
      key(0),
      key(.13,{cx:194,cy:250,rx:35,ry:45},{cx:336,cy:250,rx:35,ry:45}),
      key(.29,{cx:207,cy:254,rx:34,ry:44},{cx:349,cy:254,rx:34,ry:44}),
      key(.43,{cx:207,cy:254,rx:32,ry:43},{cx:349,cy:254,rx:32,ry:43}),
      key(.58,{cx:174,cy:248,rx:35,ry:45},{cx:316,cy:248,rx:35,ry:45}),
      key(.73,{cx:180,cy:258,rx:34,ry:43},{cx:322,cy:258,rx:34,ry:43}),
      key(.81,{cy:256,ry:4},{cy:256,ry:4}),
      key(.90,{cy:251,ry:49},{cy:251,ry:49}),
      key(1)
    ],
    loading:[
      key(0),
      key(.12,{cx:205,cy:250,rx:27,ry:35},{cx:307,cy:262,rx:27,ry:35}),
      key(.25,{cx:232,cy:228,rx:16,ry:19},{cx:280,cy:284,rx:16,ry:19}),
      key(.40,{cx:279,cy:230,rx:14,ry:17},{cx:233,cy:282,rx:14,ry:17}),
      key(.55,{cx:279,cy:280,rx:14,ry:17},{cx:233,cy:232,rx:14,ry:17}),
      key(.69,{cx:230,cy:282,rx:16,ry:19},{cx:282,cy:230,rx:16,ry:19}),
      key(.81,{cx:214,cy:256,rx:22,ry:27},{cx:298,cy:256,rx:22,ry:27}),
      key(.91,{cx:180,cy:256,rx:36,ry:48},{cx:332,cy:256,rx:36,ry:48}),
      key(1)
    ],
    pong:[
      key(0),
      key(.12,{cx:111,cy:256,rx:8,ry:39},{cx:401,cy:256,rx:8,ry:39},{ball:{opacity:.35,x:376,y:256,r:4}}),
      key(.23,{cx:111,cy:238,rx:8,ry:39},{cx:401,cy:274,rx:8,ry:39},{ball:{opacity:1,x:340,y:232,r:10}}),
      key(.39,{cx:111,cy:274,rx:8,ry:39},{cx:401,cy:236,rx:8,ry:39},{ball:{opacity:1,x:150,y:286,r:10}}),
      key(.55,{cx:111,cy:244,rx:8,ry:39},{cx:401,cy:268,rx:8,ry:39},{ball:{opacity:1,x:365,y:218,r:10}}),
      key(.71,{cx:111,cy:268,rx:8,ry:39},{cx:401,cy:244,rx:8,ry:39},{ball:{opacity:1,x:150,y:250,r:10}}),
      key(.83,{cx:111,cy:256,rx:8,ry:39},{cx:401,cy:256,rx:8,ry:39},{ball:{opacity:1,x:330,y:256,r:9}}),
      key(.94,{cx:180,cy:256,rx:35,ry:45},{cx:332,cy:256,rx:35,ry:45},{ball:{opacity:0,x:330,y:256,r:2}}),
      key(1)
    ],
    scan:[
      key(0),
      key(.12,{cy:250,ry:10},{cy:250,ry:10},{scan:{opacity:.82,y:168,height:5}}),
      key(.31,{cy:224,ry:9},{cy:224,ry:9},{scan:{opacity:.82,y:224,height:5}}),
      key(.50,{cy:256,ry:8},{cy:256,ry:8},{scan:{opacity:.82,y:292,height:5}}),
      key(.68,{cy:288,ry:9},{cy:288,ry:9},{scan:{opacity:.82,y:342,height:5}}),
      key(.81,{cy:256,ry:13},{cy:256,ry:13},{scan:{opacity:.35,y:252,height:4}}),
      key(1)
    ],
    happy:[
      key(0),
      key(.13,{cy:249,ry:35,smile:.42},{cy:249,ry:35,smile:.42}),
      key(.27,{cy:247,ry:25,smile:1},{cy:247,ry:25,smile:1}),
      key(.46,{cy:241,ry:24,smile:1},{cy:241,ry:24,smile:1}),
      key(.58,{cy:250,ry:27,smile:.88},{cy:250,ry:27,smile:.88}),
      key(.70,{cy:244,ry:24,smile:1},{cy:244,ry:24,smile:1}),
      key(.84,{cy:256,ry:37,smile:.35},{cy:256,ry:37,smile:.35}),
      key(1)
    ],
    curious:[
      key(0),
      key(.15,{cx:180,cy:249,rx:42,ry:54},{cx:333,cy:253,rx:35,ry:15,rot:-7}),
      key(.34,{cx:180,cy:249,rx:42,ry:54},{cx:333,cy:253,rx:35,ry:15,rot:-7}),
      key(.49,{cx:190,cy:248,rx:39,ry:50},{cx:319,cy:251,rx:36,ry:28,rot:-2}),
      key(.63,{cx:197,cy:251,rx:35,ry:45},{cx:309,cy:251,rx:37,ry:38,rot:2}),
      key(.78,{cx:185,cy:256,rx:34,ry:46},{cx:327,cy:256,rx:34,ry:46}),
      key(1)
    ],
    pulse:[
      key(0),
      key(.15,{cx:207,cy:256,rx:31,ry:39},{cx:305,cy:256,rx:31,ry:39}),
      key(.29,{cx:231,cy:256,rx:27,ry:30},{cx:281,cy:256,rx:27,ry:30}),
      key(.41,{cx:247,cy:256,rx:28,ry:13},{cx:265,cy:256,rx:28,ry:13},{ring:{opacity:.78,rx:62,ry:62,width:7}}),
      key(.53,{cx:247,cy:256,rx:13,ry:42},{cx:265,cy:256,rx:13,ry:42},{ring:{opacity:.48,rx:112,ry:92,width:5}}),
      key(.67,{cx:235,cy:256,rx:22,ry:29},{cx:277,cy:256,rx:22,ry:29},{ring:{opacity:.22,rx:174,ry:135,width:3}}),
      key(.82,{cx:180,cy:256,rx:36,ry:48},{cx:332,cy:256,rx:36,ry:48},{ring:{opacity:0,rx:190,ry:145,width:2}}),
      key(1)
    ],
    shock:[
      key(0),
      key(.12,{cy:249,rx:41,ry:55},{cy:249,rx:41,ry:55}),
      key(.25,{cy:246,rx:43,ry:58},{cy:246,rx:43,ry:58}),
      key(.38,{cy:260,rx:31,ry:39},{cy:260,rx:31,ry:39}),
      key(.49,{cy:247,rx:42,ry:57},{cy:247,rx:42,ry:57}),
      key(.67,{cy:256,rx:36,ry:48},{cy:256,rx:36,ry:48}),
      key(1)
    ],
    wink:[
      key(0),
      key(.12,{cy:252,ry:43,smile:.18},{cy:256,ry:4}),
      key(.31,{cy:252,ry:43,smile:.22},{cy:256,ry:4}),
      key(.43,{cy:256,ry:46},{cy:256,ry:46}),
      key(.60,{cy:256,ry:4},{cy:256,ry:46}),
      key(.72,{cy:256,ry:4},{cy:256,ry:46}),
      key(.83,{cy:256,ry:49},{cy:256,ry:46}),
      key(1)
    ],
    sleepy:[
      key(0),
      key(.17,{cy:262,ry:31},{cy:262,ry:31}),
      key(.34,{cy:269,ry:20},{cy:269,ry:20}),
      key(.50,{cy:272,ry:12},{cy:272,ry:12}),
      key(.66,{cy:265,ry:23},{cy:265,ry:23}),
      key(.81,{cy:258,ry:39},{cy:258,ry:39}),
      key(1)
    ]
  };

  function smooth(t) { return t*t*(3-2*t); }
  function lerp(a,b,t) { return a+(b-a)*t; }
  function mixObject(a,b,t) {
    const out = {};
    Object.keys(b).forEach(k => {
      if (typeof b[k] === 'number') out[k] = lerp(a[k],b[k],t);
      else if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) out[k] = mixObject(a[k],b[k],t);
    });
    return out;
  }
  function stateAt(frames,progress) {
    let i=0;
    while (i<frames.length-2 && progress>frames[i+1].at) i++;
    const a=frames[i], b=frames[i+1];
    const span=Math.max(.0001,b.at-a.at);
    const local=Math.max(0,Math.min(1,(progress-a.at)/span));
    return mixObject(a.state,b.state,smooth(local));
  }
  function eyePath(eye) {
    const smile=Math.max(0,Math.min(1,eye.smile || 0));
    const endY=eye.cy+eye.ry*.18*smile;
    const topY=eye.cy-eye.ry*1.12;
    const bottomY=eye.cy+lerp(eye.ry*1.12,-eye.ry*.45,smile);
    return 'M '+(eye.cx-eye.rx)+' '+endY+
      ' C '+(eye.cx-eye.rx)+' '+topY+', '+(eye.cx+eye.rx)+' '+topY+', '+(eye.cx+eye.rx)+' '+endY+
      ' C '+(eye.cx+eye.rx)+' '+bottomY+', '+(eye.cx-eye.rx)+' '+bottomY+', '+(eye.cx-eye.rx)+' '+endY+' Z';
  }
  function setAttrs(node,attrs) {
    Object.keys(attrs).forEach(name => node.setAttribute(name,String(attrs[name])));
  }
  function render(state) {
    nodes.left.setAttribute('d',eyePath(state.left));
    nodes.right.setAttribute('d',eyePath(state.right));
    nodes.left.setAttribute('transform',state.left.rot ? 'rotate('+state.left.rot+' '+state.left.cx+' '+state.left.cy+')' : '');
    nodes.right.setAttribute('transform',state.right.rot ? 'rotate('+state.right.rot+' '+state.right.cx+' '+state.right.cy+')' : '');
    setAttrs(nodes.scan,{y:state.fx.scan.y,height:state.fx.scan.height,opacity:state.fx.scan.opacity});
    setAttrs(nodes.ball,{cx:state.fx.ball.x,cy:state.fx.ball.y,r:state.fx.ball.r,opacity:state.fx.ball.opacity});
    setAttrs(nodes.ring,{rx:state.fx.ring.rx,ry:state.fx.ring.ry,opacity:state.fx.ring.opacity,'stroke-width':state.fx.ring.width});
  }
  function resetFace() { render(baseState); }
  function randomBetween(min,max) { return min+Math.random()*(max-min); }

  let rafId=0;
  let delayTimer=0;
  let blinkTimer=0;
  let cycleActive=true;
  let running=false;
  let suspended=false;
  let cycleBag=[];
  let lastCycleAnimation='';
  let cycleStartedOnce=false;

  function clearTimers() {
    clearTimeout(delayTimer);
    clearTimeout(blinkTimer);
    delayTimer=blinkTimer=0;
  }
  function blinkAmount(ms,start,duration) {
    const p=(ms-start)/duration;
    if (p<=0 || p>=1) return 0;
    return p<.43 ? smooth(p/.43) : 1-smooth((p-.43)/.57);
  }
  function animateBlink(doubleBlink,onDone) {
    cancelAnimationFrame(rafId);
    const start=performance.now();
    const duration=doubleBlink?860:500;
    function tick(now) {
      const elapsed=Math.min(duration,now-start);
      const first=blinkAmount(elapsed,10,245);
      const second=doubleBlink?blinkAmount(elapsed,445,245):0;
      const closeL=Math.max(first,second);
      const closeR=Math.max(blinkAmount(elapsed,48,245),doubleBlink?blinkAmount(elapsed,483,245):0);
      render({
        left:{...baseEye.left,ry:lerp(46,3.5,closeL)},
        right:{...baseEye.right,ry:lerp(46,3.5,closeR)},
        fx:{scan:{...baseFx.scan},ball:{...baseFx.ball},ring:{...baseFx.ring}}
      });
      if (elapsed<duration) rafId=requestAnimationFrame(tick);
      else { rafId=0; resetFace(); if (onDone) onDone(); }
    }
    rafId=requestAnimationFrame(tick);
  }
  function shuffleCycleBag() {
    cycleBag=Object.keys(animations);
    for (let i=cycleBag.length-1;i>0;i--) {
      const j=Math.floor(Math.random()*(i+1));
      [cycleBag[i],cycleBag[j]]=[cycleBag[j],cycleBag[i]];
    }
    if (cycleBag.length>1 && cycleBag[cycleBag.length-1]===lastCycleAnimation) {
      [cycleBag[0],cycleBag[cycleBag.length-1]]=[cycleBag[cycleBag.length-1],cycleBag[0]];
    }
  }
  function nextAnimation() {
    if (!cycleBag.length) shuffleCycleBag();
    const next=cycleBag.pop();
    lastCycleAnimation=next;
    return next;
  }
  function scheduleNext(initial) {
    if (!cycleActive || suspended || !isVisible()) return;
    clearTimers();
    const delay=initial?randomBetween(1800,3400):randomBetween(6500,14500);
    if (!initial && delay>2600 && Math.random()<.58) {
      const maxBlinkDelay=Math.max(700,delay-1350);
      blinkTimer=setTimeout(() => {
        if (!cycleActive || suspended || running || !isVisible()) return;
        animateBlink(Math.random()<.24);
      },randomBetween(1100,maxBlinkDelay));
    }
    delayTimer=setTimeout(() => {
      if (!cycleActive || suspended || !isVisible()) return;
      clearTimeout(blinkTimer);
      blinkTimer=0;
      runAnimation(nextAnimation());
    },delay);
  }
  function runAnimation(name) {
    if (!cycleActive || suspended) return;
    cancelAnimationFrame(rafId);
    clearTimeout(blinkTimer);
    blinkTimer=0;
    running=true;
    const frames=animations[name];
    const start=performance.now();
    function tick(now) {
      if (suspended || !cycleActive) return;
      const progress=Math.min(1,(now-start)/DURATION);
      render(stateAt(frames,progress));
      if (progress<1) rafId=requestAnimationFrame(tick);
      else {
        rafId=0;
        resetFace();
        running=false;
        scheduleNext(false);
      }
    }
    rafId=requestAnimationFrame(tick);
  }
  function isVisible() {
    return !document.hidden && icon.getClientRects().length>0 &&
      window.getComputedStyle(icon).visibility!=='hidden';
  }
  function suspend() {
    if (suspended) return;
    suspended=true;
    cancelAnimationFrame(rafId);
    rafId=0;
    clearTimers();
    running=false;
    resetFace();
  }
  function resume() {
    if (!cycleActive || reduceMotion || !isVisible()) return;
    if (!suspended && (running || delayTimer)) return;
    suspended=false;
    scheduleNext(cycleStartedOnce?false:true);
    cycleStartedOnce=true;
  }
  function syncVisibility() {
    if (reduceMotion) return;
    if (isVisible()) resume();
    else suspend();
  }

  resetFace();
  if (!reduceMotion) {
    document.addEventListener('visibilitychange',syncVisibility);
    const overlay=document.getElementById('start-overlay');
    if (overlay && window.MutationObserver) {
      new MutationObserver(syncVisibility).observe(overlay,{attributes:true,attributeFilter:['hidden','class','style']});
    }
    const observerTarget=icon;
    if (window.IntersectionObserver) {
      const observer=new IntersectionObserver(entries => {
        if (entries[0] && entries[0].isIntersecting) resume();
        else suspend();
      });
      observer.observe(observerTarget);
    }
    resume();
  }
})();
