// ════════════════════════════════════════════════════
//  FIBER ANALYZER v2 - 메인 로직
// ════════════════════════════════════════════════════

// ─── 1. 먼셀 차트 데이터 (12색상 × 6샘플) ───────────────
// 순서: S1(중심), S2(하한), S3(상한), S4(중간값), S5(하중사이), S6(중상사이)
// 화면 표시는 1~6번 순서, 중간값 비교는 S4 사용
const MUNSELL = {
  blue:   { name:'파랑', samples:[[41,101,172],[20,85,130],[75,125,200],[35,95,155],[31,93,151],[58,113,186]] },
  orange: { name:'주황', samples:[[242,123,0],[180,100,20],[255,155,75],[215,115,10],[211,112,10],[249,139,38]] },
  green:  { name:'초록', samples:[[0,139,81],[25,105,45],[85,160,110],[40,125,70],[13,122,63],[43,150,96]] },
  red:    { name:'빨강', samples:[[191,0,49],[145,20,45],[220,85,95],[170,45,70],[168,10,47],[206,43,72]] },
  yellow: { name:'노랑', samples:[[255,207,0],[215,185,25],[255,235,100],[240,215,50],[235,196,13],[255,221,50]] },
  violet: { name:'보라', samples:[[118,78,161],[75,65,125],[155,135,195],[100,95,145],[97,72,143],[137,107,178]] },
  brown:  { name:'갈색', samples:[[98,61,41],[85,55,35],[135,88,70],[115,75,55],[92,58,38],[117,75,56]] },
  black:  { name:'검정', samples:[[46,46,46],[10,10,10],[52,52,52],[30,30,30],[28,28,28],[49,49,49]] },
  white:  { name:'흰색', samples:[[227,227,227],[222,222,222],[242,242,242],[235,235,235],[225,225,225],[235,235,235]] },
  grey:   { name:'회색', samples:[[121,121,121],[100,100,100],[165,165,165],[140,140,140],[111,111,111],[143,143,143]] },
  aqua:   { name:'청록', samples:[[102,189,187],[105,160,160],[185,215,215],[145,195,195],[104,175,174],[144,202,201]] },
  pink:   { name:'핑크', samples:[[210,150,175],[175,135,155],[240,195,215],[195,165,185],[193,143,165],[225,173,195]] },
};
const COLOR_KEYS = Object.keys(MUNSELL);

// 화면 표시용 1~6번 정렬: 어두운→밝은 (S2,S5,S4,S1,S6,S3 = 차트 가로 순서)
const DISPLAY_ORDER = [1, 4, 3, 0, 5, 2]; // samples 배열 인덱스 매핑

// ─── 2. 설정 ───────────────────────────────────────────
const CFG = { INTERVAL: 100, STEP: 4 };

// ─── 3. 상태 ───────────────────────────────────────────
const S = {
  mode: 'live',           // 'live' | 'photo'
  running: false,
  tool: null,             // null | 'roi' | 'wb'
  roi: null,              // {x,y,w,h} 0~1
  wbArea: null,
  wbGain: null,           // {r,g,b} 보정 계수
  drag: null,
  timer: null,
  stream: null,
  curColor: 'blue',       // 현재 레퍼런스 색상 계열
  refColors: [],          // 현재 표시중인 6개 [r,g,b]
  lastRGB: { r:0, g:0, b:0 },
  fps: 0, fCount: 0, fLast: Date.now(),
  photoLoaded: false,
};

// ─── 4. DOM ────────────────────────────────────────────
const video   = document.getElementById('video');
const photoImg= document.getElementById('photo-img');
const overlay = document.getElementById('overlay');
const aCanvas = document.getElementById('analysis-canvas');
const camWrap = document.getElementById('cam-wrap');
const octx = overlay.getContext('2d');
const actx = aCanvas.getContext('2d', { willReadFrequently: true });

// ─── 5. 유틸 함수 ──────────────────────────────────────

