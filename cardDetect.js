// ---------------------------------------------------------------------------
// Automatic business-card edge detection — pure JS, no dependencies.
//
// detectCardQuad(dataUrl) -> Promise<[{x,y},{x,y},{x,y},{x,y}] | null>
//   Returns the card's four corners as normalized (0..1) coordinates in the
//   order TL, TR, BR, BL (the order warpImage expects), or null when no
//   plausible card outline can be found. Never throws: any failure -> null,
//   so the caller falls back to the manual crop/straighten UI unchanged.
//
// Pipeline (on a downscaled copy, longest edge ANALYSIS_EDGE px):
//   grayscale -> 3x3 box blur x2 -> Sobel gradient -> percentile edge mask
//   -> gradient-guided Hough transform -> peak lines -> try every
//   (2 near-parallel) x (2 near-parallel, ~perpendicular) combination ->
//   intersect -> geometric sanity checks -> score by how much of each side
//   actually lies on detected edge pixels -> best candidate above threshold.
//
// Known limits (by design, not bugs): a card on a background of the same
// tone with no visible edge, a card whose edges leave the frame, or a very
// busy background can all return null. The manual dots remain the fallback.
// ---------------------------------------------------------------------------

const ANALYSIS_EDGE = 480; // longest side of the working copy, px
const EDGE_TOP_FRACTION = 0.08; // strongest 8% of gradient pixels count as edges
const EDGE_MIN_MAG = 18; // ...but never below this absolute gradient magnitude
const HOUGH_THETA_STEP = 1; // degrees
const HOUGH_DIR_WINDOW = 12; // vote only within ±this of the gradient normal
const MAX_LINES = 36; // peaks kept from the accumulator
const MIN_PEAK_FRACTION = 0.18; // peak must be >= this * strongest peak
const MIN_AREA_FRACTION = 0.12; // card must cover at least this much of the frame
const MAX_AREA_FRACTION = 0.985;
const MIN_ASPECT = 1.15; // long side / short side (business cards ~1.6–1.8)
const MAX_ASPECT = 2.6;
const MIN_SIDE_SUPPORT = 0.3; // each side: fraction of samples on an edge pixel
const MIN_MEAN_SUPPORT = 0.55; // average over the four sides
const SUPPORT_RADIUS = 2; // px tolerance when checking a sample against the edge map
const OVERSHOOT_LEN = 0.12; // check this fraction of a side's length past each corner
const OVERSHOOT_PENALTY = 0.6; // score multiplier = 1 - penalty * mean overshoot support

export async function detectCardQuad(dataUrl) {
  try {
    const px = await loadDownscaled(dataUrl);
    if (!px) return null;
    return detectQuadFromPixels(px);
  } catch {
    return null;
  }
}

