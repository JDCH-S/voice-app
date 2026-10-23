// YIN pitch tracker running inside an AudioWorklet.
// Posts { t, hz, clarity, rms } roughly every `hop` samples (about 10 ms).
class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.win = o.windowSize || 2048;
    this.hop = o.hop || 512;
    this.threshold = o.threshold || 0.15;
    this.fmin = o.fmin || 60;
    this.fmax = o.fmax || 1200;
    this.gate = o.gate || 0.005; // linear rms
    this.ring = new Float32Array(this.win * 2);
    this.writePos = 0;
    this.sinceLast = 0;
    this.frame = new Float32Array(this.win);
    this.tauMin = Math.max(2, Math.floor(sampleRate / this.fmax));
    this.tauMax = Math.min(this.win >> 1, Math.ceil(sampleRate / this.fmin));
    this.d = new Float32Array(this.tauMax + 1);
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.gate === 'number') this.gate = e.data.gate;
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
    this.sinceLast += ch.length;
    if (this.sinceLast >= this.hop) {
      this.sinceLast = 0;
      this.analyze();
    }
    return true;
  }

  analyze() {
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
    const t = currentTime;
    if (rms < this.gate) {
      this.port.postMessage({ t, hz: 0, clarity: 0, rms, peak });
      return;
    }
    const half = W >> 1;
    const d = this.d;
    const tauMax = this.tauMax;
    d[0] = 1;
    let running = 0;
    let bestTau = -1;
    let bestVal = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0;
      for (let i = 0; i < half; i++) {
        const diff = f[i] - f[i + tau];
        acc += diff * diff;
      }
      running += acc;
      const nd = running > 0 ? (acc * tau) / running : 1;
      d[tau] = nd;
      if (tau >= this.tauMin) {
        if (bestTau < 0 && nd < this.threshold) {
          // walk to the local minimum
          let k = tau;
          while (k + 1 <= tauMax) {
            let acc2 = 0;
            for (let i = 0; i < half; i++) {
              const diff = f[i] - f[i + k + 1];
              acc2 += diff * diff;
            }
            running += acc2;
            const nd2 = (acc2 * (k + 1)) / running;
            d[k + 1] = nd2;
            if (nd2 < d[k]) k++;
            else break;
          }
          bestTau = k;
          bestVal = d[k];
          break;
        }
        if (nd < bestVal) {
          bestVal = nd;
          if (bestTau < 0) this._fallbackTau = tau;
        }
      }
    }
    if (bestTau < 0) {
      // no dip under threshold: use the global minimum if it is reasonably clear
      if (bestVal < 0.5 && this._fallbackTau) bestTau = this._fallbackTau;
      else {
        this.port.postMessage({ t, hz: 0, clarity: 1 - bestVal, rms, peak });
        return;
      }
    }
    // parabolic interpolation around bestTau
    let tauEst = bestTau;
    if (bestTau > 1 && bestTau < tauMax) {
      const s0 = d[bestTau - 1];
      const s1 = d[bestTau];
      const s2 = d[bestTau + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) tauEst = bestTau + (s2 - s0) / denom;
    }
    const hz = sampleRate / tauEst;
    const clarity = Math.max(0, Math.min(1, 1 - d[bestTau]));
    this.port.postMessage({ t, hz, clarity, rms, peak });
  }
}
registerProcessor('pitch-processor', PitchProcessor);