/** RGB → HSV 변환 */
function rgbToHsv(r, g, b) {
  const rn=r/255, gn=g/255, bn=b/255;
  const mx=Math.max(rn,gn,bn), mn=Math.min(rn,gn,bn), d=mx-mn;
  let h=0;
  if(d!==0){
    if(mx===rn)      h=60*(((gn-bn)/d)%6);
    else if(mx===gn) h=60*(((bn-rn)/d)+2);
    else             h=60*(((rn-gn)/d)+4);
  }
  if(h<0) h+=360;
  return { h:Math.round(h), s:Math.round(mx===0?0:(d/mx)*100), v:Math.round(mx*100) };
}

/** RGBA 픽셀배열 → 평균 RGB (WB 보정 적용) */
function avgRGB(data) {
  let r=0,g=0,b=0,n=0;
  const step = CFG.STEP*4;
  for(let i=0;i<data.length;i+=step){ r+=data[i]; g+=data[i+1]; b+=data[i+2]; n++; }
  if(!n) return {r:0,g:0,b:0};
  let R=r/n, G=g/n, B=b/n;
  if(S.wbGain){
    R=Math.min(255,R*S.wbGain.r);
    G=Math.min(255,G*S.wbGain.g);
    B=Math.min(255,B*S.wbGain.b);
  }
  return { r:Math.round(R), g:Math.round(G), b:Math.round(B) };
}

const hex2 = n => n.toString(16).padStart(2,'0');
const rgbCss = c => `rgb(${c[0]},${c[1]},${c[2]})`;

/** 두 RGB 간 유클리드 거리 */
function rgbDist(a, b) {
  return Math.sqrt((a.r-b[0])**2 + (a.g-b[1])**2 + (a.b-b[2])**2);
}

// ─── 6. 레퍼런스 색상 빌드 ─────────────────────────────

/** 현재 색상 계열의 6색을 표시 순서대로 refColors에 채움 */
function buildRefColors() {
  const samples = MUNSELL[S.curColor].samples;
  S.refColors = DISPLAY_ORDER.map(idx => samples[idx].slice());
  document.getElementById('cur-color-name').textContent = MUNSELL[S.curColor].name + ' 계열';
}

/** 레퍼런스 리스트 DOM 렌더 */
function renderRefList() {
  const wrap = document.getElementById('ref-list');
  wrap.innerHTML = '';
  S.refColors.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'ref-item';
    item.id = `ref-${i}`;
    item.onclick = openPalette; // 터치 시 팔레트
    item.innerHTML = `
      <span class="ref-num">${i+1}</span>
      <span class="ref-rgb"><span class="cr">R ${c[0]}</span><br><span class="cg">G ${c[1]}</span><br><span class="cb">B ${c[2]}</span></span>
      <span class="ref-sw" style="background:${rgbCss(c)}"></span>`;
    wrap.appendChild(item);
  });
}

// ─── 7. 컬러 매칭 + 코멘트 ─────────────────────────────

/** 가장 가까운 레퍼런스 찾아 하이라이트 + 코멘트 생성 */
function updateMatch(rgb) {
  let best=-1, bestD=1e9;
  S.refColors.forEach((c,i)=>{
    const d=rgbDist(rgb,c);
    if(d<bestD){ bestD=d; best=i; }
  });

  // 하이라이트
  S.refColors.forEach((_,i)=>{
    document.getElementById(`ref-${i}`)?.classList.toggle('match', i===best);
  });

  // 일치율 (거리 → %, 최대거리 약 441)
  const rate = Math.max(0, Math.round((1 - bestD/180) * 100));
  const rateEl = document.getElementById('match-rate');
  rateEl.textContent = `· ${MUNSELL[S.curColor].name} ${best+1}번과 ${rate}% 일치`;
  rateEl.style.color = rate>=85 ? 'var(--live)' : rate>=60 ? '#ffc04a' : 'var(--stop)';

  // 코멘트 생성 (중간값 S4 = DISPLAY_ORDER에서 3번째 = index 2 표시번호 3)
  const mid = MUNSELL[S.curColor].samples[3]; // S4 중간값
  generateComment(rgb, mid, best, rate);
}

