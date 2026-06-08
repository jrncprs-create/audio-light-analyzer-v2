// Audio Light Analyzer v2 - simple, vanilla JS
(() => {
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

  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let mediaStream = null;

  const fftSize = 2048;
  const historySeconds = 10;
  const historyStepMs = 80;
  const historyLen = Math.floor((historySeconds * 1000) / historyStepMs);
  const nBins = 24;

  const historyBuffer = new Array(historyLen).fill(0);
  const lowHistory = new Array(historyLen).fill(0);
  const midHistory = new Array(historyLen).fill(0);
  const highHistory = new Array(historyLen).fill(0);
  const bins = [];

  let lastFrameAt = performance.now();
  let lastHistoryAt = 0;
  let lastError = null;
  let manualBpm = null;
  let bpmIntervalId = null;

  function logError(error) {
    lastError = error && error.message ? error.message : String(error);
    dbgError.textContent = lastError;
  }

  function pushLimited(array, value) {
    array.push(value);
    while (array.length > historyLen) array.shift();
  }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    return { ctx, width, height, dpr };
  }

  function clearCanvas(canvas) {
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function drawHistoryLine(canvas, values, color, scale = 1, fill = false) {
    const { ctx, width, height } = clearCanvas(canvas);
    if (!values.length) return;

    ctx.lineWidth = Math.max(2, width / 900);
    ctx.strokeStyle = color;
    ctx.beginPath();

    for (let i = 0; i < values.length; i++) {
      const x = values.length === 1 ? 0 : (i / (values.length - 1)) * width;
      const normalized = Math.max(0, Math.min(1, values[i] * scale));
      const y = height - normalized * (height * 0.86) - height * 0.07;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (fill) {
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = color.replace('1)', '0.18)').replace('0.95)', '0.18)');
      ctx.fill();
    }
  }

  function drawMultiEnergy() {
    drawHistoryLine(energyLow, lowHistory, 'rgba(34,197,94,0.95)', 1.4, true);
    drawHistoryLine(energyMid, midHistory, 'rgba(249,115,22,0.95)', 1.4, true);
    drawHistoryLine(energyHigh, highHistory, 'rgba(96,165,250,0.95)', 1.4, true);
  }

  function initBins(size, sampleRate) {
    bins.length = 0;
    const minHz = 20;
    const maxHz = 12000;
    const minLog = Math.log(minHz);
    const maxLog = Math.log(maxHz);
    const freqPerIndex = sampleRate / size;

    for (let i = 0; i < nBins; i++) {
      const a = i / nBins;
      const b = (i + 1) / nBins;
      const lo = Math.exp(minLog + (maxLog - minLog) * a);
      const hi = Math.exp(minLog + (maxLog - minLog) * b);
      const iLo = Math.max(0, Math.floor(lo / freqPerIndex));
      const iHi = Math.min(Math.floor(size / 2) - 1, Math.ceil(hi / freqPerIndex));
      bins.push({ minHz: lo, maxHz: hi, iLo, iHi, energy: 0, history: new Array(historyLen).fill(0) });
    }
    renderBins();
  }

  function renderBins() {
    freqGrid.innerHTML = '';
    bins.forEach((bin, index) => {
      const element = document.createElement('div');
      element.className = 'freq-bin';
      element.id = `bin-${index}`;
      element.innerHTML = `
        <div><strong>${Math.round(bin.minHz)}–${Math.round(bin.maxHz)} Hz</strong></div>
        <div class="bin-energy">0.00</div>
        <canvas class="mini"></canvas>
      `;
      freqGrid.appendChild(element);
    });
  }

  async function enumerateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput');
      dbgInputs.textContent = inputs.map((device) => device.label || device.deviceId || 'Unnamed input').join('\n') || '-';
      deviceSelect.innerHTML = '';
      inputs.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || device.deviceId || 'Unnamed input';
        deviceSelect.appendChild(option);
      });
      return inputs;
    } catch (error) {
      logError(error);
      return [];
    }
  }

  async function start(deviceId) {
    try {
      if (!navigator.mediaDevices) throw new Error('getUserMedia not supported');
      stop();

      const audioConstraint = deviceId ? { deviceId: { exact: deviceId } } : true;
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0.28;
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

      selLabel.textContent = mediaStream.getAudioTracks()[0].label || '—';
      sampleRateEl.textContent = audioCtx.sampleRate || '—';
      dbgError.textContent = '-';
      lastError = null;
      initBins(analyser.fftSize, audioCtx.sampleRate);
      btnStart.disabled = true;
      btnStop.disabled = false;
      lastFrameAt = performance.now();
      lastHistoryAt = 0;
      requestAnimationFrame(runAnalyser);
      await enumerateDevices();
    } catch (error) {
      logError(error);
      btnStart.disabled = false;
      btnStop.disabled = true;
    }
  }

  function stop() {
    try {
      if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
      if (sourceNode) sourceNode.disconnect();
      if (audioCtx) audioCtx.close();
    } catch (error) {
      logError(error);
    }
    mediaStream = null;
    sourceNode = null;
    analyser = null;
    audioCtx = null;
    btnStart.disabled = false;
    btnStop.disabled = true;
  }

  function clearAnalysis() {
    historyBuffer.fill(0);
    lowHistory.fill(0);
    midHistory.fill(0);
    highHistory.fill(0);
    bins.forEach((bin) => bin.history.fill(0));
    bpmCounter.textContent = manualBpm ? '1' : '—';
    [waveCanvas, spectrumCanvas, historyCanvas, energyLow, energyMid, energyHigh].forEach(clearCanvas);
    document.querySelectorAll('.freq-bin canvas').forEach(clearCanvas);
  }

  function energyInRange(spec, lo, hi) {
    if (!audioCtx || !analyser) return 0;
    const freqPerIndex = audioCtx.sampleRate / analyser.fftSize;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < spec.length; i++) {
      const frequency = i * freqPerIndex;
      if (frequency >= lo && frequency < hi) {
        sum += spec[i];
        count++;
      }
    }
    return count ? sum / (count * 255) : 0;
  }

  function drawWaveform(buffer) {
    const { ctx, width, height } = clearCanvas(waveCanvas);
    ctx.lineWidth = Math.max(2, width / 900);
    ctx.strokeStyle = '#60a5fa';
    ctx.beginPath();
    for (let i = 0; i < buffer.length; i++) {
      const x = (i / (buffer.length - 1)) * width;
      const y = (buffer[i] / 255) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawSpectrum(spec) {
    const { ctx, width, height } = clearCanvas(spectrumCanvas);
    const visibleBins = Math.min(spec.length, 720);
    const barWidth = Math.max(1, width / visibleBins);

    for (let i = 0; i < visibleBins; i++) {
      const value = spec[i] / 255;
      const boosted = Math.min(1, Math.pow(value, 0.72) * 1.18);
      const barHeight = boosted * height;
      ctx.fillStyle = `rgba(96,165,250,${0.38 + boosted * 0.62})`;
      ctx.fillRect(i * barWidth, height - barHeight, Math.max(1, barWidth - 1), barHeight);
    }
  }

  function drawMiniBin(bin, index) {
    const element = document.getElementById(`bin-${index}`);
    if (!element) return;
    const energyLabel = element.querySelector('.bin-energy');
    const canvas = element.querySelector('canvas');
    if (energyLabel) energyLabel.textContent = bin.energy.toFixed(2);
    if (!canvas) return;
    drawHistoryLine(canvas, bin.history, 'rgba(96,165,250,0.95)', 1.7, true);
  }

  function runAnalyser() {
    if (!analyser) return;

    const now = performance.now();
    lastFrameAt = now;

    const waveform = new Uint8Array(analyser.fftSize);
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(waveform);
    analyser.getByteFrequencyData(spectrum);

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < waveform.length; i++) {
      const value = (waveform[i] - 128) / 128;
      sum += value * value;
      peak = Math.max(peak, Math.abs(value));
    }

    const rms = Math.sqrt(sum / waveform.length);
    rmsEl.textContent = rms.toFixed(3);
    peakEl.textContent = peak.toFixed(3);
    signalStateEl.textContent = rms > 0.002 ? 'signal' : 'no signal';

    const low = energyInRange(spectrum, 20, 200);
    const mid = energyInRange(spectrum, 200, 2000);
    const high = energyInRange(spectrum, 2000, 12000);

    if (now - lastHistoryAt >= historyStepMs) {
      pushLimited(historyBuffer, Math.max(rms, peak * 0.35));
      pushLimited(lowHistory, low);
      pushLimited(midHistory, mid);
      pushLimited(highHistory, high);
      bins.forEach((bin) => {
        let binSum = 0;
        let count = 0;
        for (let i = bin.iLo; i <= bin.iHi && i < spectrum.length; i++) {
          binSum += spectrum[i];
          count++;
        }
        bin.energy = count ? binSum / (count * 255) : 0;
        pushLimited(bin.history, bin.energy);
      });
      lastHistoryAt = now;
    }

    drawWaveform(waveform);
    drawSpectrum(spectrum);
    drawHistoryLine(historyCanvas, historyBuffer, 'rgba(249,115,22,0.95)', 5.2, true);
    drawMultiEnergy();
    bins.forEach(drawMiniBin);

    dbgDevice.textContent = selLabel.textContent || '-';
    dbgTab.textContent = document.visibilityState;
    dbgAge.textContent = `${Math.round(performance.now() - lastFrameAt)} ms`;

    requestAnimationFrame(runAnalyser);
  }

  function applyManualBpm() {
    const value = Number(bpmInput.value) || 0;
    if (value >= 20 && value <= 300) {
      manualBpm = value;
      bpmDisplay.textContent = `${value} BPM`;
      startBpmCounter();
    }
  }

  function resetManualBpm() {
    manualBpm = null;
    bpmDisplay.textContent = '—';
    stopBpmCounter();
  }

  function startBpmCounter() {
    stopBpmCounter();
    if (!manualBpm) return;
    const interval = (60 / manualBpm) * 1000;
    let step = 0;
    bpmCounter.textContent = '1';
    bpmIntervalId = setInterval(() => {
      step = (step + 1) % 4;
      bpmCounter.textContent = String(step + 1);
    }, interval);
  }

  function stopBpmCounter() {
    if (bpmIntervalId) clearInterval(bpmIntervalId);
    bpmIntervalId = null;
    bpmCounter.textContent = '—';
  }

  btnStart.addEventListener('click', async () => {
    const id = deviceSelect.value || undefined;
    await start(id);
  });

  btnStop.addEventListener('click', stop);
  applyBpm.addEventListener('click', applyManualBpm);
  resetBpm.addEventListener('click', resetManualBpm);
  btnReset.addEventListener('click', clearAnalysis);

  document.addEventListener('visibilitychange', () => {
    dbgTab.textContent = document.visibilityState;
  });

  window.addEventListener('resize', () => {
    [waveCanvas, spectrumCanvas, historyCanvas, energyLow, energyMid, energyHigh].forEach(clearCanvas);
  });

  (async () => {
    try {
      initBins(fftSize, 48000);
      await enumerateDevices();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        await enumerateDevices();
      } catch (_) {
        // Permission can be granted later by pressing Start.
      }
      if (deviceSelect.options.length) deviceSelect.selectedIndex = 0;
      dbgTab.textContent = document.visibilityState;
      dbgError.textContent = '-';
      clearAnalysis();
    } catch (error) {
      logError(error);
    }
  })();
})();