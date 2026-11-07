// Pitch and voice-quality front end running inside an AudioWorklet.
//
// Every `hop` samples (about 10 ms) it analyses the last `windowSize` samples and posts one
// message with the raw measurements; the main thread (MicAnalyzer + pitchTrack.ts) turns them
// into a smoothed pitch and the voice-quality fields:
//   { t, rms, peak, silent: true }                         below the level gate
//   { t, rms, peak, silent: false, dmin, hz: [...], d: [...], bands: [6 × dB], centroid }
// `hz`/`d` are the local minima ("dips") of the YIN cumulative-mean-normalised difference function
// in ascending period order, each with its interpolated depth: the pYIN candidates. `bands` is
// the mean power (dB) of the octave bands 100-200 … 3200-6400 Hz of the Hann-windowed spectrum
// and `centroid` the spectral centroid in Hz (60 Hz – 8 kHz).
//
// Messages to the worklet: { gate: linearRms } sets the level gate; { onsets: true|false } turns
// on click-onset detection for the latency measurement, which posts { onset: tCtx } at the first
// sample of each detected transient (sample-accurate, refractory 250 ms).
//
// This file is plain JS (audioWorklet.addModule cannot import modules). The DSP is written as
// methods so the self-test can load it in Node with a shim for the worklet globals.
class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.win = o.windowSize || 2048;
    this.hop = o.hop || 512;
    this.fmin = o.fmin || 60;
    this.fmax = o.fmax || 1200;
    this.gate = o.gate || 0.005; // linear rms
    this.maxDips = o.maxDips || 12;
    this.dipCeiling = o.dipCeiling || 0.95; // dips shallower than this are never candidates
    this.ring = new Float32Array(this.win * 2);
    this.writePos = 0;
    this.sinceLast = 0;
    this.frame = new Float32Array(this.win);
    this.tauMin = Math.max(2, Math.floor(sampleRate / this.fmax));
    this.tauMax = Math.min(this.win >> 1, Math.ceil(sampleRate / this.fmin));
    this.d = new Float32Array(this.tauMax + 2);
    // spectrum
    this.fftSize = this.win;
    this.fftBits = Math.round(Math.log2(this.fftSize));
    if (1 << this.fftBits !== this.fftSize) throw new Error('windowSize must be a power of two');
    this.re = new Float32Array(this.fftSize);
    this.im = new Float32Array(this.fftSize);
    this.hann = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.fftSize);
    this.rev = new Uint16Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      let r = 0;
      for (let b = 0; b < this.fftBits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cosT = new Float32Array(this.fftSize / 2);
    this.sinT = new Float32Array(this.fftSize / 2);
    for (let i = 0; i < this.fftSize / 2; i++) {
      this.cosT[i] = Math.cos((-2 * Math.PI * i) / this.fftSize);
      this.sinT[i] = Math.sin((-2 * Math.PI * i) / this.fftSize);
    }
    this.power = new Float32Array(this.fftSize / 2 + 1);
    this.binHz = sampleRate / this.fftSize;
    this.bandEdges = [100, 200, 400, 800, 1600, 3200, 6400];
    // onset detection (latency measurement)
    this.onsets = false;
    this.envFloor = 0;
    this.lastOnset = -1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (typeof m.gate === 'number') this.gate = m.gate;
      if (typeof m.onsets === 'boolean') {
        this.onsets = m.onsets;
        this.envFloor = 0;
        this.lastOnset = -1;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.ring[this.writePos] = ch[i];
      this.writePos = (this.writePos + 1) % this.ring.length;
    }
    if (this.onsets) this.detectOnset(ch, currentTime);
    this.sinceLast += ch.length;
    if (this.sinceLast >= this.hop) {
      this.sinceLast = 0;
      // the window ends with the block just received
      this.analyze(currentTime + ch.length / sampleRate);
    }
    return true;
  }

  /** Energy-envelope onset detector on 128-sample blocks: posts the context time of the first loud sample. */
  detectOnset(ch, blockTime) {
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    if (this.envFloor === 0) this.envFloor = Math.max(rms, 1e-4);
    const thr = Math.max(4 * this.envFloor, 0.01);
    const refractory = blockTime - this.lastOnset < 0.25;
    if (rms > thr && !refractory) {
      const sampleThr = Math.max(3 * this.envFloor, 0.006);
      let idx = 0;
      for (let i = 0; i < ch.length; i++) {
        const a = ch[i] < 0 ? -ch[i] : ch[i];
        if (a > sampleThr) {
          idx = i;
          break;
        }
      }
      this.lastOnset = blockTime;
      this.port.postMessage({ onset: blockTime + idx / sampleRate, rms });
    } else if (rms < 2 * this.envFloor) {
      // track the floor slowly, and only when nothing loud is happening
      this.envFloor = 0.98 * this.envFloor + 0.02 * Math.max(rms, 1e-4);
    }
  }

  analyze(t) {
    const W = this.win;
    const f = this.frame;
    let p = (this.writePos - W + this.ring.length) % this.ring.length;
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < W; i++) {
      const v = this.ring[p];
      f[i] = v;
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      p = (p + 1) % this.ring.length;
    }
    const rms = Math.sqrt(sum / W);
    if (rms < this.gate) {
      this.port.postMessage({ t, hz: 0, rms, peak, silent: true });
      return;
    }
    const dips = this.yinDips(f);
    const spec = this.spectrum(f);
    this.port.postMessage({
      t,
      rms,
      peak,
      silent: false,
      dmin: dips.dmin,
      hz: dips.hz,
      d: dips.d,
      bands: spec.bands,
      centroid: spec.centroid,
    });
  }

  /**
   * YIN cumulative-mean-normalised difference over the period range, then every local minimum
   * below `dipCeiling` with parabolic interpolation of period and depth (minima closer than 3 %
   * in period are one valley split by noise and are merged into the deepest). Once a deep dip
   * (d < 0.1) is found the scan stops a little past twice its period (the octave-below dip):
   * sub-octave candidates beyond that are never chosen, and this keeps the per-hop cost within
   * about 2× of the old "first dip" tracker on voiced frames (unvoiced frames cost the same).
   */
  yinDips(f) {
    const half = this.win >> 1;
    const d = this.d;
    const tauMax = this.tauMax;
    let tauStop = tauMax;
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauStop; tau++) {
      // four independent accumulators: the JIT keeps them in registers (half is a multiple of 4)
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let i = 0; i < half; i += 4) {
        const j = i + tau;
        const d0 = f[i] - f[j];
        const d1 = f[i + 1] - f[j + 1];
        const d2 = f[i + 2] - f[j + 2];
        const d3 = f[i + 3] - f[j + 3];
        a0 += d0 * d0;
        a1 += d1 * d1;
        a2 += d2 * d2;
        a3 += d3 * d3;
      }
      const acc = a0 + a1 + a2 + a3;
      running += acc;
      const nd = running > 0 ? (acc * tau) / running : 1;
      d[tau] = nd;
      // a deep dip at period T: the octave-below dip sits at 2T, nothing useful beyond ~2.15T
      if (tauStop === tauMax && tau >= this.tauMin && nd < 0.1) tauStop = Math.min(tauMax, Math.ceil(tau * 2.15) + 3);
    }
    const hz = [];
    const dd = [];
    let dmin = 1;
    const lo = Math.max(2, this.tauMin);
    const hi = tauStop - 1;
    for (let tau = lo; tau <= hi; tau++) {
      const s1 = d[tau];
      if (s1 >= this.dipCeiling) continue;
      const s0 = d[tau - 1];
      const s2 = d[tau + 1];
      if (!(s1 < s0 && s1 <= s2)) continue;
      let tauEst = tau;
      let dEst = s1;
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) {
        const delta = (s2 - s0) / denom;
        if (delta > -1 && delta < 1) {
          tauEst = tau + delta;
          dEst = s1 - 0.25 * (s0 - s2) * delta;
        }
      }
      if (dEst < 0) dEst = 0;
      if (dEst < dmin) dmin = dEst;
      // noise splits one valley into several local minima a few samples apart: keep the deepest
      const last = hz.length - 1;
      if (last >= 0 && sampleRate / hz[last] > tauEst / 1.03) {
        if (dEst < dd[last]) {
          hz[last] = sampleRate / tauEst;
          dd[last] = dEst;
        }
        continue;
      }
      if (hz.length < this.maxDips) {
        hz.push(sampleRate / tauEst);
        dd.push(dEst);
      } else {
        // keep the deepest `maxDips` dips, preserving period order
        let worst = 0;
        for (let k = 1; k < dd.length; k++) if (dd[k] > dd[worst]) worst = k;
        if (dEst < dd[worst]) {
          hz.splice(worst, 1);
          dd.splice(worst, 1);
          hz.push(sampleRate / tauEst);
          dd.push(dEst);
        }
      }
    }
    return { hz, d: dd, dmin };
  }

  /** Hann-windowed power spectrum → octave band mean powers (dB) and spectral centroid (Hz). */
  spectrum(f) {
    const N = this.fftSize;
    const re = this.re;
    const im = this.im;
    const rev = this.rev;
    const hann = this.hann;
    for (let i = 0; i < N; i++) {
      re[rev[i]] = f[i] * hann[i];
      im[i] = 0;
    }
    for (let size = 2; size <= N; size <<= 1) {
      const halfSize = size >> 1;
      const step = N / size;
      for (let start = 0; start < N; start += size) {
        for (let j = 0, k = 0; j < halfSize; j++, k += step) {
          const wr = this.cosT[k];
          const wi = this.sinT[k];
          const a = start + j;
          const b = a + halfSize;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    const power = this.power;
    const half = N >> 1;
    for (let k = 0; k <= half; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    const binHz = this.binHz;
    const bands = [];
    const edges = this.bandEdges;
    for (let b = 0; b + 1 < edges.length; b++) {
      const k0 = Math.max(1, Math.ceil(edges[b] / binHz));
      const k1 = Math.min(half, Math.floor(edges[b + 1] / binHz));
      if (k1 < k0) {
        bands.push(-200);
        continue;
      }
      let s = 0;
      for (let k = k0; k <= k1; k++) s += power[k];
      const meanP = s / (k1 - k0 + 1);
      bands.push(meanP > 1e-20 ? 10 * Math.log10(meanP) : -200);
    }
    const c0 = Math.max(1, Math.ceil(60 / binHz));
    const c1 = Math.min(half, Math.floor(8000 / binHz));
    let num = 0;
    let den = 0;
    for (let k = c0; k <= c1; k++) {
      num += k * binHz * power[k];
      den += power[k];
    }
    return { bands, centroid: den > 0 ? num / den : 0 };
  }
}
registerProcessor('pitch-processor', PitchProcessor);