/** 한글 코멘트 생성 */
function generateComment(rgb, mid, bestIdx, rate) {
  const cur = rgbToHsv(rgb.r, rgb.g, rgb.b);
  const midHsv = rgbToHsv(mid[0], mid[1], mid[2]);

  const dV = cur.v - midHsv.v;       // 명도 차
  const dS = cur.s - midHsv.s;       // 채도 차
  const dH = cur.h - midHsv.h;       // 색조 차

  let parts = [];

  // 밝기
  if(Math.abs(dV) <= 3) parts.push('밝기는 중간값과 거의 동일');
  else if(dV > 0) parts.push(`중간값보다 ${Math.abs(dV)}% 밝`);
  else parts.push(`중간값보다 ${Math.abs(dV)}% 어둡`);

  // 채도(농도)
  let satTxt;
  if(Math.abs(dS) <= 3) satTxt = '색상 농도는 거의 동일합니다';
  else if(dS > 0) satTxt = `색상 농도가 ${Math.abs(dS)}% 더 진합니다`;
  else satTxt = `색상 농도가 ${Math.abs(dS)}% 더 연합니다`;

  // 색조
  let hueTxt = '';
  if(Math.abs(dH) > 12 && Math.abs(dH) < 348){
    const hueName = hueDescription(cur.h);
    hueTxt = ` ${hueName}이 감돕니다.`;
  }

  let prefix;
  if(rate >= 85) prefix = `✅ ${MUNSELL[S.curColor].name} ${bestIdx+1}번과 매우 유사합니다. `;
  else if(rate >= 60) prefix = `⚠️ ${MUNSELL[S.curColor].name} ${bestIdx+1}번과 가장 유사하나 차이가 있습니다. `;
  else prefix = `❌ 레퍼런스와 차이가 큽니다. `;

  const brightWord = (Math.abs(dV)<=3) ? parts[0] + '하고 ' : parts[0] + '고 ';
  document.getElementById('comment-text').textContent =
    prefix + brightWord + satTxt + '.' + hueTxt;
}

/** 색조값 → 한글 표현 */
function hueDescription(h) {
  if(h<15||h>=345) return '붉은빛';
  if(h<45)  return '주황빛';
  if(h<70)  return '노란빛';
  if(h<160) return '초록빛';
  if(h<200) return '청록빛';
  if(h<260) return '푸른빛';
  if(h<320) return '보랏빛';
  return '분홍빛';
}

// ─── 8. 모드 전환 ──────────────────────────────────────
function setMode(m){
  if(S.mode===m) return;
  S.mode=m;
  document.getElementById('tab-live').classList.toggle('on', m==='live');
  document.getElementById('tab-photo').classList.toggle('on', m==='photo');
  document.getElementById('live-controls').style.display  = m==='live' ? 'grid':'none';
  document.getElementById('photo-controls').style.display = m==='photo'? 'flex':'none';

  // 모드 바뀌면 정리
  if(m==='photo'){ if(S.running) stopCamera(); video.style.display='none'; }
  else { photoImg.style.display='none'; S.photoLoaded=false; clearInterval(S.timer); }
  resetAreas();
  document.getElementById('placeholder').style.display='flex';
  document.getElementById('ph-text').textContent = m==='live'?'START를 눌러 시작하세요':'사진을 불러오세요';
  octx.clearRect(0,0,overlay.width,overlay.height);
  addLog(m==='live'?'LIVE 모드':'PHOTO 모드');
}

// ─── 9. 카메라 ─────────────────────────────────────────
async function startCamera(){
  hideErr();
  try{
    S.stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720} }
    });
    video.srcObject=S.stream;
    await video.play();
    overlay.width=aCanvas.width=video.videoWidth||640;
    overlay.height=aCanvas.height=video.videoHeight||480;
    S.running=true; S.fLast=Date.now(); S.fCount=0;
    S.timer=setInterval(analyzeLive, CFG.INTERVAL);
    video.style.display='block';
    document.getElementById('placeholder').style.display='none';
    document.getElementById('live-dot').classList.add('on');
    document.getElementById('live-txt').textContent='LIVE';
    liveBtns(true);
    addLog('카메라 시작');
  }catch(e){
    const msg = e.name==='NotAllowedError'
      ? '카메라 권한이 거부되었습니다.\nSafari 주소창 AA → 웹사이트 설정 → 카메라 → 허용'
      : `카메라 오류: ${e.message}`;
    showErr(msg); addLog('오류: '+e.message);
  }
}

