// Audio Light Analyzer v2 - simple, vanilla JS
(() => {
  // DOM
  const deviceSelect = document.getElementById('device-select');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const selLabel = document.getElementById('sel-label');
  const sampleRateEl = document.getElementById('sample-rate');
  const rmsEl = document.getElementById('rms');
  const peakEl = document.getElementById('peak');
  const signalStateEl = document.getElementById('signal-state');
  const waveCanvas = document.getElementById('wave-canvas');
  const spectrumCanvas = document.getElementById('spectrum-canvas');
  const historyCanvas = document.getElementById('history-canvas');
  const energyLow = document.getElementById('energy-low');
  const energyMid = document.getElementById('energy-mid');
  const energyHigh = document.getElementById('energy-high');
  const freqGrid = document.getElementById('freq-grid');
  const dbgInputs = document.getElementById('dbg-inputs');
  const dbgDevice = document.getElementById('dbg-device');
  const dbgError = document.getElementById('dbg-error');
  const dbgTab = document.getElementById('dbg-tab');
  const dbgAge = document.getElementById('dbg-age');
  const btnReset = document.getElementById('btn-reset-analysis');

  const bpmInput = document.getElementById('bpm-input');
  const applyBpm = document.getElementById('apply-bpm');
  const resetBpm = document.getElementById('reset-bpm');
  const bpmDisplay = document.getElementById('bpm-display');
  const bpmCounter = document.getElementById('bpm-counter');

  // canvases context
  const wCtx = waveCanvas.getContext('2d');
  const sCtx = spectrumCanvas.getContext('2d');
  const hCtx = historyCanvas.getContext('2d');
  const lowCtx = energyLow.getContext('2d');
  const midCtx = energyMid.getContext('2d');
  const highCtx = energyHigh.getContext('2d');

  // audio
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let mediaStream = null;
  let currentDeviceId = null;

  // buffers
  const fftSize = 2048;
  const historySeconds = 10;
  const sampleRate = 44100;
  let lastUpdate = performance.now();

  // waveform history buffer (mono) - store RMS samples
  const historyLen = Math.floor((historySeconds * 1000) / 100); // store every 100ms
  const historyBuffer = [];
  const energyLowHistory = [];
  const energyMidHistory = [];
  const energyHighHistory = [];
  let lastHistorySample = 0;

  // frequency rhythm bins
  const nBins = 24;
  const bins = [];

  // manual BPM
  let manualBpm = null;
  let bpmIntervalId = null;
  let bpmStep = 0;

  // debug
  let lastError = null;

  function logError(e){ lastError = (e && e.message) ? e.message : String(e); dbgError.textContent = lastError; }

  // initialize frequency bins (log-spaced)
  function initBins(fftSize, sr){ bins.length = 0; const minHz = 20; const maxHz = 12000; const minLog = Math.log(minHz), maxLog = Math.log(maxHz); const freqPerIndex = sr / fftSize; for(let i=0;i<nBins;i++){ const a=i/nBins, b=(i+1)/nBins; const lo = Math.exp(minLog + (maxLog-minLog)*a); const hi = Math.exp(minLog + (maxLog-minLog)*b); const iLo = Math.max(0, Math.floor(lo / freqPerIndex)); const iHi = Math.min(Math.floor(fftSize/2)-1, Math.ceil(hi / freqPerIndex)); bins.push({minHz:lo,maxHz:hi,iLo,iHi,energy:0,history:[]}); } renderBins(); }

  function renderBins(){ freqGrid.innerHTML=''; bins.forEach((b,idx)=>{ const el = document.createElement('div'); el.className='freq-bin'; el.id = 'bin-'+idx; el.innerHTML = `<div><strong>${Math.round(b.minHz)}–${Math.round(b.maxHz)} Hz</strong></div><div class="bin-energy">0.00</div><canvas class="mini" width="200" height="40"></canvas>`; freqGrid.appendChild(el); }); }

  // update list of devices
  async function enumerateDevices(){ try{ const devices = await navigator.mediaDevices.enumerateDevices(); const inputs = devices.filter(d=>d.kind==='audioinput'); dbgInputs.textContent = inputs.map(d=>d.label||d.deviceId).join('\n') || '-'; deviceSelect.innerHTML=''; inputs.forEach(d=>{ const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || d.deviceId; deviceSelect.appendChild(o); }); return inputs; }catch(e){ logError(e); return []; } }

  async function start(deviceId){ try{
    if(!navigator.mediaDevices) throw new Error('getUserMedia not supported');
    mediaStream = await navigator.mediaDevices.getUserMedia({audio:{deviceId: deviceId ? {exact: deviceId} : undefined}});
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = fftSize; analyser.smoothingTimeConstant = 0.3;
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    sourceNode.connect(analyser);
    currentDeviceId = deviceId || null; selLabel.textContent = mediaStream.getAudioTracks()[0].label || '—'; sampleRateEl.textContent = audioCtx.sampleRate || '—'; initBins(analyser.fftSize, audioCtx.sampleRate);
    btnStart.disabled = true; btnStop.disabled = false;
    lastUpdate = performance.now();
    lastHistorySample = performance.now();
    runAnalyser();
  }catch(e){ logError(e); }
  }

  function stop(){ try{ if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; } if(sourceNode){ sourceNode.disconnect(); sourceNode=null; } if(analyser){ analyser.disconnect(); analyser=null; } if(audioCtx){ audioCtx.close(); audioCtx=null; } btnStart.disabled=false; btnStop.disabled=true; selLabel.textContent='—'; sampleRateEl.textContent='—'; }catch(e){ logError(e); } }

  function clearAnalysis(){ historyBuffer.length = 0; energyLowHistory.length = 0; energyMidHistory.length = 0; energyHighHistory.length = 0; lastHistorySample = 0; bins.forEach(b=>b.history=[]); bpmCounter.textContent='—'; }

  // draw helpers
  function fitCanvas(c){ const dpr = devicePixelRatio || 1; const w = c.clientWidth; const h = c.clientHeight; c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr); return {ctx: c.getContext('2d'), w:c.width, h:c.height, dpr}; }

  function pushHistory(val, buf){ buf.push(val); if(buf.length > historyLen) buf.shift(); }

  function drawLineHistory(cn, buf, color, scale){ const tc = fitCanvas(cn); const tctx = tc.ctx; const w = tc.w, h = tc.h; tctx.clearRect(0,0,w,h); if(!buf.length) return; tctx.strokeStyle = color; tctx.lineWidth = Math.max(1.5, tc.dpr * 1.5); tctx.beginPath(); const denom = Math.max(1, historyLen - 1); const peak = Math.max(0.001, ...buf); const yScale = (scale || 1) * (0.92 * h / peak); for(let i=0;i<buf.length;i++){ const x = (i / denom) * w; const y = h - Math.min(h - 1, buf[i] * yScale); if(i===0) tctx.moveTo(x,y); else tctx.lineTo(x,y); } tctx.stroke(); }

  function drawFillHistory(cn, buf, color){ const tc = fitCanvas(cn); const tctx = tc.ctx; const w = tc.w, h = tc.h; tctx.clearRect(0,0,w,h); if(!buf.length) return; tctx.fillStyle = color; const denom = Math.max(1, historyLen - 1); const colW = Math.max(1, Math.ceil(w / historyLen)); const peak = Math.max(0.001, ...buf); const yScale = 0.92 * h / peak; for(let i=0;i<buf.length;i++){ const x = Math.floor((i / denom) * w); const barH = Math.max(1, Math.floor(buf[i] * yScale)); tctx.fillRect(x, h - barH, colW, barH); } }

  function sampleSpecAtHz(spec, binHz, hz){ const binFloat = hz / binHz; const binA = Math.floor(binFloat); if(binA < 0) return spec[0] / 255; if(binA >= spec.length - 1) return spec[spec.length - 1] / 255; const binB = binA + 1; const t = binFloat - binA; return (spec[binA] / 255) * (1 - t) + (spec[binB] / 255) * t; }

  function hzToLogX(hz, minHz, maxHz, width){ return width * (Math.log(hz / minHz) / Math.log(maxHz / minHz)); }

  function drawLogSpectrum(cn, spec, sr){
    const sc = fitCanvas(cn); const sctx = sc.ctx; const w = sc.w, h = sc.h;
    sctx.clearRect(0,0,w,h);
    const minHz = 10; const maxHz = Math.min(22000, sr / 2); const binHz = sr / fftSize; const freqRatio = maxHz / minHz;
    const labelH = Math.max(11, Math.round(sc.dpr * 9)); const plotH = h - labelH;
    const gridHz = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    sctx.font = `${Math.max(8, Math.round(labelH * 0.78))}px ui-sans-serif, sans-serif`;
    sctx.textBaseline = 'bottom';
    for(const hz of gridHz){
      if(hz < minHz || hz > maxHz) continue;
      const gx = hzToLogX(hz, minHz, maxHz, w);
      sctx.strokeStyle = (hz === 100 || hz === 1000) ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)';
      sctx.lineWidth = 1; sctx.beginPath(); sctx.moveTo(gx, 0); sctx.lineTo(gx, plotH); sctx.stroke();
      const lbl = hz >= 1000 ? (hz / 1000) + 'k' : String(hz);
      sctx.fillStyle = 'rgba(170,182,200,0.6)'; sctx.fillText(lbl, gx + 2, h - 2);
    }
    const vals = new Float32Array(w);
    for(let px = 0; px < w; px++){ const hz = minHz * Math.pow(freqRatio, px / w); vals[px] = sampleSpecAtHz(spec, binHz, hz); }
    const smooth = new Float32Array(w); smooth[0] = vals[0];
    for(let px = 1; px < w - 1; px++) smooth[px] = vals[px - 1] * 0.06 + vals[px] * 0.88 + vals[px + 1] * 0.06;
    smooth[w - 1] = vals[w - 1];
    sctx.beginPath(); sctx.moveTo(0, plotH);
    for(let px = 0; px < w; px++) sctx.lineTo(px + 0.5, plotH - smooth[px] * plotH);
    sctx.lineTo(w, plotH); sctx.closePath();
    const grad = sctx.createLinearGradient(0, 0, 0, plotH);
    grad.addColorStop(0, 'rgba(96,165,250,0.32)'); grad.addColorStop(1, 'rgba(96,165,250,0.03)');
    sctx.fillStyle = grad; sctx.fill();
    sctx.beginPath();
    for(let px = 0; px < w; px++){ const y = plotH - smooth[px] * plotH; if(px === 0) sctx.moveTo(0, y); else sctx.lineTo(px, y); }
    sctx.strokeStyle = 'rgba(150,195,255,0.98)'; sctx.lineWidth = Math.max(1, sc.dpr * 0.55); sctx.stroke();
  }

  function energyInRange(spec, sr, lo, hi){ const freqPerIndex = sr / fftSize; let sum=0,c=0; for(let i=0;i<spec.length;i++){ const f = i * freqPerIndex; if(f >= lo && f < hi){ sum += spec[i]; c++; } } return c ? sum / (c * 255) : 0; }

  function runAnalyser(){ if(!analyser) return; const now = performance.now(); const dt = now - lastUpdate; lastUpdate = now; dbgAge.textContent = Math.round(performance.now() - now) + ' ms'; // quick age
    // waveform
    const buf = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(buf);
    let sum=0, peak=0; for(let i=0;i<buf.length;i++){ const v = (buf[i]-128)/128; sum += v*v; peak = Math.max(peak, Math.abs(v)); }
    const rms = Math.sqrt(sum / buf.length);
    rmsEl.textContent = rms.toFixed(3); peakEl.textContent = peak.toFixed(3);
    signalStateEl.textContent = rms > 0.002 ? 'signal' : 'no signal';

    // draw waveform
    const wc = fitCanvas(waveCanvas); const w = wc.w, h = wc.h; const ctx = wc.ctx; ctx.clearRect(0,0,w,h); ctx.lineWidth = 2*wc.dpr; ctx.strokeStyle = '#60a5fa'; ctx.beginPath(); for(let i=0;i<buf.length;i++){ const x = (i / buf.length) * w; const y = (1 - ((buf[i]/255))) * h; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); } ctx.stroke();

    const spec = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(spec);
    const sr = audioCtx.sampleRate;
    const eLow = energyInRange(spec, sr, 20, 200);
    const eMid = energyInRange(spec, sr, 200, 2000);
    const eHigh = energyInRange(spec, sr, 2000, 12000);

    // sample histories every ~100ms (dt is per-frame, not accumulated)
    let sampleTick = false;
    if(now - lastHistorySample >= 100){
      pushHistory(rms, historyBuffer);
      pushHistory(eLow, energyLowHistory);
      pushHistory(eMid, energyMidHistory);
      pushHistory(eHigh, energyHighHistory);
      lastHistorySample = now;
      sampleTick = true;
    }

    drawLineHistory(historyCanvas, historyBuffer, '#f97316');
    drawLogSpectrum(spectrumCanvas, spec, sr);
    drawFillHistory(energyLow, energyLowHistory, 'rgba(34,197,94,0.9)');
    drawFillHistory(energyMid, energyMidHistory, 'rgba(249,115,22,0.9)');
    drawFillHistory(energyHigh, energyHighHistory, 'rgba(96,165,250,0.9)');

    // bins energy and small history
    bins.forEach((b,idx)=>{
      let sum=0,c=0; for(let i=b.iLo;i<=b.iHi && i<spec.length;i++){ sum += spec[i]; c++; } const val = c? sum/(c*255):0; b.energy = val; if(sampleTick) pushHistory(val, b.history); const el = document.getElementById('bin-'+idx); if(el){ el.querySelector('.bin-energy').textContent = val.toFixed(2); const canvas = el.querySelector('canvas'); const cc = canvas.getContext('2d'); cc.clearRect(0,0,canvas.width,canvas.height); cc.fillStyle = '#60a5fa'; const w2 = canvas.width, h2 = canvas.height; for(let i=0;i<b.history.length;i++){ const x = Math.floor((i / Math.max(1, historyLen - 1)) * w2); const y = h2 - Math.floor(b.history[i] * h2); cc.fillRect(x, y, Math.max(1, Math.floor(w2 / historyLen)), Math.max(1, Math.floor(h2*0.6))); } }
    });

    // debug
    dbgDevice.textContent = selLabel.textContent || '-'; dbgTab.textContent = document.visibilityState; dbgAge.textContent = Math.round(performance.now() - lastUpdate) + ' ms';

    requestAnimationFrame(runAnalyser);
  }

  // BPM handling (simple manual-driven flash/counter)
  function applyManualBpm(){ const v = Number(bpmInput.value) || 0; if(v >= 20 && v <= 300){ manualBpm = v; bpmDisplay.textContent = v + ' BPM'; startBpmCounter(); } }
  function resetManualBpm(){ manualBpm = null; bpmDisplay.textContent = '—'; stopBpmCounter(); }
  function startBpmCounter(){ stopBpmCounter(); if(!manualBpm) return; const interval = (60 / manualBpm) * 1000; let step=0; bpmCounter.textContent = '1'; bpmIntervalId = setInterval(()=>{ step = (step+1) % 4; bpmCounter.textContent = String(step+1); }, interval); }
  function stopBpmCounter(){ if(bpmIntervalId) clearInterval(bpmIntervalId); bpmIntervalId = null; bpmCounter.textContent = '—'; }

  // events
  btnStart.addEventListener('click', async ()=>{ const id = deviceSelect.value || undefined; await start(id); });
  btnStop.addEventListener('click', ()=>{ stop(); });
  applyBpm.addEventListener('click', ()=> applyManualBpm());
  resetBpm.addEventListener('click', ()=> resetManualBpm());
  btnReset.addEventListener('click', ()=>{ clearAnalysis(); });

  document.addEventListener('visibilitychange', ()=>{ dbgTab.textContent = document.visibilityState; });

  // boot
  (async ()=>{ try{ await enumerateDevices(); await navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{ s.getTracks().forEach(t=>t.stop()); }).catch(()=>{}); // warm permissions
    // try to preselect first device
    setTimeout(()=>{ if(deviceSelect.options.length) deviceSelect.selectedIndex = 0; },200);
    // init canvas sizes
    [waveCanvas, spectrumCanvas, historyCanvas, energyLow, energyMid, energyHigh].forEach(c=>{ if(c){ c.width = c.clientWidth * (devicePixelRatio||1); c.height = c.clientHeight * (devicePixelRatio||1); } });
  }catch(e){ logError(e); } })();

})();
