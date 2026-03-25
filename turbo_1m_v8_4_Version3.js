// TURBO 1M — Ultra-fast indicator for 1-minute candles (normal candles, NOT Heikin-Ashi)
// v8.5 — fixy: TP/SL od i+1, reset state pełny, TP/SL z avgPrice, NaN=0 w scoringu
(function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    // --- toggle ---
    enabled: false,

    // --- breakout ---
    swingLen: 3,
    breakByClose: true,

    // --- EMA ---
    fastEma: 9,
    slowEma: 21,

    // --- ATR ---
    atrLen: 7,
    minAtrPct: 0.05,

    // --- RSI ---
    rsiLen: 7,
    rsiMid: 52,
    rsiExtreme: 30,

    // --- ADX — hard filter ---
    adxLen: 7,
    adxMin: 18,

    // --- Volume ---
    volSmaLen: 10,
    volMultiplier: 1.15,

    // --- Fibonacci — rolling window ---
    fibA: 0.382,
    fibB: 0.618,
    fibLookback: 100,

    // --- Scoring ---
    minScore: 4.0,
    minTriggerScore: 1.5, // minimalna suma wag trigger (trend+breakout+burst) wymagana do wygenerowania sygnału
    warmupBars: 100,      // liczba początkowych barów pomijanych (warmup wskaźników); sugerowana: max lookback + ~10
    cooldown: 2,

    // --- Entry mode ---
    entryMode: 'nextOpen',

    // --- Same-side / reverse policy ---
    sameSidePolicy: 'ignore',
    maxAdds: 1,
    minBarsBetweenAdds: 5,
    reversePolicy: 'reverseImmediately',

    // --- Add filters ---
    addOnlyIfInProfit: false,
    addOnlyIfPullback: false,
    addOnlyIfBreakout: false,
    minDistanceFromLastAddAtr: 0.5,

    // --- TP/SL ---
    tpSystem: 'atrBased',
    tpPercent: 0.4,
    slPercent: 0.25,
    tpAtrMult: 1.5,
    slAtrMult: 1.0,

    // --- Market regime ---
    useMarketRegime: true,
    regimeAdxTrend: 22,
    regimeAdxChop: 14,
    regimeAtrExpFactor: 1.4,

    // --- Micro-struktura ---
    useMicroBreakouts: true,
    useMomentumBursts: true,
    useVWAP: true,
    vwapWindow: 60,
    vwapDevThreshold: 0.12,
    useRangeExpansion: true,
    rangeExpFactor: 1.3,
    useWickAnalysis: true,
    wickRejectionRatio: 0.6,
    useDeltaVolume: true,
    deltaThreshold: 0.2,

    // --- FVG Cloud ---
    fvgLen: 3,
    fvgSmoothLen: 5,
    cloudFastPeriod: 20,
    cloudFastMethod: 1,
    cloudSlowPeriod: 50,
    cloudSlowMethod: 0,

    // --- Debug ---
    debugSignals: true,
    debugMaxRecords: 10000
  });

  const WEIGHTS = Object.freeze({
    trend:     2.0,
    breakout:  2.0,
    rsi:       1.0,
    volume:    1.5,
    atr:       0.5,
    fib:       0.5,
    burst:     1.0,
    expansion: 1.0,
    wick:      0.5,
    vwap:      0.5,
    delta:     1.0
  });

  // ─── helpers ─────────────────────────────────────────────────────────────

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  function clampNum(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function getEl(id) {
    if (!id || typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
    return document.getElementById(id);
  }

  function readBool(el, fallback) { return el ? !!el.checked : !!fallback; }
  function readNum(el, fallback) {
    if (!el) return fallback;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeTpSystem(value, fallback) {
    const v = String(value || '').toLowerCase().replace(/[_\s-]/g, '');
    if (v === 'classic') return 'classic';
    if (v === 'off' || v === 'none' || v === '0') return 'off';
    if (v === 'fvgcloud' || v === 'fvg') return 'fvgCloud';
    if (v === 'atrbased' || v === 'atr') return 'atrBased';
    return fallback || 'atrBased';
  }

  function normalizeEntryMode(value) {
    const v = String(value || '').toLowerCase().replace(/[_\s]/g, '');
    if (v === 'nextopen') return 'nextOpen';
    if (v === 'nextmid') return 'nextMid';
    return 'close';
  }

  function normalizeSameSidePolicy(value) {
    const v = String(value || '').toLowerCase().replace(/[_\s-]/g, '');
    if (v === 'add') return 'add';
    if (v === 'tightenonly') return 'tightenOnly';
    return 'ignore';
  }

  function normalizeReversePolicy(value) {
    const v = String(value || '').toLowerCase().replace(/[_\s-]/g, '');
    if (v === 'closethenwait') return 'closeThenWait';
    if (v === 'reduceonly') return 'reduceOnly';
    if (v === 'ignoreoppositeuntilexit') return 'ignoreOppositeUntilExit';
    return 'reverseImmediately';
  }

  function emptyResult() {
    return {
      buyIdx: [], sellIdx: [], buyPrice: [], sellPrice: [],
      tpIdx: [], tpPrice: [], slIdx: [], slPrice: [],
      manageIdx: [], managePrice: [], manageAction: [], manageMeta: [],
      debugSignals: [], debugBlocked: []
    };
  }

  // ─── wskaźniki ────────────────────────────────────────────────────────────

  function emaSeries(arr, len) {
    const out = new Array(arr.length).fill(NaN);
    if (!Array.isArray(arr) || arr.length === 0) return out;
    const l = Math.max(1, Math.trunc(len)), k = 2 / (l + 1);
    let ema = NaN;
    for (let i = 0; i < arr.length; i++) {
      const v = Number(arr[i]);
      if (!Number.isFinite(v)) { out[i] = ema; continue; }
      ema = !Number.isFinite(ema) ? v : v * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  }

  function smaSeries(arr, len) {
    const out = new Array(arr.length).fill(NaN);
    const l = Math.max(1, Math.trunc(len));
    let sum = 0, count = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = Number(arr[i]);
      if (Number.isFinite(v)) { sum += v; count++; }
      if (i >= l) { const old = Number(arr[i - l]); if (Number.isFinite(old)) { sum -= old; count--; } }
      if (i >= l - 1 && count > 0) out[i] = sum / count;
    }
    return out;
  }

  function atrSeries(high, low, close, len) {
    const n = close.length, out = new Array(n).fill(NaN), l = Math.max(1, Math.trunc(len));
    const tr = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const h = Number(high[i]), lo = Number(low[i]), c = Number(close[i]);
      const prev = i > 0 ? Number(close[i - 1]) : c;
      if (!Number.isFinite(h) || !Number.isFinite(lo) || !Number.isFinite(c) || !Number.isFinite(prev)) continue;
      tr[i] = Math.max(h - lo, Math.abs(h - prev), Math.abs(lo - prev));
    }
    let atr = NaN, sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = Number(tr[i]);
      if (!Number.isFinite(v)) { out[i] = atr; continue; }
      if (i < l) { sum += v; cnt++; if (i === l - 1) { atr = sum / cnt; out[i] = atr; } }
      else { atr = (atr * (l - 1) + v) / l; out[i] = atr; }
    }
    return out;
  }

  function rsiSeries(close, len) {
    const out = new Array(close.length).fill(NaN), l = Math.max(1, Math.trunc(len));
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < close.length; i++) {
      const c = Number(close[i]), p = Number(close[i - 1]);
      if (!Number.isFinite(c) || !Number.isFinite(p)) { out[i] = NaN; continue; }
      const diff = c - p, gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
      if (i <= l) {
        avgGain += gain; avgLoss += loss;
        if (i === l) {
          avgGain /= l; avgLoss /= l;
          out[i] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
        }
      } else {
        avgGain = (avgGain * (l - 1) + gain) / l;
        avgLoss = (avgLoss * (l - 1) + loss) / l;
        out[i] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return out;
  }

  function adxSeries(high, low, close, len) {
    const out = new Array(close.length).fill(NaN), l = Math.max(1, Math.trunc(len));
    if (!Array.isArray(high) || !Array.isArray(low) || !Array.isArray(close) || close.length < 2) return out;
    let smTr = 0, smPlus = 0, smMinus = 0, dxSum = 0, adx = NaN;
    for (let i = 1; i < close.length; i++) {
      const h = Number(high[i]), lo = Number(low[i]), c = Number(close[i]);
      const ph = Number(high[i-1]), pl = Number(low[i-1]), pc = Number(close[i-1]);
      if (!Number.isFinite(h)||!Number.isFinite(lo)||!Number.isFinite(c)||!Number.isFinite(ph)||!Number.isFinite(pl)||!Number.isFinite(pc)) { out[i]=adx; continue; }
      const up=h-ph, dn=pl-lo;
      const plusDM=(up>dn&&up>0)?up:0, minusDM=(dn>up&&dn>0)?dn:0;
      const trueRange=Math.max(h-lo,Math.abs(h-pc),Math.abs(lo-pc));
      if (i<=l) {
        smTr+=trueRange; smPlus+=plusDM; smMinus+=minusDM;
        if (i===l) {
          const pDI=smTr?100*smPlus/smTr:0, mDI=smTr?100*smMinus/smTr:0;
          const dx=(pDI+mDI)?100*Math.abs(pDI-mDI)/(pDI+mDI):0;
          if (l===1) { adx=dx; out[i]=adx; } else dxSum+=dx;
        }
        continue;
      }
      smTr=smTr-smTr/l+trueRange; smPlus=smPlus-smPlus/l+plusDM; smMinus=smMinus-smMinus/l+minusDM;
      const pDI=smTr?100*smPlus/smTr:0, mDI=smTr?100*smMinus/smTr:0;
      const dx=(pDI+mDI)?100*Math.abs(pDI-mDI)/(pDI+mDI):0;
      if (i<2*l) { dxSum+=dx; if (i===2*l-1) { adx=dxSum/l; out[i]=adx; } }
      else { adx=(adx*(l-1)+dx)/l; out[i]=adx; }
    }
    return out;
  }

  function vwapRollingSeries(high, low, close, volume, window) {
    const out = new Array(close.length).fill(NaN), w = Math.max(1, Math.trunc(window));
    let sumPV = 0, sumVol = 0;
    const tp = close.map((_, i) => {
      const h=Number(high[i]),l=Number(low[i]),c=Number(close[i]);
      return (Number.isFinite(h)&&Number.isFinite(l)&&Number.isFinite(c))?(h+l+c)/3:NaN;
    });
    for (let i = 0; i < close.length; i++) {
      const t=tp[i],v=Number(volume[i]);
      if (Number.isFinite(t)&&Number.isFinite(v)) { sumPV+=t*v; sumVol+=v; }
      if (i>=w) { const ot=tp[i-w],ov=Number(volume[i-w]); if (Number.isFinite(ot)&&Number.isFinite(ov)) { sumPV-=ot*ov; sumVol-=ov; } }
      if (i>=w-1&&sumVol>0) out[i]=sumPV/sumVol;
    }
    return out;
  }

  function cumsum(arr) {
    const out=new Array(arr.length).fill(0); let s=0;
    for (let i=0;i<arr.length;i++) { const v=Number(arr[i]); s+=Number.isFinite(v)?v:0; out[i]=s; }
    return out;
  }

  function wmaSeries(arr, len) {
    const out=new Array(arr.length).fill(NaN),l=Math.max(1,Math.trunc(len)),denom=(l*(l+1))/2;
    for (let i=l-1;i<arr.length;i++) {
      let sum=0;
      for (let j=0;j<l;j++) { const v=Number(arr[i-j]); if (Number.isFinite(v)) sum+=v*(l-j); }
      out[i]=sum/denom;
    }
    return out;
  }

  function wilderSeries(arr, len) {
    const out=new Array(arr.length).fill(NaN),l=Math.max(1,Math.trunc(len)); let w=NaN;
    for (let i=0;i<arr.length;i++) {
      const v=Number(arr[i]); if (!Number.isFinite(v)) { out[i]=w; continue; }
      w=!Number.isFinite(w)?v:(w*(l-1)+v)/l; out[i]=w;
    }
    return out;
  }

  function triangularSeries(arr, len) { return smaSeries(smaSeries(arr, len), len); }

  function endPointSeries(arr, len) {
    const out=new Array(arr.length).fill(NaN),l=Math.max(2,Math.trunc(len));
    for (let i=l-1;i<arr.length;i++) {
      let sX=0,sY=0,sXY=0,sX2=0,count=0;
      for (let j=0;j<l;j++) {
        const y=Number(arr[i-l+1+j]);
        if (!Number.isFinite(y)) continue;
        sX+=j;sY+=y;sXY+=j*y;sX2+=j*j;count++;
      }
      // v8.5-fix: używaj count zamiast l przy NaN w oknie
      if (count<2) { if (count===1) out[i]=sY; continue; }
      const d=count*sX2-sX*sX;
      if (d===0) { out[i]=sY/count; continue; }
      const slope=(count*sXY-sX*sY)/d;
      out[i]=(sY-slope*sX)/count+slope*(l-1);
    }
    return out;
  }

  function timeSeriesSeries(arr, len) {
    const out=new Array(arr.length).fill(NaN),l=Math.max(2,Math.trunc(len));
    for (let i=l-1;i<arr.length;i++) {
      let sX=0,sY=0,sXY=0,sX2=0,count=0;
      for (let j=0;j<l;j++) {
        const y=Number(arr[i-l+1+j]);
        if (!Number.isFinite(y)) continue;
        sX+=j;sY+=y;sXY+=j*y;sX2+=j*j;count++;
      }
      // v8.5-fix: używaj count zamiast l przy NaN w oknie
      if (count<2) { if (count===1) out[i]=sY; continue; }
      const d=count*sX2-sX*sX;
      if (d===0) { out[i]=sY/count; continue; }
      const slope=(count*sXY-sX*sY)/d;
      out[i]=(sY-slope*sX)/count+slope*l;
    }
    return out;
  }

  function calculateMA(arr, period, method) {
    switch (method) {
      case 0: return smaSeries(arr, period);      case 1: return emaSeries(arr, period);
      case 2: return wmaSeries(arr, period);      case 3: return wilderSeries(arr, period);
      case 4: return triangularSeries(arr, period); case 5: return endPointSeries(arr, period);
      case 6: return timeSeriesSeries(arr, period); default: return smaSeries(arr, period);
    }
  }

  // ─── Market regime ────────────────────────────────────────────────────────

  function computeMarketRegime(adx, atr, high, low, cfg) {
    const n = adx.length, regime = new Array(n).fill('neutral');
    for (let i = 0; i < n; i++) {
      const a = Number(adx[i]), atrVal = Number(atr[i]);
      const range = Number(high[i]) - Number(low[i]);
      if (!Number.isFinite(a)) continue;
      if (Number.isFinite(range) && Number.isFinite(atrVal) && atrVal > 0 && range >= atrVal * cfg.regimeAtrExpFactor)
        regime[i] = 'expansion';
      else if (a >= cfg.regimeAdxTrend)
        regime[i] = 'trend';
      else if (a < cfg.regimeAdxChop)
        regime[i] = 'chop';
    }
    return regime;
  }

  // ─── rolling high/low (deque, O(n)) ──────────────────────────────────────

  function rollingHighLow(high, low, lookback) {
    const n = high.length, lb = Math.max(1, Math.trunc(lookback));
    const rH = new Array(n).fill(NaN), rL = new Array(n).fill(NaN);
    const maxDeque = [], minDeque = [];
    let maxHead = 0, minHead = 0;
    let validHigh = 0, validLow = 0;

    for (let i = 0; i < n; i++) {
      const windowStart = i - lb + 1;
      const outIdx = i - lb;
      if (outIdx >= 0) {
        if (Number.isFinite(Number(high[outIdx]))) validHigh = Math.max(0, validHigh - 1);
        if (Number.isFinite(Number(low[outIdx])))  validLow  = Math.max(0, validLow  - 1);
      }
      while (maxHead < maxDeque.length && maxDeque[maxHead] < windowStart) maxHead++;
      while (minHead < minDeque.length && minDeque[minHead] < windowStart) minHead++;
      if (maxHead > 1024) { maxDeque.splice(0, maxHead); maxHead = 0; }
      if (minHead > 1024) { minDeque.splice(0, minHead); minHead = 0; }

      const h = Number(high[i]);
      if (Number.isFinite(h)) {
        validHigh += 1;
        while (maxDeque.length > maxHead) {
          const prev = Number(high[maxDeque[maxDeque.length - 1]]);
          if (!Number.isFinite(prev) || prev <= h) maxDeque.pop(); else break;
        }
        maxDeque.push(i);
      }
      const lo = Number(low[i]);
      if (Number.isFinite(lo)) {
        validLow += 1;
        while (minDeque.length > minHead) {
          const prev = Number(low[minDeque[minDeque.length - 1]]);
          if (!Number.isFinite(prev) || prev >= lo) minDeque.pop(); else break;
        }
        minDeque.push(i);
      }
      rH[i] = (validHigh > 0 && maxHead < maxDeque.length) ? Number(high[maxDeque[maxHead]]) : NaN;
      rL[i] = (validLow  > 0 && minHead < minDeque.length) ? Number(low[minDeque[minHead]])  : NaN;
    }
    return { rH, rL };
  }

  // ─── FVG + Cloud ──────────────────────────────────────────────────────────

  function computeFvgDir(high, low, close, fvgLen, smoothLen) {
    const n = close.length;
    const bullLvls = [], bearLvls = [];
    const bullAvg = new Array(n).fill(NaN), bearAvg = new Array(n).fill(NaN);
    const fvgL = Math.max(1, Math.trunc(fvgLen)), smoothL = Math.max(1, Math.trunc(smoothLen));
    for (let i = 2; i < n; i++) {
      if (low[i] > high[i-2] && close[i-1] > high[i-2]) bullLvls.push({ level: high[i-2] });
      if (high[i] < low[i-2] && close[i-1] < low[i-2]) bearLvls.push({ level: low[i-2] });
      while (bullLvls.length > fvgL) bullLvls.shift();
      while (bearLvls.length > fvgL) bearLvls.shift();
      for (let j=bullLvls.length-1;j>=0;j--) if (Number.isFinite(close[i])&&close[i]<bullLvls[j].level) bullLvls.splice(j,1);
      for (let j=bearLvls.length-1;j>=0;j--) if (Number.isFinite(close[i])&&close[i]>bearLvls[j].level) bearLvls.splice(j,1);
      if (bullLvls.length>0) { let s=0; bullLvls.forEach(b=>{s+=b.level;}); bullAvg[i]=s/bullLvls.length; }
      if (bearLvls.length>0) { let s=0; bearLvls.forEach(b=>{s+=b.level;}); bearAvg[i]=s/bearLvls.length; }
    }
    const bullBs=new Array(n).fill(1), bearBs=new Array(n).fill(1);
    for (let i=1;i<n;i++) {
      if (!Number.isFinite(bullAvg[i])) bullBs[i]=bullBs[i-1]+1;
      if (!Number.isFinite(bearAvg[i])) bearBs[i]=bearBs[i-1]+1;
    }
    const cs=cumsum(close);
    const bullSma=new Array(n).fill(NaN), bearSma=new Array(n).fill(NaN);
    for (let i=0;i<n;i++) {
      const bL=Math.min(bullBs[i],smoothL), rL=Math.min(bearBs[i],smoothL);
      if (i>=bL-1&&bL>0) { const st=i-bL; bullSma[i]=(cs[i]-(st>=0?cs[st]:0))/bL; }
      if (i>=rL-1&&rL>0) { const st=i-rL; bearSma[i]=(cs[i]-(st>=0?cs[st]:0))/rL; }
    }
    const bullFinal=bullAvg.map((v,i)=>Number.isFinite(v)?v:bullSma[i]);
    const bearFinal=bearAvg.map((v,i)=>Number.isFinite(v)?v:bearSma[i]);
    const bullDisp=smaSeries(bullFinal,smoothL), bearDisp=smaSeries(bearFinal,smoothL);
    const dir=new Array(n).fill(0); let os=0;
    for (let i=0;i<n;i++) {
      const c=Number(close[i]);
      if (Number.isFinite(c)&&Number.isFinite(bearDisp[i])&&c>bearDisp[i]) os=1;
      else if (Number.isFinite(c)&&Number.isFinite(bullDisp[i])&&c<bullDisp[i]) os=-1;
      dir[i]=os;
    }
    return dir;
  }

  function computeCloudBull(close, fastPeriod, fastMethod, slowPeriod, slowMethod) {
    const fast=calculateMA(close,fastPeriod,fastMethod), slow=calculateMA(close,slowPeriod,slowMethod);
    const bull=new Array(close.length).fill(null); let last=null;
    for (let i=0;i<close.length;i++) {
      const f=Number(fast[i]),s=Number(slow[i]);
      if (Number.isFinite(f)&&Number.isFinite(s)) last=f>=s; bull[i]=last;
    }
    return bull;
  }

  // ─── Micro-struktura ──────────────────────────────────────────────────────

  function detectMicroBreakouts(high, low, close, swingLen) {
    const n=close.length, swing=Math.max(1,Math.trunc(swingLen));
    const microHigh=new Array(n).fill(NaN), microLow=new Array(n).fill(NaN);
    for (let i=swing;i<n-swing;i++) {
      let isH=true,isL=true;
      for (let j=1;j<=swing;j++) {
        if (!isH&&!isL) break;
        if (high[i-j] >= high[i]) isH=false; if (high[i+j] >= high[i]) isH=false;
        if (low[i-j]  <= low[i])  isL=false; if (low[i+j]  <= low[i])  isL=false;
      }
      const c=i+swing; if (c>=n) continue;
      if (isH) microHigh[c]=high[i]; if (isL) microLow[c]=low[i];
    }
    return { microHigh, microLow };
  }

  function detectMomentumBursts(close, volume, volSma, cfg) {
    const n=close.length, bursts=new Array(n).fill(0);
    for (let i=2;i<n;i++) {
      const c0=close[i],c1=close[i-1],c2=close[i-2];
      if (!Number.isFinite(c0)||!Number.isFinite(c1)||!Number.isFinite(c2)) continue;
      if (Math.abs(c2) < 1e-10 || Math.abs(c1) < 1e-10) continue;
      const total=(c0-c2)/c2,ch1=(c1-c2)/c2,ch2=(c0-c1)/c1;
      const volSpike=Number.isFinite(volSma[i])&&volSma[i]>0&&volume[i]>volSma[i]*cfg.volMultiplier;
      if (Math.abs(total)>0.001&&volSpike) {
        if (total>0&&ch1>0&&ch2>0) bursts[i]=1; else if (total<0&&ch1<0&&ch2<0) bursts[i]=-1;
      }
    }
    return bursts;
  }

  function detectRangeExpansion(high, low, atr, cfg) {
    const n=high.length, exp=new Array(n).fill(false);
    for (let i=2;i<n;i++) {
      const range=high[i]-low[i],prev=high[i-1]-low[i-1],a=Number(atr[i]);
      if (!Number.isFinite(range)||!Number.isFinite(prev)||!Number.isFinite(a)) continue;
      if (prev>0&&range>prev*cfg.rangeExpFactor&&range>a) exp[i]=true;
    }
    return exp;
  }

  function analyzeWicks(open, high, low, close, cfg) {
    const n=close.length, rej=new Array(n).fill(0);
    for (let i=0;i<n;i++) {
      const o=open[i],h=high[i],lo=low[i],c=close[i];
      if (!Number.isFinite(o)||!Number.isFinite(h)||!Number.isFinite(lo)||!Number.isFinite(c)) continue;
      const body=Math.abs(c-o),range=h-lo; if (range===0) continue;
      const up=h-Math.max(o,c),dn=Math.min(o,c)-lo;
      if (up>body*cfg.wickRejectionRatio&&up>dn*2) rej[i]=-1;
      else if (dn>body*cfg.wickRejectionRatio&&dn>up*2) rej[i]=1;
    }
    return rej;
  }

  function computeDeltaVolume(open, high, low, close, volume) {
    const n=close.length, delta=new Array(n).fill(0);
    for (let i=0;i<n;i++) {
      const o=open[i],h=high[i],lo=low[i],c=close[i],v=volume[i];
      if (!Number.isFinite(o)||!Number.isFinite(h)||!Number.isFinite(lo)||!Number.isFinite(c)||!Number.isFinite(v)) continue;
      const range=h-lo;
      if (range===0) { delta[i]=(c>=o?1:-1)*v*0.5; continue; }
      const bp=(c-lo)/range; delta[i]=(bp-(1-bp))*v;
    }
    return delta;
  }

  // ─── signal list + TP/SL ─────────────────────────────────────────────────

  // v8.5-fix: buildSignalList niesie avgPrice i units z position state — oddzielne tablice buy/sell
  function buildSignalList(buyIdx, sellIdx, buyPrice, sellPrice, close, buyAvgPrices, sellAvgPrices, buyUnitCounts, sellUnitCounts) {
    const list=[];
    if (Array.isArray(buyIdx)) for (let i=0;i<buyIdx.length;i++) {
      const idx=Number(buyIdx[i]); if (!Number.isFinite(idx)) continue;
      const p=Number(buyPrice?.[i]);
      const avg=buyAvgPrices?.[i];
      const units=buyUnitCounts?.[i];
      list.push({
        idx: Math.trunc(idx),
        dir: 1,
        price: Number.isFinite(p) ? p : Number(close[idx]),
        avgPrice: Number.isFinite(avg) ? avg : (Number.isFinite(p) ? p : Number(close[idx])),
        units: Number.isFinite(units) && units > 0 ? units : 1
      });
    }
    if (Array.isArray(sellIdx)) for (let i=0;i<sellIdx.length;i++) {
      const idx=Number(sellIdx[i]); if (!Number.isFinite(idx)) continue;
      const p=Number(sellPrice?.[i]);
      const avg=sellAvgPrices?.[i];
      const units=sellUnitCounts?.[i];
      list.push({
        idx: Math.trunc(idx),
        dir: -1,
        price: Number.isFinite(p) ? p : Number(close[idx]),
        avgPrice: Number.isFinite(avg) ? avg : (Number.isFinite(p) ? p : Number(close[idx])),
        units: Number.isFinite(units) && units > 0 ? units : 1
      });
    }
    list.sort((a,b)=>a.idx-b.idx); return list;
  }

  function _resolveHitSide(hitTp, hitSl, tpLevel, slLevel, entry) {
    if (!hitTp&&!hitSl) return null;
    if (hitSl&&(!hitTp||Math.abs(slLevel-entry)<=Math.abs(tpLevel-entry))) return 'sl';
    return 'tp';
  }

  // v8.5-fix: TP/SL liczy od avgPrice, sprawdza od świecy NASTĘPNEJ po entry
  function computeClassicTpSl(candles, signals, tpPct, slPct) {
    const tpIdx=[],tpPrice=[],slIdx=[],slPrice=[];
    if (!candles.length||(!(tpPct>0)&&!(slPct>0))) return {tpIdx,tpPrice,slIdx,slPrice};
    let pos=0,entry=NaN,entryBar=-1,sigPtr=0;
    for (let i=0;i<candles.length;i++) {
      while (sigPtr<signals.length&&signals[sigPtr].idx===i) {
        pos=signals[sigPtr].dir;
        entry=signals[sigPtr].avgPrice; // v8.5: avgPrice zamiast price
        entryBar=i;
        sigPtr++;
      }
      if (!pos||!Number.isFinite(entry)) continue;
      // v8.5-fix: nie sprawdzaj TP/SL na świecy wejścia
      if (i<=entryBar) continue;
      const hi=Number(candles[i].high),lo=Number(candles[i].low);
      if (!Number.isFinite(hi)||!Number.isFinite(lo)) continue;
      let tpLevel,slLevel,hitTp,hitSl;
      if (pos===1) { tpLevel=tpPct>0?entry*(1+tpPct/100):NaN; slLevel=slPct>0?entry*(1-slPct/100):NaN; hitTp=Number.isFinite(tpLevel)&&hi>=tpLevel; hitSl=Number.isFinite(slLevel)&&lo<=slLevel; }
      else { tpLevel=tpPct>0?entry*(1-tpPct/100):NaN; slLevel=slPct>0?entry*(1+slPct/100):NaN; hitTp=Number.isFinite(tpLevel)&&lo<=tpLevel; hitSl=Number.isFinite(slLevel)&&hi>=slLevel; }
      const side=_resolveHitSide(hitTp,hitSl,tpLevel,slLevel,entry);
      if (side==='tp') { tpIdx.push(i); tpPrice.push(tpLevel); pos=0; entry=NaN; }
      else if (side==='sl') { slIdx.push(i); slPrice.push(slLevel); pos=0; entry=NaN; }
    }
    return {tpIdx,tpPrice,slIdx,slPrice};
  }

  // v8.5-fix: TP/SL liczy od avgPrice, sprawdza od świecy NASTĘPNEJ po entry
  function computeAtrBasedTpSl(candles, signals, atr, tpAtrMult, slAtrMult) {
    const tpIdx=[],tpPrice=[],slIdx=[],slPrice=[];
    if (!candles.length||!atr.length) return {tpIdx,tpPrice,slIdx,slPrice};
    let pos=0,entry=NaN,entryAtr=NaN,entryBar=-1,sigPtr=0;
    for (let i=0;i<candles.length;i++) {
      while (sigPtr<signals.length&&signals[sigPtr].idx===i) {
        pos=signals[sigPtr].dir;
        entry=signals[sigPtr].avgPrice; // v8.5: avgPrice zamiast price
        entryAtr=Number(atr[i]);
        entryBar=i;
        sigPtr++;
      }
      if (!pos||!Number.isFinite(entry)||!Number.isFinite(entryAtr)) continue;
      // v8.5-fix: nie sprawdzaj TP/SL na świecy wejścia
      if (i<=entryBar) continue;
      const hi=Number(candles[i].high),lo=Number(candles[i].low);
      if (!Number.isFinite(hi)||!Number.isFinite(lo)) continue;
      let tpLevel,slLevel,hitTp,hitSl;
      if (pos===1) { tpLevel=entry+entryAtr*tpAtrMult; slLevel=entry-entryAtr*slAtrMult; hitTp=hi>=tpLevel; hitSl=lo<=slLevel; }
      else { tpLevel=entry-entryAtr*tpAtrMult; slLevel=entry+entryAtr*slAtrMult; hitTp=lo<=tpLevel; hitSl=hi>=slLevel; }
      const side=_resolveHitSide(hitTp,hitSl,tpLevel,slLevel,entry);
      if (side==='tp') { tpIdx.push(i); tpPrice.push(tpLevel); pos=0; entry=NaN; entryAtr=NaN; }
      else if (side==='sl') { slIdx.push(i); slPrice.push(slLevel); pos=0; entry=NaN; entryAtr=NaN; }
    }
    return {tpIdx,tpPrice,slIdx,slPrice};
  }

  // v8.5-fix: sprawdza od świecy NASTĘPNEJ po entry
  function computeFvgCloudTpSl(candles, signals, fvgDir, cloudBull) {
    const tpIdx=[],tpPrice=[],slIdx=[],slPrice=[];
    if (!candles.length||!Array.isArray(fvgDir)||!Array.isArray(cloudBull)) return {tpIdx,tpPrice,slIdx,slPrice};
    let pos=0,aligned=false,entryBar=-1,sigPtr=0;
    for (let i=0;i<candles.length;i++) {
      while (sigPtr<signals.length&&signals[sigPtr].idx===i) { pos=signals[sigPtr].dir; aligned=Number(fvgDir[i])===pos; entryBar=i; sigPtr++; }
      if (!pos) continue;
      // v8.5-fix: nie sprawdzaj TP/SL na świecy wejścia
      if (i<=entryBar) continue;
      const fNow=Number(fvgDir[i]),fPrev=Number(i>0?fvgDir[i-1]:fNow);
      const cNow=cloudBull[i],cPrev=i>0?cloudBull[i-1]:cNow;
      let exited=false;
      if (aligned&&fNow===-pos&&fPrev===pos) { tpIdx.push(i); tpPrice.push(Number(candles[i].close)); exited=true; }
      if (!exited&&cNow!==null&&cPrev!==null&&cNow!==cPrev) {
        if ((pos===1&&!cNow)||(pos===-1&&cNow)) { slIdx.push(i); slPrice.push(Number(candles[i].close)); exited=true; }
      }
      if (exited) { pos=0; aligned=false; }
    }
    return {tpIdx,tpPrice,slIdx,slPrice};
  }

  // ─── position state ───────────────────────────────────────────────────────

  function makePositionState() {
    return {
      currentSide: 0,
      entryBar: -1,
      lastAddBar: -1e9,
      addsInDir: 0,
      lastAddPrice: NaN,
      positionAvgPrice: NaN,
      positionUnits: 0,
      protectiveStop: NaN,
      lastEntryDecisionBar: -1e9,
      lastExecutionBar: -1e9,
      lastManagementBar: -1e9
    };
  }

  function cloneState(state) {
    return {
      currentSide: state.currentSide,
      entryBar: state.entryBar,
      lastAddBar: state.lastAddBar,
      addsInDir: state.addsInDir,
      lastAddPrice: state.lastAddPrice,
      positionAvgPrice: state.positionAvgPrice,
      positionUnits: state.positionUnits,
      protectiveStop: state.protectiveStop,
      lastEntryDecisionBar: state.lastEntryDecisionBar,
      lastExecutionBar: state.lastExecutionBar,
      lastManagementBar: state.lastManagementBar,
      lastDecisionBar: Math.max(state.lastEntryDecisionBar, state.lastManagementBar)
    };
  }

  // v8.5-fix: pełny reset — włącznie z lastEntryDecisionBar i lastManagementBar
  function resetPositionState(state) {
    state.currentSide = 0;
    state.entryBar = -1;
    state.lastAddBar = -1e9;
    state.addsInDir = 0;
    state.lastAddPrice = NaN;
    state.positionAvgPrice = NaN;
    state.positionUnits = 0;
    state.protectiveStop = NaN;
    state.lastEntryDecisionBar = -1e9;
    state.lastExecutionBar = -1e9;
    state.lastManagementBar = -1e9;
  }

  function registerEntry(state, dir, entryPrice, barIdx) {
    if (!(dir === 1 || dir === -1) || !Number.isFinite(entryPrice)) return;
    if (state.currentSide !== dir || state.positionUnits <= 0 || !Number.isFinite(state.positionAvgPrice)) {
      state.currentSide = dir;
      state.entryBar = barIdx;
      state.lastAddBar = barIdx;
      state.addsInDir = 0;
      state.lastAddPrice = entryPrice;
      state.positionAvgPrice = entryPrice;
      state.positionUnits = 1;
      state.protectiveStop = NaN;
      return;
    }
    const oldUnits = Math.max(1, state.positionUnits);
    state.positionAvgPrice = (state.positionAvgPrice * oldUnits + entryPrice) / (oldUnits + 1);
    state.positionUnits = oldUnits + 1;
    state.lastAddBar = barIdx;
    state.lastAddPrice = entryPrice;
    state.addsInDir += 1;
  }

  function pushDebug(list, payload, limit) {
    if (!Array.isArray(list)) return;
    const maxRecords = Math.max(0, Math.trunc(Number(limit) || DEFAULTS.debugMaxRecords || 0));
    if (maxRecords > 0 && list.length >= maxRecords) list.shift();
    list.push(payload);
  }

  function ensureBool(value, fallback) {
    return typeof value === 'boolean' ? value : !!fallback;
  }

  // ─── entry / add helpers ─────────────────────────────────────────────────

  function resolveEntry(mode, i, open, high, low, close) {
    const n = close.length;
    if (mode === 'nextOpen' && i + 1 < n) {
      const v = Number(open[i + 1]);
      return { entryPrice: Number.isFinite(v) ? v : Number(close[i]), entryIdx: i + 1 };
    }
    if (mode === 'nextMid' && i + 1 < n) {
      const h = Number(high[i + 1]), lo = Number(low[i + 1]);
      if (Number.isFinite(h) && Number.isFinite(lo))
        return { entryPrice: (h + lo) / 2, entryIdx: i + 1 };
    }
    return { entryPrice: Number(close[i]), entryIdx: i };
  }

  // v8.5-fix: usunięty resolveEntryPrice wrapper — używaj resolveEntry bezpośrednio

  function computePullbackOk(dir, i, close, low, high, emaFast) {
    if (!Number.isFinite(emaFast[i])) return true;
    if (dir === 1) return (Number.isFinite(low[i]) && low[i] <= emaFast[i]) || close[i] <= emaFast[i];
    return (Number.isFinite(high[i]) && high[i] >= emaFast[i]) || close[i] >= emaFast[i];
  }

  function computeBreakoutOk(dir, closePrice, refPrice, state) {
    if (!Number.isFinite(closePrice)) return false;
    const anchor = Number.isFinite(state.lastAddPrice) ? state.lastAddPrice : refPrice;
    if (!Number.isFinite(anchor)) return false;
    return dir === 1 ? closePrice > anchor : closePrice < anchor;
  }

  function computeDistanceOk(executionPrice, atrVal, state, cfg) {
    if (!(cfg.minDistanceFromLastAddAtr > 0) || !Number.isFinite(state.lastAddPrice)) return true;
    const a = Number(atrVal);
    if (!Number.isFinite(a) || a <= 0) return true;
    return Math.abs(Number(executionPrice) - state.lastAddPrice) >= a * cfg.minDistanceFromLastAddAtr;
  }

  function computeTightenedStop(state, dir, i, close, atr, cfg) {
    const px = Number(close[i]);
    const a  = Number(atr[i]);
    if (!Number.isFinite(px)) return state.protectiveStop;
    const avg = Number(state.positionAvgPrice);
    const baseAtr = Number.isFinite(a) && a > 0 ? a : Math.abs(px) * Math.max(0.0005, cfg.slPercent / 100);
    const trail = dir === 1
      ? px - baseAtr * Math.max(0.25, cfg.slAtrMult * 0.5)
      : px + baseAtr * Math.max(0.25, cfg.slAtrMult * 0.5);
    const breakeven = Number.isFinite(avg) ? avg : px;
    if (dir === 1) {
      const candidate = Math.max(trail, breakeven);
      return Number.isFinite(state.protectiveStop) ? Math.max(state.protectiveStop, candidate) : candidate;
    }
    const candidate = Math.min(trail, breakeven);
    return Number.isFinite(state.protectiveStop) ? Math.min(state.protectiveStop, candidate) : candidate;
  }

  // ─── UI sync ────────���─────────────────────────────────────────────────────

  function readStateFromUI() {
    const fastEma  = clampInt(readNum(getEl('turboFastEma'),  DEFAULTS.fastEma),  2,  50,  DEFAULTS.fastEma);
    const slowRaw  = clampInt(readNum(getEl('turboSlowEma'),  DEFAULTS.slowEma),  5,  100, DEFAULTS.slowEma);
    const slowEma  = Math.max(slowRaw, fastEma + 1);
    const fibA     = clampNum(readNum(getEl('turboFibA'),     DEFAULTS.fibA),     0.1, 0.9, DEFAULTS.fibA);
    const fibB     = clampNum(readNum(getEl('turboFibB'),     DEFAULTS.fibB),     0.1, 0.9, DEFAULTS.fibB);
    const tpSystem     = normalizeTpSystem(getEl('turboTpSystem')?.value,     DEFAULTS.tpSystem);
    const entryMode    = normalizeEntryMode(getEl('turboEntryMode')?.value    || DEFAULTS.entryMode);
    const sameSidePolicy  = normalizeSameSidePolicy(getEl('turboSameSidePolicy')?.value   || DEFAULTS.sameSidePolicy);
    const reversePolicy   = normalizeReversePolicy(getEl('turboReversePolicy')?.value     || DEFAULTS.reversePolicy);
    const regimeAdxTrendRaw = clampNum(readNum(getEl('turboRegimeAdxTrend'), DEFAULTS.regimeAdxTrend), 10, 60, DEFAULTS.regimeAdxTrend);
    const regimeAdxChopRaw  = clampNum(readNum(getEl('turboRegimeAdxChop'),  DEFAULTS.regimeAdxChop),  5,  30, DEFAULTS.regimeAdxChop);
    const regimeAdxTrend = Math.max(regimeAdxTrendRaw, regimeAdxChopRaw + 1);
    const regimeAdxChop  = Math.min(regimeAdxChopRaw,  regimeAdxTrendRaw - 1);
    return {
      enabled:      readBool(getEl('turboEnableToggle'), DEFAULTS.enabled),
      swingLen:     clampInt(readNum(getEl('turboSwingLen'),    DEFAULTS.swingLen),    1,  20,  DEFAULTS.swingLen),
      breakByClose: readBool(getEl('turboBreakByClose'), DEFAULTS.breakByClose),
      fastEma, slowEma,
      atrLen:       clampInt(readNum(getEl('turboAtrLen'),      DEFAULTS.atrLen),      2,  50,  DEFAULTS.atrLen),
      minAtrPct:    clampNum(readNum(getEl('turboMinAtrPct'),   DEFAULTS.minAtrPct),   0,  2,   DEFAULTS.minAtrPct),
      rsiLen:       clampInt(readNum(getEl('turboRsiLen'),      DEFAULTS.rsiLen),      2,  30,  DEFAULTS.rsiLen),
      rsiMid:       clampNum(readNum(getEl('turboRsiMid'),      DEFAULTS.rsiMid),      30, 70,  DEFAULTS.rsiMid),
      rsiExtreme:   clampNum(readNum(getEl('turboRsiExtreme'),  DEFAULTS.rsiExtreme),  10, 40,  DEFAULTS.rsiExtreme),
      adxLen:       clampInt(readNum(getEl('turboAdxLen'),      DEFAULTS.adxLen),      2,  30,  DEFAULTS.adxLen),
      adxMin:       clampNum(readNum(getEl('turboAdxMin'),      DEFAULTS.adxMin),      0,  50,  DEFAULTS.adxMin),
      volSmaLen:    clampInt(readNum(getEl('turboVolSmaLen'),   DEFAULTS.volSmaLen),   2,  50,  DEFAULTS.volSmaLen),
      volMultiplier:clampNum(readNum(getEl('turboVolMultiplier'),DEFAULTS.volMultiplier),0.5,3,  DEFAULTS.volMultiplier),
      fibA: Math.min(fibA, fibB),
      fibB: Math.max(fibA, fibB),
      fibLookback:  clampInt(readNum(getEl('turboFibLookback'), DEFAULTS.fibLookback), 20, 500, DEFAULTS.fibLookback),
      minScore:     clampNum(readNum(getEl('turboMinScore'),    DEFAULTS.minScore),    1,  12,  DEFAULTS.minScore),
      cooldown:     clampInt(readNum(getEl('turboCooldown'),    DEFAULTS.cooldown),    0,  20,  DEFAULTS.cooldown),
      sameSidePolicy,
      maxAdds:               clampInt(readNum(getEl('turboMaxAdds'),               DEFAULTS.maxAdds),               0, 5,  DEFAULTS.maxAdds),
      minBarsBetweenAdds:    clampInt(readNum(getEl('turboMinBarsBetweenAdds'),    DEFAULTS.minBarsBetweenAdds),    1, 50, DEFAULTS.minBarsBetweenAdds),
      reversePolicy,
      addOnlyIfInProfit:        readBool(getEl('turboAddOnlyIfInProfit'),  DEFAULTS.addOnlyIfInProfit),
      addOnlyIfPullback:        readBool(getEl('turboAddOnlyIfPullback'),  DEFAULTS.addOnlyIfPullback),
      addOnlyIfBreakout:        readBool(getEl('turboAddOnlyIfBreakout'),  DEFAULTS.addOnlyIfBreakout),
      minDistanceFromLastAddAtr:clampNum(readNum(getEl('turboMinDistanceFromLastAddAtr'),DEFAULTS.minDistanceFromLastAddAtr),0,5,DEFAULTS.minDistanceFromLastAddAtr),
      debugSignals:             readBool(getEl('turboDebugSignals'),    DEFAULTS.debugSignals),
      debugMaxRecords:          clampInt(readNum(getEl('turboDebugMaxRecords'),DEFAULTS.debugMaxRecords),0,200000,DEFAULTS.debugMaxRecords),
      entryMode, tpSystem,
      tpPercent:    clampNum(readNum(getEl('turboTpPercent'),  DEFAULTS.tpPercent),  0.05, 5,  DEFAULTS.tpPercent),
      slPercent:    clampNum(readNum(getEl('turboSlPercent'),  DEFAULTS.slPercent),  0.05, 3,  DEFAULTS.slPercent),
      tpAtrMult:    clampNum(readNum(getEl('turboTpAtrMult'),  DEFAULTS.tpAtrMult),  0.5,  5,  DEFAULTS.tpAtrMult),
      slAtrMult:    clampNum(readNum(getEl('turboSlAtrMult'),  DEFAULTS.slAtrMult),  0.3,  3,  DEFAULTS.slAtrMult),
      useMarketRegime:    readBool(getEl('turboUseMarketRegime'),   DEFAULTS.useMarketRegime),
      regimeAdxTrend,
      regimeAdxChop,
      regimeAtrExpFactor: clampNum(readNum(getEl('turboRegimeAtrExpFactor'),DEFAULTS.regimeAtrExpFactor),1,  3,   DEFAULTS.regimeAtrExpFactor),
      useMicroBreakouts:  readBool(getEl('turboUseMicroBreakouts'), DEFAULTS.useMicroBreakouts),
      useMomentumBursts:  readBool(getEl('turboUseMomentumBursts'), DEFAULTS.useMomentumBursts),
      useVWAP:            readBool(getEl('turboUseVWAP'),            DEFAULTS.useVWAP),
      vwapWindow:         clampInt(readNum(getEl('turboVwapWindow'),        DEFAULTS.vwapWindow),        10, 500, DEFAULTS.vwapWindow),
      vwapDevThreshold:   clampNum(readNum(getEl('turboVwapDevThreshold'),  DEFAULTS.vwapDevThreshold),  0.01,1, DEFAULTS.vwapDevThreshold),
      useRangeExpansion:  readBool(getEl('turboUseRangeExpansion'),  DEFAULTS.useRangeExpansion),
      rangeExpFactor:     clampNum(readNum(getEl('turboRangeExpFactor'),    DEFAULTS.rangeExpFactor),    1,  3,   DEFAULTS.rangeExpFactor),
      useWickAnalysis:    readBool(getEl('turboUseWickAnalysis'),    DEFAULTS.useWickAnalysis),
      wickRejectionRatio: clampNum(readNum(getEl('turboWickRejectionRatio'),DEFAULTS.wickRejectionRatio),0.3,0.9,DEFAULTS.wickRejectionRatio),
      useDeltaVolume:     readBool(getEl('turboUseDeltaVolume'),     DEFAULTS.useDeltaVolume),
      deltaThreshold:     clampNum(readNum(getEl('turboDeltaThreshold'),    DEFAULTS.deltaThreshold),    0.05,0.5,DEFAULTS.deltaThreshold),
      fvgLen:             clampInt(readNum(getEl('turboFvgLen'),             DEFAULTS.fvgLen),            1,  20, DEFAULTS.fvgLen),
      fvgSmoothLen:       clampInt(readNum(getEl('turboFvgSmoothLen'),       DEFAULTS.fvgSmoothLen),      1,  20, DEFAULTS.fvgSmoothLen),
      cloudFastPeriod:    clampInt(readNum(getEl('turboCloudFastPeriod'),    DEFAULTS.cloudFastPeriod),   2,  200,DEFAULTS.cloudFastPeriod),
      cloudFastMethod:    clampInt(readNum(getEl('turboCloudFastMethod'),    DEFAULTS.cloudFastMethod),   0,  6,  DEFAULTS.cloudFastMethod),
      cloudSlowPeriod:    clampInt(readNum(getEl('turboCloudSlowPeriod'),    DEFAULTS.cloudSlowPeriod),   2,  500,DEFAULTS.cloudSlowPeriod),
      cloudSlowMethod:    clampInt(readNum(getEl('turboCloudSlowMethod'),    DEFAULTS.cloudSlowMethod),   0,  6,  DEFAULTS.cloudSlowMethod)
    };
  }

  // ─── główna funkcja sygnałów ──────────────────────────────────────────────

  function computeTurboSignals(candles, appState) {
    if (!Array.isArray(candles) || candles.length === 0)
      return emptyResult();

    const cfg = Object.assign({}, DEFAULTS, appState || {});
    cfg.entryMode      = normalizeEntryMode(cfg.entryMode      || DEFAULTS.entryMode);
    cfg.sameSidePolicy = normalizeSameSidePolicy(cfg.sameSidePolicy || DEFAULTS.sameSidePolicy);
    cfg.reversePolicy  = normalizeReversePolicy(cfg.reversePolicy  || DEFAULTS.reversePolicy);
    cfg.debugSignals    = ensureBool(cfg.debugSignals, DEFAULTS.debugSignals);
    cfg.debugMaxRecords = Math.max(0, Math.trunc(Number(cfg.debugMaxRecords) || DEFAULTS.debugMaxRecords));
    if (!cfg.enabled)
      return emptyResult();

    const n = candles.length;
    const swing = Math.max(1, cfg.swingLen);
    const minNeeded = Math.max(cfg.slowEma + 2, cfg.atrLen + 2, cfg.rsiLen + 2,
      cfg.adxLen * 2 + 2, cfg.volSmaLen + 2, swing * 2 + 2, cfg.fibLookback);
    if (n < minNeeded)
      return emptyResult();

    // v8.5-fix: jedno przejście zamiast 5x map()
    const open = new Array(n), high = new Array(n), low = new Array(n),
          close = new Array(n), volume = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      open[i]   = Number(c.open);
      high[i]   = Number(c.high);
      low[i]    = Number(c.low);
      close[i]  = Number(c.close);
      volume[i] = Number(c.volume || 0);
    }

    const emaFast = emaSeries(close, cfg.fastEma);
    const emaSlow = emaSeries(close, cfg.slowEma);
    const atr     = atrSeries(high, low, close, cfg.atrLen);
    const rsi     = rsiSeries(close, cfg.rsiLen);
    const adx     = adxSeries(high, low, close, cfg.adxLen);
    const volSma  = smaSeries(volume, cfg.volSmaLen);

    const regime    = cfg.useMarketRegime ? computeMarketRegime(adx, atr, high, low, cfg)           : new Array(n).fill('neutral');
    const vwap      = cfg.useVWAP         ? vwapRollingSeries(high, low, close, volume, cfg.vwapWindow) : new Array(n).fill(NaN);
    const { microHigh, microLow } = cfg.useMicroBreakouts ? detectMicroBreakouts(high, low, close, swing) : { microHigh: new Array(n).fill(NaN), microLow: new Array(n).fill(NaN) };
    const bursts    = cfg.useMomentumBursts ? detectMomentumBursts(close, volume, volSma, cfg)      : new Array(n).fill(0);
    const expansion = cfg.useRangeExpansion ? detectRangeExpansion(high, low, atr, cfg)             : new Array(n).fill(false);
    const rejection = cfg.useWickAnalysis   ? analyzeWicks(open, high, low, close, cfg)             : new Array(n).fill(0);
    const delta     = cfg.useDeltaVolume    ? computeDeltaVolume(open, high, low, close, volume)    : new Array(n).fill(0);
    const deltaSma  = cfg.useDeltaVolume    ? smaSeries(delta.map(Math.abs), 10)                    : new Array(n).fill(NaN);
    const { rH, rL } = rollingHighLow(high, low, cfg.fibLookback);

    const state = makePositionState();
    const buyIdx = [], sellIdx = [], buyPrice = [], sellPrice = [];
    // v8.5: tablice avgPrice i units równoległe do buy/sell — do przekazania do TP/SL
    const buyAvgPrice = [], sellAvgPrice = [];
    const buyUnits = [], sellUnits = [];
    const manageIdx = [], managePrice = [], manageAction = [], manageMeta = [];
    const debugSignals = [], debugBlocked = [];

    let lastMH = null, lastML = null;
    let lastBrokenHIdx = -1, lastBrokenLIdx = -1;

    for (let i = swing * 2; i < n; i++) {
      if (i < cfg.warmupBars) {
        if (cfg.debugSignals) pushDebug(debugBlocked, { idx: i, reason: 'warmupBars:warmup' }, cfg.debugMaxRecords);
        continue;
      }
      if (Number.isFinite(microHigh[i])) lastMH = { idx: i, price: microHigh[i] };
      if (Number.isFinite(microLow[i]))  lastML  = { idx: i, price: microLow[i] };
      if (!lastMH || !lastML || !Number.isFinite(close[i])) continue;

      const highBreak = i > lastMH.idx && (cfg.breakByClose ? close[i] > lastMH.price : high[i] > lastMH.price);
      const lowBreak  = i > lastML.idx  && (cfg.breakByClose ? close[i] < lastML.price : low[i]  < lastML.price);
      if (highBreak && lowBreak) continue;

      let dir = 0, refPrice = NaN;
      if (highBreak && lastBrokenHIdx !== lastMH.idx) {
        dir = 1; lastBrokenHIdx = lastMH.idx; refPrice = lastMH.price;
      } else if (lowBreak && lastBrokenLIdx !== lastML.idx) {
        dir = -1; lastBrokenLIdx = lastML.idx; refPrice = lastML.price;
      }
      if (!dir) continue;

      const blockedBase = { idx: i, dir, price: close[i], state: cloneState(state), regime: regime[i] };

      const { entryPrice: pendingEntryPrice, entryIdx: pendingEntryIdx } =
        resolveEntry(cfg.entryMode, i, open, high, low, close);
      if (!Number.isFinite(pendingEntryPrice)) {
        if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'entryPrice:invalid' }, blockedBase), cfg.debugMaxRecords);
        continue;
      }

      if (cfg.useMarketRegime && regime[i] === 'chop') {
        if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'marketRegime:chop' }, blockedBase), cfg.debugMaxRecords);
        continue;
      }

      if (state.currentSide !== 0 && dir !== state.currentSide) {
        if (cfg.reversePolicy === 'ignoreOppositeUntilExit') {
          if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'reversePolicy:ignoreOppositeUntilExit' }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
        // v8.5-fix: usunięty resolveEntryPrice wrapper
        const { entryPrice: mgmtPrice } = resolveEntry(cfg.entryMode, i, open, high, low, close);
        if (cfg.reversePolicy === 'closeThenWait') {
          manageIdx.push(i); managePrice.push(mgmtPrice); manageAction.push('closeThenWait');
          manageMeta.push({ fromSide: state.currentSide, toSide: dir, stateBefore: cloneState(state) });
          if (cfg.debugSignals) pushDebug(debugSignals, Object.assign({ action: 'closeThenWait', entryPrice: mgmtPrice }, blockedBase), cfg.debugMaxRecords);
          resetPositionState(state);
          state.lastManagementBar = i;
          continue;
        }
        if (cfg.reversePolicy === 'reduceOnly') {
          manageIdx.push(i); managePrice.push(mgmtPrice); manageAction.push('reduceOnly');
          manageMeta.push({ fromSide: state.currentSide, toSide: dir, stateBefore: cloneState(state) });
          if (state.positionUnits > 1) {
            state.positionUnits -= 1;
            state.addsInDir  = Math.max(0, state.addsInDir - 1);
            state.lastAddBar = i;
            state.lastAddPrice = mgmtPrice;
          } else {
            resetPositionState(state);
          }
          state.lastManagementBar = i;
          if (cfg.debugSignals) pushDebug(debugSignals, Object.assign({ action: 'reduceOnly', entryPrice: mgmtPrice }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
      }

      if (dir === state.currentSide) {
        if (cfg.sameSidePolicy === 'ignore') {
          if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'sameSide:ignore' }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
        if (cfg.sameSidePolicy === 'tightenOnly') {
          if ((pendingEntryIdx - state.lastManagementBar) < cfg.cooldown) {
            if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'cooldown:tightenOnly' }, blockedBase), cfg.debugMaxRecords);
            continue;
          }
          const stateBefore_tighten = cloneState(state);
          const newStop = computeTightenedStop(state, dir, i, close, atr, cfg);
          state.protectiveStop = newStop;
          state.lastManagementBar = i;
          manageIdx.push(i); managePrice.push(Number(close[i])); manageAction.push('tightenOnly');
          manageMeta.push({ side: dir, newStop, stateBefore: stateBefore_tighten });
          if (cfg.debugSignals) pushDebug(debugSignals, Object.assign({ action: 'tightenOnly', newStop }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
        if (state.addsInDir >= cfg.maxAdds) {
          if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'sameSide:maxAdds', maxAdds: cfg.maxAdds }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
        if (pendingEntryIdx - state.lastAddBar < cfg.minBarsBetweenAdds) {
          if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'sameSide:minBarsBetweenAdds', barsSinceAdd: i - state.lastAddBar }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
        if (cfg.addOnlyIfInProfit) {
          const avg = Number(state.positionAvgPrice);
          const inProfit = Number.isFinite(avg) ? (dir === 1 ? pendingEntryPrice > avg : pendingEntryPrice < avg) : true;
          if (!inProfit) {
            if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'sameSide:addOnlyIfInProfit' }, blockedBase), cfg.debugMaxRecords);
            continue;
          }
        }
        if (cfg.addOnlyIfPullback && !computePullbackOk(dir, i, close, low, high, emaFast)) {
          if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'sameSide:addOnlyIfPullback' }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
        if (cfg.addOnlyIfBreakout && !computeBreakoutOk(dir, pendingEntryPrice, refPrice, state)) {
          if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'sameSide:addOnlyIfBreakout' }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
        if (!computeDistanceOk(pendingEntryPrice, atr[i], state, cfg)) {
          if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'sameSide:minDistanceFromLastAddAtr' }, blockedBase), cfg.debugMaxRecords);
          continue;
        }
      }

      if ((pendingEntryIdx - state.lastExecutionBar) < cfg.cooldown) {
        if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'cooldown' }, blockedBase), cfg.debugMaxRecords);
        continue;
      }
      if (cfg.adxMin > 0 && !(Number.isFinite(adx[i]) && adx[i] >= cfg.adxMin)) {
        if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'hardFilter:adx', adx: adx[i] }, blockedBase), cfg.debugMaxRecords);
        continue;
      }

      const triggerWeights = { trend: 0, breakout: 0, burst: 0 };
      const contextWeights = { rsi: 0, volume: 0, atr: 0, fib: 0, expansion: 0, wick: 0, vwap: 0, delta: 0 };

      // NaN emaFast/emaSlow → trendOk = false (brak danych nie przepuszcza sygnału)
      const trendOk = dir === 1 ? emaFast[i] > emaSlow[i] : emaFast[i] < emaSlow[i];
      // NaN emaFast[i] lub emaFast[i-1] → slopeOk = false (brak danych nie przepuszcza sygnału)
      const slopeOk = (Number.isFinite(emaFast[i]) && Number.isFinite(emaFast[i - 1]))
        ? (dir === 1 ? emaFast[i] > emaFast[i - 1] : emaFast[i] < emaFast[i - 1]) : false;
      if (trendOk && slopeOk) triggerWeights.trend = WEIGHTS.trend;

      if (Number.isFinite(atr[i]) && Number.isFinite(refPrice) && Math.abs(close[i] - refPrice) >= atr[i] * 0.05)
        triggerWeights.breakout = WEIGHTS.breakout;
      if (cfg.useMomentumBursts && bursts[i] === dir) triggerWeights.burst = WEIGHTS.burst;

      const rsiValue = Number(rsi[i]);
      // v8.5-fix: NaN RSI = 0 punktów zamiast pass
      if (Number.isFinite(rsiValue)) {
        const rsiMomentumOk = dir === 1 ? rsiValue >= cfg.rsiMid : rsiValue <= 100 - cfg.rsiMid;
        const rsiNotExtreme = dir === 1 ? rsiValue <= 100 - cfg.rsiExtreme : rsiValue >= cfg.rsiExtreme;
        if (rsiMomentumOk && rsiNotExtreme) contextWeights.rsi = WEIGHTS.rsi;
        else if (rsiMomentumOk) contextWeights.rsi = WEIGHTS.rsi * 0.5;
      }
      // else: NaN → 0 punktów (v8.5)

      // v8.5-fix: NaN volume/ATR = 0 punktów zamiast pass
      if (Number.isFinite(volSma[i]) && volSma[i] > 0) {
        if (volume[i] >= volSma[i] * cfg.volMultiplier) contextWeights.volume = WEIGHTS.volume;
      }
      // else: brak danych volSma → 0 punktów (v8.5)

      const atrPct = (Number.isFinite(atr[i]) && close[i] !== 0) ? (atr[i] / Math.abs(close[i])) * 100 : 0;
      if (Number.isFinite(atr[i]) && cfg.minAtrPct > 0 && atrPct >= cfg.minAtrPct) {
        contextWeights.atr = WEIGHTS.atr;
      } else if (Number.isFinite(atr[i]) && cfg.minAtrPct <= 0) {
        contextWeights.atr = WEIGHTS.atr;
      }
      // else: brak danych ATR → 0 punktów (v8.5)

      if (Number.isFinite(rH[i]) && Number.isFinite(rL[i]) && rH[i] !== rL[i]) {
        const span = rH[i] - rL[i];
        const f1 = rL[i] + span * cfg.fibA, f2 = rL[i] + span * cfg.fibB;
        const zL = Math.min(f1, f2), zH = Math.max(f1, f2);
        if (dir === 1 ? close[i] >= zL : close[i] <= zH) contextWeights.fib = WEIGHTS.fib;
      }
      if (cfg.useRangeExpansion && expansion[i]) contextWeights.expansion = WEIGHTS.expansion;
      if (cfg.useWickAnalysis && rejection[i] === -dir) contextWeights.wick = WEIGHTS.wick;
      if (cfg.useVWAP && Number.isFinite(vwap[i]) && vwap[i] > 0) {
        const dev = Math.abs(close[i] - vwap[i]) / vwap[i] * 100;
        if (dev < cfg.vwapDevThreshold) contextWeights.vwap = WEIGHTS.vwap;
      }
      if (cfg.useDeltaVolume && Number.isFinite(delta[i]) && Number.isFinite(deltaSma[i]) && deltaSma[i] > 0) {
        const ratio = Math.abs(delta[i]) / deltaSma[i];
        if (ratio > cfg.deltaThreshold && (delta[i] > 0) === (dir === 1)) contextWeights.delta = WEIGHTS.delta;
      }

      const triggerScore = Object.values(triggerWeights).reduce((a, b) => a + b, 0);
      const score = triggerScore + Object.values(contextWeights).reduce((a, b) => a + b, 0);
      if (triggerScore < cfg.minTriggerScore) {
        if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'triggerScore:minTriggerScore', triggerScore, triggerWeights, contextWeights }, blockedBase), cfg.debugMaxRecords);
        continue;
      }
      if (score < cfg.minScore) {
        if (cfg.debugSignals) pushDebug(debugBlocked, Object.assign({ reason: 'score:minScore', score, triggerWeights, contextWeights }, blockedBase), cfg.debugMaxRecords);
        continue;
      }

      const entryPrice = pendingEntryPrice;
      const entryIdx   = pendingEntryIdx;

      const wasSameSide = dir === state.currentSide && state.positionUnits > 0;
      registerEntry(state, dir, entryPrice, entryIdx);

      // v8.5: zapisz avgPrice i units PO registerEntry — TP/SL dostanie aktualny stan
      if (dir === 1) {
        buyIdx.push(entryIdx); buyPrice.push(entryPrice);
        buyAvgPrice.push(state.positionAvgPrice);
        buyUnits.push(state.positionUnits);
      } else {
        sellIdx.push(entryIdx); sellPrice.push(entryPrice);
        sellAvgPrice.push(state.positionAvgPrice);
        sellUnits.push(state.positionUnits);
      }

      state.lastEntryDecisionBar = i;
      state.lastExecutionBar = entryIdx;
      if (cfg.debugSignals) {
        pushDebug(debugSignals, {
          idx: entryIdx, decisionBar: i, dir,
          action: wasSameSide ? 'add' : 'entry',
          entryPrice, score, triggerWeights, contextWeights,
          regime: regime[i],
          stateAfter: cloneState(state)
        }, cfg.debugMaxRecords);
      }
    }

    let tpIdx = [], tpPrice = [], slIdx = [], slPrice = [];
    const tpMode  = normalizeTpSystem(cfg.tpSystem, DEFAULTS.tpSystem);

    const signals = buildSignalList(buyIdx, sellIdx, buyPrice, sellPrice, close, buyAvgPrice, sellAvgPrice, buyUnits, sellUnits);

    if (tpMode === 'classic') {
      const r = computeClassicTpSl(candles, signals, cfg.tpPercent, cfg.slPercent);
      ({ tpIdx, tpPrice, slIdx, slPrice } = r);
    } else if (tpMode === 'atrBased') {
      const r = computeAtrBasedTpSl(candles, signals, atr, cfg.tpAtrMult, cfg.slAtrMult);
      ({ tpIdx, tpPrice, slIdx, slPrice } = r);
    } else if (tpMode === 'fvgCloud') {
      const fvgDir    = computeFvgDir(high, low, close, cfg.fvgLen, cfg.fvgSmoothLen);
      const cloudBull = computeCloudBull(close, cfg.cloudFastPeriod, cfg.cloudFastMethod, cfg.cloudSlowPeriod, cfg.cloudSlowMethod);
      const r = computeFvgCloudTpSl(candles, signals, fvgDir, cloudBull);
      ({ tpIdx, tpPrice, slIdx, slPrice } = r);
    }

    return {
      buyIdx, sellIdx, buyPrice, sellPrice,
      tpIdx, tpPrice, slIdx, slPrice,
      manageIdx, managePrice, manageAction, manageMeta,
      debugSignals, debugBlocked,
      positionState: cloneState(state),
      debugConfig: {
        entryMode:                cfg.entryMode,
        sameSidePolicy:           cfg.sameSidePolicy,
        reversePolicy:            cfg.reversePolicy,
        maxAdds:                  cfg.maxAdds,
        minBarsBetweenAdds:       cfg.minBarsBetweenAdds,
        addOnlyIfInProfit:        cfg.addOnlyIfInProfit,
        addOnlyIfPullback:        cfg.addOnlyIfPullback,
        addOnlyIfBreakout:        cfg.addOnlyIfBreakout,
        minDistanceFromLastAddAtr:cfg.minDistanceFromLastAddAtr,
        rsiMid:                   cfg.rsiMid,
        rsiExtreme:               cfg.rsiExtreme
      }
    };
  }

  // ─── eksport ─────────────────────────────────────────────────────────────

  function syncTurboStateFromUI() {
    const next = readStateFromUI();
    window.__TURBO_APP_STATE = next;
    return next;
  }

  window.computeTurboSignals  = computeTurboSignals;
  window.syncTurboStateFromUI = syncTurboStateFromUI;
  window.__TURBO_WEIGHTS      = WEIGHTS;
  window.__TURBO_DEFAULTS     = DEFAULTS;

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
      try { syncTurboStateFromUI(); } catch (_) {}
    });
  }
})();