function stopCamera(){
  clearInterval(S.timer);
  S.stream?.getTracks().forEach(t=>t.stop());
  S.stream=null; S.running=false;
  video.style.display='none';
  document.getElementById('placeholder').style.display='flex';
  document.getElementById('live-dot').classList.remove('on');
  document.getElementById('live-txt').textContent='STANDBY';
  octx.clearRect(0,0,overlay.width,overlay.height);
  liveBtns(false);
  addLog('카메라 중지');
}

function liveBtns(on){
  document.getElementById('btn-start').disabled=on;
  ['btn-roi','btn-reset','btn-wb','btn-cap','btn-stop'].forEach(id=>document.getElementById(id).disabled=!on);
  document.getElementById('btn-start').classList.toggle('on',!on);
}

// ─── 10. 사진 불러오기 ─────────────────────────────────
function loadPhoto(e){
  const file=e.target.files[0];
  if(!file) return;
  const url=URL.createObjectURL(file);
  photoImg.onload=()=>{
    overlay.width=aCanvas.width=photoImg.naturalWidth;
    overlay.height=aCanvas.height=photoImg.naturalHeight;
    photoImg.style.display='block';
    document.getElementById('placeholder').style.display='none';
    S.photoLoaded=true;
    document.getElementById('btn-proi').disabled=false;
    document.getElementById('btn-preset').disabled=false;
    document.getElementById('btn-pcap').disabled=false;
    analyzePhoto();
    addLog('사진 불러옴');
  };
  photoImg.src=url;
}

// ─── 11. 측정영역 / 보정영역 도구 ──────────────────────
function setTool(t){
  S.tool = (S.tool===t)?null:t;
  // 버튼 하이라이트
  ['btn-roi','btn-proi'].forEach(id=>document.getElementById(id)?.classList.toggle('on',S.tool==='roi'));
  document.getElementById('btn-wb')?.classList.toggle('on-wb',S.tool==='wb');
  const hint=document.getElementById('cam-hint');
  if(S.tool==='roi'){ hint.textContent='드래그 → 측정영역 설정'; hint.className='cam-hint'; hint.style.display='block'; }
  else if(S.tool==='wb'){ hint.textContent='흰 종이 영역 드래그 → 자동 보정'; hint.className='cam-hint wb'; hint.style.display='block'; }
  else hint.style.display='none';
}

function resetAreas(){
  S.roi=null; S.wbArea=null; S.wbGain=null; S.tool=null;
  ['btn-roi','btn-proi'].forEach(id=>document.getElementById(id)?.classList.remove('on'));
  document.getElementById('btn-wb')?.classList.remove('on-wb');
  document.getElementById('cam-hint').style.display='none';
  if(S.mode==='photo'&&S.photoLoaded) analyzePhoto();
  addLog('측정영역 + 보정 초기화');
}

// 드래그 좌표
function relPos(e){
  const rect=camWrap.getBoundingClientRect();
  const src=e.touches?e.touches[0]:e;
  return {
    x:Math.max(0,Math.min(1,(src.clientX-rect.left)/rect.width)),
    y:Math.max(0,Math.min(1,(src.clientY-rect.top)/rect.height)),
  };
}
['mousedown','touchstart'].forEach(ev=>camWrap.addEventListener(ev,onDown,{passive:false}));
['mousemove','touchmove'].forEach(ev=>camWrap.addEventListener(ev,onMove,{passive:false}));
['mouseup','touchend'].forEach(ev=>camWrap.addEventListener(ev,onUp,{passive:false}));