// Browser side: draw the image onto a small canvas and read the pixels.
async function loadDownscaled(dataUrl) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("load failed"));
    i.src = dataUrl;
  });
  const nW = img.naturalWidth;
  const nH = img.naturalHeight;
  if (!nW || !nH) return null;
  const k = Math.min(1, ANALYSIS_EDGE / Math.max(nW, nH));
  const w = Math.max(8, Math.round(nW * k));
  const h = Math.max(8, Math.round(nH * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  return { data, width: w, height: h };
}

// Core (environment-independent, testable in Node): { data: RGBA, width, height }.
// Two passes: strict edge threshold first (clean, fast), then a permissive one
// that admits weaker edges (low-contrast card on a light desk). Both must
// pass the same geometric + edge-support checks, so the fallback cannot
// return a quad the strict pass would have rejected on quality grounds.
export function detectQuadFromPixels(px) {
  return detectPass(px, EDGE_TOP_FRACTION) || detectPass(px, EDGE_TOP_FRACTION * 2);
}

function detectPass({ data, width: W, height: H }, topFraction) {
  if (W < 8 || H < 8) return null;
  const N = W * H;

  // --- grayscale ------------------------------------------------------------
  let g = new Float32Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    g[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }

  // --- blur: 3x3 box, twice (≈ 5x5 Gaussian) --------------------------------
  g = box3(g, W, H);
  g = box3(g, W, H);

  // --- Sobel ---------------------------------------------------------------
  const mag = new Float32Array(N);
  const gx = new Float32Array(N);
  const gy = new Float32Array(N);
  let maxMag = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const a = g[i - W - 1], b = g[i - W], c = g[i - W + 1];
      const d = g[i - 1], f = g[i + 1];
      const h0 = g[i + W - 1], h1 = g[i + W], h2 = g[i + W + 1];
      const sx = c + 2 * f + h2 - (a + 2 * d + h0);
      const sy = h0 + 2 * h1 + h2 - (a + 2 * b + c);
      const m = Math.hypot(sx, sy);
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = m;
      if (m > maxMag) maxMag = m;
    }
  }
  if (maxMag < EDGE_MIN_MAG) return null; // flat image

  // --- edge mask by percentile ------------------------------------------------
  const hist = new Uint32Array(1025);
  const hk = 1024 / maxMag;
  for (let i = 0; i < N; i++) hist[(mag[i] * hk) | 0]++;
  let acc = 0;
  let thr = maxMag;
  const want = N * topFraction;
  for (let b = 1024; b >= 0; b--) {
    acc += hist[b];
    if (acc >= want) {
      thr = b / hk;
      break;
    }
  }
  if (thr < EDGE_MIN_MAG) thr = EDGE_MIN_MAG;
  const edge = new Uint8Array(N);
  const BORDER = 2; // ignore the frame's own rim
  let edgeCount = 0;
  for (let y = BORDER; y < H - BORDER; y++) {
    for (let x = BORDER; x < W - BORDER; x++) {
      const i = y * W + x;
      if (mag[i] >= thr) {
        edge[i] = 1;
        edgeCount++;
      }
    }
  }
  if (edgeCount < 40) return null;

  // --- Hough transform (rho, theta) with gradient-direction gating -------------
  // theta in [0,180): the line's normal direction; rho = x cos t + y sin t.
  const T = Math.round(180 / HOUGH_THETA_STEP);
  const diag = Math.ceil(Math.hypot(W, H));
  const R = 2 * diag + 1; // rho index = rho + diag
  const cosT = new Float32Array(T);
  const sinT = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const rad = (t * HOUGH_THETA_STEP * Math.PI) / 180;
    cosT[t] = Math.cos(rad);
    sinT[t] = Math.sin(rad);
  }
  const accum = new Uint32Array(T * R);
  const win = Math.round(HOUGH_DIR_WINDOW / HOUGH_THETA_STEP);
  for (let y = BORDER; y < H - BORDER; y++) {
    for (let x = BORDER; x < W - BORDER; x++) {
      const i = y * W + x;
      if (!edge[i]) continue;
      // gradient normal angle, folded into [0,180)
      let ang = (Math.atan2(gy[i], gx[i]) * 180) / Math.PI;
      if (ang < 0) ang += 180;
      if (ang >= 180) ang -= 180;
      const tc = Math.round(ang / HOUGH_THETA_STEP);
      for (let dt = -win; dt <= win; dt++) {
        let t = tc + dt;
        let sign = 1;
        if (t < 0) {
          t += T;
          sign = -1;
        } else if (t >= T) {
          t -= T;
          sign = -1;
        }
        const rho = sign * (x * cosT[t] + y * sinT[t]);
        const ri = Math.round(rho) + diag;
        if (ri >= 0 && ri < R) accum[t * R + ri]++;
      }
    }
  }

  // --- peak picking with non-maximum suppression -------------------------------
  let best = 0;
  for (let i = 0; i < accum.length; i++) if (accum[i] > best) best = accum[i];
  if (best < 12) return null;
  const minPeak = Math.max(12, best * MIN_PEAK_FRACTION);
  const lines = [];
  const suppressed = new Uint8Array(accum.length);
  const NT = Math.round(6 / HOUGH_THETA_STEP); // ±6° neighbourhood
  const NR = 8; // ±8 px
  for (let n = 0; n < MAX_LINES; n++) {
    let bi = -1;
    let bv = minPeak - 1;
    for (let i = 0; i < accum.length; i++) {
      if (!suppressed[i] && accum[i] > bv) {
        bv = accum[i];
        bi = i;
      }
    }
    if (bi < 0) break;
    const t = (bi / R) | 0;
    const ri = bi - t * R;
    lines.push({ theta: t * HOUGH_THETA_STEP, rho: ri - diag, votes: bv });
    for (let dt = -NT; dt <= NT; dt++) {
      let tt = t + dt;
      let flip = false;
      if (tt < 0) {
        tt += T;
        flip = true;
      } else if (tt >= T) {
        tt -= T;
        flip = true;
      }
      const rc = flip ? diag - (ri - diag) : ri;
      for (let dr = -NR; dr <= NR; dr++) {
        const rr = rc + dr;
        if (rr >= 0 && rr < R) suppressed[tt * R + rr] = 1;
      }
    }
  }
  if (lines.length < 4) return null;

  // --- candidate quads ----------------------------------------------------------
  const frameArea = W * H;
  let bestQuad = null;
  let bestScore = 0;
  const L = lines.length;
  for (let a = 0; a < L; a++) {
    for (let b = a + 1; b < L; b++) {
      if (!nearParallel(lines[a], lines[b])) continue;
      if (Math.abs(lines[a].rho - lines[b].rho) < 0.12 * Math.min(W, H)) continue;
      for (let c = 0; c < L; c++) {
        if (c === a || c === b) continue;
        if (!nearPerpendicular(lines[a], lines[c])) continue;
        for (let d = c + 1; d < L; d++) {
          if (d === a || d === b) continue;
          if (!nearParallel(lines[c], lines[d])) continue;
          if (Math.abs(lines[c].rho - lines[d].rho) < 0.12 * Math.min(W, H)) continue;
          // corners: a∩c, a∩d, b∩d, b∩c (a polygon walk, not yet oriented)
          const p1 = intersect(lines[a], lines[c]);
          const p2 = intersect(lines[a], lines[d]);
          const p3 = intersect(lines[b], lines[d]);
          const p4 = intersect(lines[b], lines[c]);
          if (!p1 || !p2 || !p3 || !p4) continue;
          const pts = [p1, p2, p3, p4];
          // allow a small overshoot beyond the frame (edges cut by the photo)
          const SLACK = 0.04;
          if (
            pts.some(
              (p) => p.x < -SLACK * W || p.x > W * (1 + SLACK) || p.y < -SLACK * H || p.y > H * (1 + SLACK),
            )
          )
            continue;
          const q = orderCorners(pts);
          if (!isConvex(q)) continue;
          const area = polygonArea(q);
          const af = area / frameArea;
          if (af < MIN_AREA_FRACTION || af > MAX_AREA_FRACTION) continue;
          const top = dist(q[0], q[1]);
          const bottom = dist(q[3], q[2]);
          const left = dist(q[0], q[3]);
          const right = dist(q[1], q[2]);
          const wAvg = (top + bottom) / 2;
          const hAvg = (left + right) / 2;
          if (wAvg < 4 || hAvg < 4) continue;
          const aspect = Math.max(wAvg, hAvg) / Math.min(wAvg, hAvg);
          if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
          // opposite sides should be similar in length (perspective is mild)
          if (Math.min(top, bottom) / Math.max(top, bottom) < 0.55) continue;
          if (Math.min(left, right) / Math.max(left, right) < 0.55) continue;
          if (!anglesOk(q)) continue;
          // edge support: how much of each side really sits on edge pixels
          const s = [
            sideSupport(q[0], q[1], edge, W, H),
            sideSupport(q[1], q[2], edge, W, H),
            sideSupport(q[2], q[3], edge, W, H),
            sideSupport(q[3], q[0], edge, W, H),
          ];
          if (Math.min(...s) < MIN_SIDE_SUPPORT) continue;
          const mean = (s[0] + s[1] + s[2] + s[3]) / 4;
          if (mean < MIN_MEAN_SUPPORT) continue;
          // A real card edge stops at the corner; a background line (table
          // edge, notebook rule) runs straight on. Penalise sides whose
          // extension beyond the corners still sits on edge pixels.
          const o =
            (overshoot(q[0], q[1], edge, W, H) +
              overshoot(q[1], q[2], edge, W, H) +
              overshoot(q[2], q[3], edge, W, H) +
              overshoot(q[3], q[0], edge, W, H)) /
            4;
          const score = mean * Math.sqrt(af) * (1 - OVERSHOOT_PENALTY * o);
          if (score > bestScore) {
            bestScore = score;
            bestQuad = q;
          }
        }
      }
    }
  }
  if (!bestQuad) return null;
  return bestQuad.map((p) => ({
    x: Math.min(1, Math.max(0, p.x / W)),
    y: Math.min(1, Math.max(0, p.y / H)),
  }));
}

