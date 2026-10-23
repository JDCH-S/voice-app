/// <reference lib="webworker" />
// WSOLA time stretcher. Input: channels at any sample rate, factor = output length / input length.
// The same alignment offsets are used for every channel (found on the mono sum) to keep stereo coherent.

interface Req {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  factor: number;
}

function wsola(channels: Float32Array[], sampleRate: number, factor: number): Float32Array[] {
  const n = channels[0].length;
  const frame = Math.round(sampleRate * 0.05); // 50 ms
  const hopOut = frame >> 1;
  const hopIn = hopOut / factor;
  const tol = Math.round(sampleRate * 0.012); // +-12 ms search
  const outLen = Math.floor(n * factor) + frame;
  const outs = channels.map(() => new Float32Array(outLen));
  const norm = new Float32Array(outLen);
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));

  // mono sum for alignment
  const mono = channels.length === 1 ? channels[0] : new Float32Array(n);
  if (channels.length > 1) {
    for (let c = 0; c < channels.length; c++) {
      const d = channels[c];
      for (let i = 0; i < n; i++) mono[i] += d[i] / channels.length;
    }
  }
  const monoOut = new Float32Array(outLen);

  const corrLen = Math.min(hopOut, 1024);
  const stride = 4;
  let outPos = 0;
  let prevInStart = -1;
  let frameIdx = 0;
  while (true) {
    const nominal = Math.round(frameIdx * hopIn);
    if (nominal + frame >= n) break;
    let inStart = nominal;
    if (prevInStart >= 0) {
      // natural continuation would be prevInStart + hopOut; search near nominal for the best match to it
      const target = prevInStart + hopOut;
      let best = -Infinity;
      let bestOff = 0;
      const lo = Math.max(0, nominal - tol);
      const hi = Math.min(n - frame - 1, nominal + tol);
      for (let cand = lo; cand <= hi; cand += 2) {
        let acc = 0;
        for (let k = 0; k < corrLen; k += stride) {
          acc += mono[target + k] * mono[cand + k];
        }
        if (acc > best) {
          best = acc;
          bestOff = cand;
        }
      }
      inStart = bestOff;
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = outs[c];
      for (let k = 0; k < frame; k++) dst[outPos + k] += src[inStart + k] * win[k];
    }
    for (let k = 0; k < frame; k++) {
      monoOut[outPos + k] += mono[inStart + k] * win[k];
      norm[outPos + k] += win[k];
    }
    prevInStart = inStart;
    outPos += hopOut;
    frameIdx++;
  }
  const finalLen = Math.min(outLen, outPos + hopOut);
  const result = outs.map((o) => {
    const r = new Float32Array(finalLen);
    for (let i = 0; i < finalLen; i++) r[i] = norm[i] > 1e-3 ? o[i] / norm[i] : 0;
    return r;
  });
  return result;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, channels, sampleRate, factor } = e.data;
  const out = wsola(channels, sampleRate, factor);
  (self as unknown as Worker).postMessage({ id, channels: out }, out.map((c) => c.buffer));
};