function onDown(e){
  if(!S.tool) return;
  if(S.mode==='live'&&!S.running) return;
  if(S.mode==='photo'&&!S.photoLoaded) return;
  e.preventDefault();
  S.drag=relPos(e);
}
function onMove(e){
  if(!S.drag) return;
  e.preventDefault();
  const cur=relPos(e);
  const rect={ x:Math.min(S.drag.x,cur.x),y:Math.min(S.drag.y,cur.y),
               w:Math.abs(cur.x-S.drag.x),h:Math.abs(cur.y-S.drag.y) };
  if(S.tool==='roi') S.roi=rect; else if(S.tool==='wb') S.wbArea=rect;
  if(S.mode==='photo') { drawPhotoOverlay(); }
}
function onUp(e){
  if(!S.drag) return;
  S.drag=null;
  if(S.tool==='wb'&&S.wbArea&&S.wbArea.w>0.02){
    applyWhiteBalance();
  }
  // 측정영역 완료시 도구 해제
  if(S.tool==='roi'&&S.roi&&S.roi.w>0.02){
    setTool('roi'); // 토글로 끔
  }
  if(S.mode==='photo'&&S.photoLoaded) analyzePhoto();
}

// ─── 12. 화이트밸런스 자동 적용 ────────────────────────
function applyWhiteBalance(){
  const src = S.mode==='live' ? video : photoImg;
  const vw=aCanvas.width, vh=aCanvas.height;
  actx.drawImage(src,0,0,vw,vh);
  const a=S.wbArea;
  const x=Math.floor(a.x*vw), y=Math.floor(a.y*vh);
  const w=Math.max(1,Math.floor(a.w*vw)), h=Math.max(1,Math.floor(a.h*vh));
  const data=actx.getImageData(x,y,w,h).data;
  let r=0,g=0,b=0,n=0;
  const step=CFG.STEP*4;
  for(let i=0;i<data.length;i+=step){ r+=data[i]; g+=data[i+1]; b+=data[i+2]; n++; }
  r/=n; g/=n; b/=n;
  // 흰색 기준 보정: 평균을 흰색(공통 최대)으로 맞춤
  const target=Math.max(r,g,b);
  S.wbGain={ r:target/r, g:target/g, b:target/b };
  S.tool=null;
  document.getElementById('btn-wb')?.classList.remove('on-wb');
  document.getElementById('cam-hint').style.display='none';
  addLog(`WB 보정 적용 (gain R${S.wbGain.r.toFixed(2)} G${S.wbGain.g.toFixed(2)} B${S.wbGain.b.toFixed(2)})`);
}

// ─── 13. 분석 (LIVE) ───────────────────────────────────
function analyzeLive(){
  if(!S.running||video.readyState<2) return;
  const vw=video.videoWidth, vh=video.videoHeight;
  actx.drawImage(video,0,0,vw,vh);
  doAnalysis(vw,vh);
  drawOverlay(vw,vh);
  calcFPS();
}

// ─── 분석 (PHOTO) ─────────────────────────────────────
function analyzePhoto(){
  if(!S.photoLoaded) return;
  const vw=photoImg.naturalWidth, vh=photoImg.naturalHeight;
  actx.drawImage(photoImg,0,0,vw,vh);
  doAnalysis(vw,vh);
  drawPhotoOverlay();
}

/** 공통 분석 처리 */
function doAnalysis(vw,vh){
  const roi=S.roi
    ?{x:Math.floor(S.roi.x*vw),y:Math.floor(S.roi.y*vh),w:Math.max(1,Math.floor(S.roi.w*vw)),h:Math.max(1,Math.floor(S.roi.h*vh))}
    :{x:0,y:0,w:vw,h:vh};
  const data=actx.getImageData(roi.x,roi.y,roi.w,roi.h).data;
  const rgb=avgRGB(data);
  S.lastRGB=rgb;
  const hsv=rgbToHsv(rgb.r,rgb.g,rgb.b);
  updateMetrics(rgb,hsv);
  updateCaptured(rgb);
  updateMatch(rgb);
}