// --- helpers -----------------------------------------------------------------
function box3(src, W, H) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(W - 1, x + 1);
      let s = 0;
      let n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          s += src[yy * W + xx];
          n++;
        }
      }
      out[y * W + x] = s / n;
    }
  }
  return out;
}

function angleDiff(t1, t2) {
  let d = Math.abs(t1 - t2) % 180;
  if (d > 90) d = 180 - d;
  return d;
}
function nearParallel(l1, l2) {
  return angleDiff(l1.theta, l2.theta) <= 32;
}
function nearPerpendicular(l1, l2) {
  return Math.abs(angleDiff(l1.theta, l2.theta) - 90) <= 32;
}

function intersect(l1, l2) {
  const t1 = (l1.theta * Math.PI) / 180;
  const t2 = (l2.theta * Math.PI) / 180;
  const a1 = Math.cos(t1), b1 = Math.sin(t1);
  const a2 = Math.cos(t2), b2 = Math.sin(t2);
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.rho * b2 - l2.rho * b1) / det,
    y: (a1 * l2.rho - a2 * l1.rho) / det,
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Order as TL, TR, BR, BL (robust up to ~45° of rotation).
function orderCorners(pts) {
  const bySum = [...pts].sort((p, q) => p.x + p.y - (q.x + q.y));
  const byDiff = [...pts].sort((p, q) => p.y - p.x - (q.y - q.x));
  const tl = bySum[0];
  const br = bySum[3];
  const tr = byDiff[0];
  const bl = byDiff[3];
  const set = new Set([tl, tr, br, bl]);
  if (set.size !== 4) {
    // degenerate ordering (e.g. exact diamond) — fall back to angular sort
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = [...pts].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
    let k = 0;
    for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[k].x + sorted[k].y) k = i;
    return [sorted[k], sorted[(k + 1) % 4], sorted[(k + 2) % 4], sorted[(k + 3) % 4]];
  }
  return [tl, tr, br, bl];
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-6) return false;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
function polygonArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}
function anglesOk(q) {
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4];
    const c = q[i];
    const n = q[(i + 1) % 4];
    const v1x = p.x - c.x, v1y = p.y - c.y;
    const v2x = n.x - c.x, v2y = n.y - c.y;
    const cosA = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
    const deg = (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI;
    if (Math.abs(deg - 90) > 32) return false;
  }
  return true;
}

// Edge support of the side's extension past both corners (max of the two ends).
function overshoot(a, b, edge, W, H) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const beforeA = { x: a.x - dx * OVERSHOOT_LEN, y: a.y - dy * OVERSHOOT_LEN };
  const afterB = { x: b.x + dx * OVERSHOOT_LEN, y: b.y + dy * OVERSHOOT_LEN };
  return Math.max(sideSupport(beforeA, a, edge, W, H), sideSupport(b, afterB, edge, W, H));
}

// Fraction of evenly spaced samples along segment a→b that land within
// SUPPORT_RADIUS px of an edge pixel. Samples outside the frame are skipped
// (an edge clipped by the photo is neither evidence for nor against).
function sideSupport(a, b, edge, W, H) {
  const len = dist(a, b);
  const n = Math.max(12, Math.round(len / 3));
  let hit = 0;
  let counted = 0;
  const r = SUPPORT_RADIUS;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    counted++;
    let found = false;
    for (let dy = -r; dy <= r && !found; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        if (edge[yy * W + xx]) {
          found = true;
          break;
        }
      }
    }
    if (found) hit++;
  }
  if (counted < n * 0.4) return 0; // most of the side is outside the frame
  return hit / counted;
}