// ─── 14. UI 업데이트 ───────────────────────────────────
function updateMetrics(rgb,hsv){
  setBar('r',rgb.r,255); setVal('r',rgb.r,'');
  setBar('g',rgb.g,255); setVal('g',rgb.g,'');
  setBar('b',rgb.b,255); setVal('b',rgb.b,'');
  setBar('h',hsv.h,360); setVal('h',hsv.h,'°');
  setBar('s',hsv.s,100); setVal('s',hsv.s,'%');
  setBar('v',hsv.v,100); setVal('v',hsv.v,'%');
}
function setBar(ch,v,max){ document.getElementById(`bar-${ch}`).style.width=`${(v/max*100).toFixed(1)}%`; }
function setVal(ch,v,u){ document.getElementById(`val-${ch}`).textContent=v+u; }

function updateCaptured(rgb){
  document.getElementById('cap-swatch').style.background=`rgb(${rgb.r},${rgb.g},${rgb.b})`;
  document.getElementById('cap-r').textContent=rgb.r;
  document.getElementById('cap-g').textContent=rgb.g;
  document.getElementById('cap-b').textContent=rgb.b;
}

// ─── 15. 오버레이 ──────────────────────────────────────
function drawOverlay(vw,vh){
  octx.clearRect(0,0,overlay.width,overlay.height);
  drawArea(S.roi,'rgba(0,210,255,0.9)',vw,vh,true);
  drawArea(S.wbArea,'rgba(54,224,122,0.9)',vw,vh,false);
}
function drawPhotoOverlay(){
  octx.clearRect(0,0,overlay.width,overlay.height);
  drawArea(S.roi,'rgba(0,210,255,0.9)',overlay.width,overlay.height,true);
  drawArea(S.wbArea,'rgba(54,224,122,0.9)',overlay.width,overlay.height,false);
}
function drawArea(area,color,vw,vh,crosshair){
  if(!area) return;
  const sx=overlay.width/vw, sy=overlay.height/vh;
  const x=area.x*vw*sx, y=area.y*vh*sy, w=area.w*vw*sx, h=area.h*vh*sy;
  octx.strokeStyle=color; octx.lineWidth=Math.max(2,overlay.width/320);
  octx.setLineDash([8,4]); octx.strokeRect(x,y,w,h); octx.setLineDash([]);
  if(crosshair){
    const cx=x+w/2, cy=y+h/2, s=overlay.width/40;
    octx.strokeStyle=color.replace('0.9','0.5'); octx.lineWidth=1;
    octx.beginPath();
    octx.moveTo(cx-s,cy); octx.lineTo(cx+s,cy);
    octx.moveTo(cx,cy-s); octx.lineTo(cx,cy+s);
    octx.stroke();
  }
}

// ─── 16. FPS ───────────────────────────────────────────
function calcFPS(){
  S.fCount++;
  const now=Date.now();
  if(now-S.fLast>=1000){ S.fps=S.fCount; S.fCount=0; S.fLast=now;
    document.getElementById('fps-box').textContent=`${S.fps} FPS`; }
}

// ─── 17. 화면 캡처 ─────────────────────────────────────
function captureScreen(){
  addLog('캡처 생성 중...');
  html2canvas(document.getElementById('app'),{ backgroundColor:'#050d1a', scale:2, useCORS:true })
    .then(canvas=>{
      const link=document.createElement('a');
      const ts=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      link.download=`fiber_${ts}.png`;
      link.href=canvas.toDataURL('image/png');
      link.click();
      addLog('캡처 저장 완료 (이미지를 길게 눌러 사진에 추가)');
    })
    .catch(e=>{ addLog('캡처 실패: '+e.message); });
}

// ─── 18. 옵션 모달 ─────────────────────────────────────
function openOptions(){
  renderOptPalette();
  renderOptSamples();
  document.getElementById('opt-modal').classList.add('show');
}
function closeOptions(){ document.getElementById('opt-modal').classList.remove('show'); }

function renderOptPalette(){
  const wrap=document.getElementById('opt-palette');
  wrap.innerHTML='';
  COLOR_KEYS.forEach(key=>{
    const c=MUNSELL[key];
    const sw=document.createElement('div');
    sw.className='pal-swatch'+(key===S.curColor?' sel':'');
    sw.style.background=rgbCss(c.samples[0]);
    sw.innerHTML=`<span>${c.name}</span>`;
    sw.onclick=()=>{ S.curColor=key; buildRefColors(); renderRefList();
      document.getElementById('opt-sel-name').textContent=c.name;
      renderOptPalette(); renderOptSamples();
      if(S.mode==='photo'&&S.photoLoaded) analyzePhoto();
      addLog(`옵션: ${c.name} 계열 선택`); };
    wrap.appendChild(sw);
  });
  document.getElementById('opt-sel-name').textContent=MUNSELL[S.curColor].name;
}

function renderOptSamples(){
  const wrap=document.getElementById('opt-samples');
  wrap.innerHTML='';
  S.refColors.forEach((c,i)=>{
    const row=document.createElement('div');
    row.className='sample-row';
    row.innerHTML=`
      <span class="se-num">${i+1}</span>
      <span class="se-sw" id="se-sw-${i}" style="background:${rgbCss(c)}"></span>
      <div class="se-inputs">
        <div class="se-field"><label class="r">R</label><input type="number" min="0" max="255" value="${c[0]}" data-i="${i}" data-ch="0"></div>
        <div class="se-field"><label class="g">G</label><input type="number" min="0" max="255" value="${c[1]}" data-i="${i}" data-ch="1"></div>
        <div class="se-field"><label class="b">B</label><input type="number" min="0" max="255" value="${c[2]}" data-i="${i}" data-ch="2"></div>
      </div>`;
    wrap.appendChild(row);
  });
  // 입력 이벤트
  wrap.querySelectorAll('input').forEach(inp=>{
    inp.oninput=()=>{
      const i=+inp.dataset.i, ch=+inp.dataset.ch;
      let v=Math.max(0,Math.min(255,parseInt(inp.value)||0));
      S.refColors[i][ch]=v;
      document.getElementById(`se-sw-${i}`).style.background=rgbCss(S.refColors[i]);
      renderRefList();
      if(S.mode==='photo'&&S.photoLoaded) analyzePhoto();
    };
  });
}

// ─── 19. 팔레트 모달 (레퍼런스 터치) ───────────────────
function openPalette(){
  const wrap=document.getElementById('pal-palette');
  wrap.innerHTML='';
  COLOR_KEYS.forEach(key=>{
    const c=MUNSELL[key];
    const sw=document.createElement('div');
    sw.className='pal-swatch'+(key===S.curColor?' sel':'');
    sw.style.background=rgbCss(c.samples[0]);
    sw.innerHTML=`<span>${c.name}</span>`;
    sw.onclick=()=>{ S.curColor=key; buildRefColors(); renderRefList(); closePalette();
      if(S.mode==='photo'&&S.photoLoaded) analyzePhoto();
      addLog(`${c.name} 계열로 교체`); };
    wrap.appendChild(sw);
  });
  document.getElementById('pal-modal').classList.add('show');
}
function closePalette(){ document.getElementById('pal-modal').classList.remove('show'); }

// 모달 배경 클릭 시 닫기
document.getElementById('opt-modal').onclick=e=>{ if(e.target.id==='opt-modal') closeOptions(); };
document.getElementById('pal-modal').onclick=e=>{ if(e.target.id==='pal-modal') closePalette(); };

// ─── 20. 로그 / 오류 ───────────────────────────────────
function addLog(msg){
  const box=document.getElementById('log-box');
  const t=new Date().toTimeString().slice(0,8);
  const div=document.createElement('div');
  div.textContent=`[${t}] ${msg}`;
  box.appendChild(div);
  box.scrollTop=box.scrollHeight;
  while(box.children.length>30) box.removeChild(box.firstChild);
}
function showErr(m){ const el=document.getElementById('err-banner'); el.style.display='block'; el.textContent='⚠ '+m; }
function hideErr(){ document.getElementById('err-banner').style.display='none'; }

// ─── 21. Service Worker ────────────────────────────────
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}

// ─── 22. 초기화 ────────────────────────────────────────
window.addEventListener('DOMContentLoaded',()=>{
  buildRefColors();
  renderRefList();
  overlay.width=640; overlay.height=480;
  addLog('시스템 초기화 완료');
  addLog('LIVE: START / PHOTO: 사진 불러오기');
});
