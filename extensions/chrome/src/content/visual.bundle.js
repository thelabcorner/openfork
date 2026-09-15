(() => {
  var __defProp = Object.defineProperty;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // ../../node_modules/.bun/@zumer+snapdiff@0.3.1+aa218024cd227037/node_modules/@zumer/snapdiff/src/diff.js
  var MAX_YIQ = 35215;
  function rgb2y(r, g, b) {
    return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
  }
  function rgb2i(r, g, b) {
    return r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
  }
  function rgb2q(r, g, b) {
    return r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
  }
  function colorDelta(a, b, ai, bi, yOnly) {
    let r1 = a[ai], g1 = a[ai + 1], b1 = a[ai + 2], a1 = a[ai + 3];
    let r2 = b[bi], g2 = b[bi + 1], b2 = b[bi + 2], a2 = b[bi + 3];
    if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2)
      return 0;
    if (a1 < 255) {
      a1 /= 255;
      r1 = blend(r1, a1);
      g1 = blend(g1, a1);
      b1 = blend(b1, a1);
    }
    if (a2 < 255) {
      a2 /= 255;
      r2 = blend(r2, a2);
      g2 = blend(g2, a2);
      b2 = blend(b2, a2);
    }
    const y1 = rgb2y(r1, g1, b1), y2 = rgb2y(r2, g2, b2), dy = y1 - y2;
    if (yOnly)
      return dy;
    const di = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
    const dq = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
    const delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
    return y1 > y2 ? -delta : delta;
  }
  function blend(c, a) {
    return 255 + (c - 255) * a;
  }
  function antialiased(img, x1, y1, w, h, img2) {
    const x0 = Math.max(x1 - 1, 0);
    const y0 = Math.max(y1 - 1, 0);
    const x2 = Math.min(x1 + 1, w - 1);
    const y2 = Math.min(y1 + 1, h - 1);
    const pos = (y1 * w + x1) * 4;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
    let min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0;
    for (let x = x0;x <= x2; x++)
      for (let y = y0;y <= y2; y++) {
        if (x === x1 && y === y1)
          continue;
        const delta = colorDelta(img, img, pos, (y * w + x) * 4, true);
        if (delta === 0) {
          if (++zeroes > 2)
            return false;
        } else if (delta < min) {
          min = delta;
          minX = x;
          minY = y;
        } else if (delta > max) {
          max = delta;
          maxX = x;
          maxY = y;
        }
      }
    if (min === 0 || max === 0)
      return false;
    return hasManySiblings(img, minX, minY, w, h) && hasManySiblings(img2, minX, minY, w, h) || hasManySiblings(img, maxX, maxY, w, h) && hasManySiblings(img2, maxX, maxY, w, h);
  }
  function hasManySiblings(img, x1, y1, w, h) {
    const x0 = Math.max(x1 - 1, 0);
    const y0 = Math.max(y1 - 1, 0);
    const x2 = Math.min(x1 + 1, w - 1);
    const y2 = Math.min(y1 + 1, h - 1);
    const pos = (y1 * w + x1) * 4;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
    for (let x = x0;x <= x2; x++)
      for (let y = y0;y <= y2; y++) {
        if (x === x1 && y === y1)
          continue;
        const p2 = (y * w + x) * 4;
        if (img[pos] === img[p2] && img[pos + 1] === img[p2 + 1] && img[pos + 2] === img[p2 + 2] && img[pos + 3] === img[p2 + 3]) {
          if (++zeroes > 2)
            return true;
        }
      }
    return false;
  }
  function drawPixel(out, pos, r, g, b) {
    out[pos] = r;
    out[pos + 1] = g;
    out[pos + 2] = b;
    out[pos + 3] = 255;
  }
  function drawGrayPixel(img, i, alpha, out) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    const v = blend(rgb2y(r, g, b), alpha * img[i + 3] / 255);
    drawPixel(out, i, v, v, v);
  }
  function diffPixels(a, b, out, w, h, opts = {}) {
    if (a.length !== b.length)
      throw new Error("Image data must have the same dimensions");
    const threshold = opts.threshold ?? 0.1;
    const includeAA = !!opts.includeAA;
    const alpha = opts.alpha ?? 0.1;
    const aaColor = opts.aaColor ?? [255, 255, 0];
    const diffColor = opts.diffColor ?? [255, 0, 0];
    const diffMask = !!opts.diffMask;
    const maxDelta = MAX_YIQ * threshold * threshold;
    const total = w * h;
    let mismatches = 0;
    if (a.length === b.length) {
      let identical = true;
      for (let i = 0;i < a.length; i++)
        if (a[i] !== b[i]) {
          identical = false;
          break;
        }
      if (identical) {
        if (out && !diffMask)
          for (let i = 0;i < total * 4; i += 4)
            drawGrayPixel(a, i, alpha, out);
        return { diff: 0, total, ratio: 0 };
      }
    }
    for (let y = 0;y < h; y++)
      for (let x = 0;x < w; x++) {
        const pos = (y * w + x) * 4;
        const delta = colorDelta(a, b, pos, pos, false);
        if (Math.abs(delta) > maxDelta) {
          if (!includeAA && (antialiased(a, x, y, w, h, b) || antialiased(b, x, y, w, h, a))) {
            if (out && !diffMask)
              drawPixel(out, pos, aaColor[0], aaColor[1], aaColor[2]);
          } else {
            if (out)
              drawPixel(out, pos, diffColor[0], diffColor[1], diffColor[2]);
            mismatches++;
          }
        } else if (out && !diffMask) {
          drawGrayPixel(a, pos, alpha, out);
        }
      }
    return { diff: mismatches, total, ratio: mismatches / total };
  }
  function diffCanvas(baseline, actual, opts = {}) {
    const w = Math.max(baseline.width, actual.width);
    const h = Math.max(baseline.height, actual.height);
    const dimsMatch = baseline.width === actual.width && baseline.height === actual.height;
    const aBuf = readPixels(baseline, w, h);
    const bBuf = readPixels(actual, w, h);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const outCtx = out.getContext("2d");
    const outImg = outCtx.createImageData(w, h);
    const stats = diffPixels(aBuf, bBuf, outImg.data, w, h, opts);
    outCtx.putImageData(outImg, 0, 0);
    return {
      ...stats,
      width: w,
      height: h,
      dimsMatch,
      canvas: out
    };
  }
  function readPixels(canvas, w, h) {
    if (canvas.width === w && canvas.height === h) {
      return canvas.getContext("2d").getImageData(0, 0, w, h).data;
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/core/protocol.js
  var SCHEMA_VERSION = 1;
  var PROTOCOL_VERSION = 1;
  var OPERATIONS = ["capture", "diff", "record"];
  var ERROR_CODES = {
    INVALID_RUN_ID: "INVALID_RUN_ID",
    INVALID_NAME: "INVALID_NAME",
    INVALID_OPERATION: "INVALID_OPERATION",
    TARGET_NOT_FOUND: "TARGET_NOT_FOUND",
    BASELINE_NOT_FOUND: "BASELINE_NOT_FOUND",
    BASELINE_INCOMPATIBLE: "BASELINE_INCOMPATIBLE",
    CAPTURE_FAILED: "CAPTURE_FAILED",
    DIFF_FAILED: "DIFF_FAILED",
    RECORD_FAILED: "RECORD_FAILED",
    PERSIST_FAILED: "PERSIST_FAILED"
  };
  var ARTIFACTS = {
    result: "result.json",
    current: "current.png",
    svg: "current.svg",
    diff: "diff.png",
    frames: "frames.png",
    gif: "recording.gif",
    webm: "recording.webm",
    mp4: "recording.mp4"
  };
  var DEFAULTS = {
    root: ".snapeye",
    maxRuns: 20,
    endpoint: "/__snapeye",
    maxRequestBytes: 64 * 1024 * 1024
  };
  var TRIGGER_PARAM = "__snapeye";
  var SNAPDOM_OPTIONS_PARAM = "snapdomOptions";
  function parseSnapdomOptionsParam(text) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("snapdomOptions must be valid JSON");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("snapdomOptions must be a JSON object");
    }
    return value;
  }
  var COORDINATE_SPACE = "target-css-px";
  var RECORD_LIMITS = {
    minDurationMs: 100,
    maxDurationMs: 15000,
    defaultDurationMs: 3000,
    minFps: 1,
    maxFps: 30,
    defaultFps: 10,
    maxFrames: 150,
    minScale: 0.1,
    maxScale: 2,
    defaultScale: 1,
    maxTotalPixels: 120000000
  };
  var DIFF_DEFAULTS = {
    tileSize: 8,
    gapTiles: 2,
    minRegionCssSide: 4,
    minRegionCssArea: 24,
    maxRegions: 12,
    threshold: 0.1
  };
  var FILMSTRIP_DEFAULTS = {
    maxCells: 12,
    maxColumns: 4,
    maxWidth: 1600,
    gap: 8,
    background: "#ffffff"
  };

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/core/ids.js
  var RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  function isValidRunId(value) {
    return typeof value === "string" && RUN_ID_RE.test(value) && !hasTraversal(value);
  }
  function isValidName(value) {
    return typeof value === "string" && NAME_RE.test(value) && !hasTraversal(value);
  }
  function hasControlChars(value) {
    for (let i = 0;i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 32 || code === 127)
        return true;
    }
    return false;
  }
  function hasTraversal(value) {
    return value === "." || value === ".." || value.includes("..") || value.includes("/") || value.includes("\\") || hasControlChars(value);
  }
  function generateRunId(now = Date.now(), random = Math.random) {
    const stamp = Number(now).toString(36).padStart(9, "0").slice(-9);
    let suffix = "";
    for (let i = 0;i < 6; i++)
      suffix += Math.floor(random() * 36).toString(36);
    return `r${stamp}${suffix}`;
  }
  function assertRunId(value) {
    if (!isValidRunId(value)) {
      const err = new Error(`Invalid SnapEye run id: ${JSON.stringify(value)}. ` + "Use 1-64 chars of [A-Za-z0-9_-].");
      err.code = "INVALID_RUN_ID";
      throw err;
    }
    return value;
  }
  function assertName(value) {
    if (!isValidName(value)) {
      const err = new Error(`Invalid SnapEye name: ${JSON.stringify(value)}. ` + "Use 1-64 chars of [A-Za-z0-9._-] starting with a letter or digit.");
      err.code = "INVALID_NAME";
      throw err;
    }
    return value;
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/core/result.js
  var KNOWN_CODES = new Set(Object.values(ERROR_CODES));
  var KNOWN_OPERATIONS = new Set([...OPERATIONS, "unknown"]);
  function buildResult(input) {
    const result = {
      schemaVersion: SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runId: input.runId,
      status: input.status,
      operation: input.operation
    };
    if (input.name != null)
      result.name = input.name;
    if (input.startedAt)
      result.startedAt = input.startedAt;
    if (input.finishedAt)
      result.finishedAt = input.finishedAt;
    if (input.target && Object.keys(input.target).length)
      result.target = input.target;
    if (input.image)
      result.image = input.image;
    if (input.diff)
      result.diff = input.diff;
    if (input.record)
      result.record = input.record;
    if (input.timing)
      result.timing = input.timing;
    if (input.artifacts && Object.keys(input.artifacts).length)
      result.artifacts = input.artifacts;
    if (input.status === "error")
      result.error = normalizeError(input.error);
    return result;
  }
  function buildErrorResult({ runId, operation, name, code, message, details, artifacts, target, startedAt, finishedAt }) {
    return buildResult({
      runId,
      status: "error",
      operation: operation || "unknown",
      name,
      target,
      artifacts,
      startedAt,
      finishedAt,
      error: { code, message, details }
    });
  }
  function normalizeError(error) {
    const code = error && KNOWN_CODES.has(error.code) ? error.code : ERROR_CODES.CAPTURE_FAILED;
    const out = {
      code,
      message: String(error && error.message || "SnapEye run failed")
    };
    if (error && error.details && typeof error.details === "object")
      out.details = error.details;
    return out;
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/core/metrics.js
  function computeScale({ pixelWidth, cssWidth, pixelHeight, cssHeight }) {
    const byWidth = positiveRatio(pixelWidth, cssWidth);
    const byHeight = positiveRatio(pixelHeight, cssHeight);
    if (byWidth && byHeight) {
      const roundingTolerance = Math.max(1 / Number(cssWidth), 1 / Number(cssHeight));
      const relativeTolerance = Math.max(byWidth, byHeight) * 0.01;
      if (Math.abs(byWidth - byHeight) > roundingTolerance + relativeTolerance) {
        const err = new RangeError(`SnapEye capture has anisotropic raster scale (${round(byWidth, 4)}x horizontally, ` + `${round(byHeight, 4)}x vertically)`);
        err.code = "ANISOTROPIC_SCALE";
        err.details = {
          scaleX: round(byWidth, 4),
          scaleY: round(byHeight, 4)
        };
        throw err;
      }
    }
    const scale = byWidth || byHeight || 1;
    return round(scale, 4);
  }
  function buildImageMeta({ cssWidth, cssHeight, pixelWidth, pixelHeight }, coordinateSpace) {
    return {
      coordinateSpace,
      cssWidth: round2(cssWidth),
      cssHeight: round2(cssHeight),
      pixelWidth,
      pixelHeight,
      scale: computeScale({ pixelWidth, cssWidth, pixelHeight, cssHeight })
    };
  }
  function computeChangedRatio(changedPixels, totalPixels) {
    if (!(totalPixels > 0))
      return 0;
    const ratio = changedPixels / totalPixels;
    if (!Number.isFinite(ratio))
      return 0;
    return clamp(round(ratio, 6), 0, 1);
  }
  function computeFpsActual(timestampsMs) {
    if (!Array.isArray(timestampsMs) || timestampsMs.length < 2)
      return 0;
    const first = timestampsMs[0];
    const last = timestampsMs[timestampsMs.length - 1];
    const elapsed = (last - first) / 1000;
    if (!(elapsed > 0))
      return 0;
    return round((timestampsMs.length - 1) / elapsed, 2);
  }
  function clampRecordOptions(options = {}, targetSize = null) {
    const L = RECORD_LIMITS;
    const durationRequestedMs = numberOr(options.duration, L.defaultDurationMs);
    const fpsRequested = numberOr(options.fps, L.defaultFps);
    const scaleRequested = numberOr(options.scale, L.defaultScale);
    const duration = clamp(Math.round(durationRequestedMs), L.minDurationMs, L.maxDurationMs);
    const fps = clamp(round(fpsRequested, 2), L.minFps, L.maxFps);
    let scale = clamp(scaleRequested, L.minScale, L.maxScale);
    const requestedFrameCount = Math.max(1, Math.round(duration / 1000 * fps));
    let frameCount = Math.min(requestedFrameCount, L.maxFrames);
    const initialScale = scale;
    const initialFrameCount = frameCount;
    let estimatedTotalPixels = null;
    if (hasFiniteSize(targetSize)) {
      const width = Number(targetSize.width);
      const height = Number(targetSize.height);
      const perFrame = width * height;
      let budgetFrames = Math.floor(L.maxTotalPixels / (perFrame * scale * scale));
      while (budgetFrames < frameCount && scale > L.minScale) {
        const nextScale = round(Math.max(L.minScale, scale / 2), 4);
        if (nextScale === scale)
          break;
        scale = nextScale;
        budgetFrames = Math.floor(L.maxTotalPixels / (perFrame * scale * scale));
      }
      if (budgetFrames < 1) {
        const minimumFramePixels = Math.ceil(perFrame * scale * scale);
        const err = new RangeError(`SnapEye record target exceeds the ${L.maxTotalPixels}-pixel memory budget ` + `for even one frame at scale ${scale}`);
        err.code = "RECORD_BUDGET_EXCEEDED";
        err.details = {
          width,
          height,
          scale,
          minimumFramePixels,
          maxTotalPixels: L.maxTotalPixels
        };
        throw err;
      }
      if (budgetFrames < frameCount)
        frameCount = budgetFrames;
      estimatedTotalPixels = Math.ceil(perFrame * scale * scale * frameCount);
    }
    const intervalMs = frameCount === 1 ? duration : frameCount < requestedFrameCount ? duration / frameCount : 1000 / fps;
    return {
      durationRequestedMs: Math.round(durationRequestedMs),
      fpsRequested: round(fpsRequested, 2),
      scaleRequested: round(scaleRequested, 4),
      durationMs: duration,
      fps,
      scale,
      frameCount,
      intervalMs: round(intervalMs, 3),
      captureFps: round(1000 / intervalMs, 2),
      budgetLimited: scale !== initialScale || frameCount !== initialFrameCount,
      estimatedTotalPixels,
      maxTotalPixels: L.maxTotalPixels
    };
  }
  function positiveRatio(numerator, denominator) {
    const n = Number(numerator);
    const d = Number(denominator);
    if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0)
      return 0;
    return n / d;
  }
  function hasFiniteSize(size) {
    if (!size || typeof size !== "object")
      return false;
    const width = Number(size.width);
    const height = Number(size.height);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  }
  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  function round(value, digits) {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
  }
  function round2(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/core/regions.js
  function maskFromDiffBuffer(rgba, diffColor = [255, 0, 0]) {
    const [r, g, b] = diffColor;
    const mask = new Uint8Array(rgba.length / 4);
    for (let i = 0, p = 0;i < rgba.length; i += 4, p++) {
      if (rgba[i + 3] > 0 && rgba[i] === r && rgba[i + 1] === g && rgba[i + 2] === b)
        mask[p] = 1;
    }
    return mask;
  }
  function extractRegions(mask, width, height, options = {}) {
    const {
      scale = 1,
      tileSize = DIFF_DEFAULTS.tileSize,
      gapTiles = DIFF_DEFAULTS.gapTiles,
      minRegionCssSide = DIFF_DEFAULTS.minRegionCssSide,
      minRegionCssArea = DIFF_DEFAULTS.minRegionCssArea,
      maxRegions = DIFF_DEFAULTS.maxRegions
    } = options;
    assertOption("scale", scale, (value) => value > 0);
    assertOption("tileSize", tileSize, (value) => Number.isSafeInteger(value) && value >= 1);
    assertOption("gapTiles", gapTiles, (value) => Number.isSafeInteger(value) && value >= 0);
    assertOption("minRegionCssSide", minRegionCssSide, (value) => value >= 0);
    assertOption("minRegionCssArea", minRegionCssArea, (value) => value >= 0);
    assertOption("maxRegions", maxRegions, (value) => Number.isSafeInteger(value) && value >= 0);
    const boxes = clusterMask(mask, width, height, tileSize, gapTiles);
    const kept = [];
    for (const box of boxes) {
      const css = rasterRectToCss(box, scale);
      const bigEnough = css.width >= minRegionCssSide || css.height >= minRegionCssSide;
      if (!bigEnough)
        continue;
      if (css.width * css.height < minRegionCssArea)
        continue;
      kept.push(css);
    }
    kept.sort((a, b) => b.width * b.height - a.width * a.height || a.y - b.y || a.x - b.x);
    if (kept.length > maxRegions) {
      return {
        regionCount: kept.length,
        regionsTruncated: true,
        regions: [{ ...boundingBox(kept), aggregate: true }]
      };
    }
    return {
      regionCount: kept.length,
      regionsTruncated: false,
      regions: kept.map((r) => ({ ...r, aggregate: false }))
    };
  }
  function assertOption(name, value, isValid) {
    if (!Number.isFinite(value) || !isValid(value)) {
      throw new RangeError(`Invalid SnapEye region option: ${name}`);
    }
  }
  function boundingBox(rects) {
    if (!rects.length)
      return { x: 0, y: 0, width: 0, height: 0 };
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const r of rects) {
      x1 = Math.min(x1, r.x);
      y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.width);
      y2 = Math.max(y2, r.y + r.height);
    }
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  function rasterRectToCss(rect, scale) {
    const s = scale > 0 ? scale : 1;
    const x = Math.floor(rect.x / s);
    const y = Math.floor(rect.y / s);
    const right = Math.ceil((rect.x + rect.width) / s);
    const bottom = Math.ceil((rect.y + rect.height) / s);
    return { x, y, width: Math.max(right - x, 0), height: Math.max(bottom - y, 0) };
  }
  function clusterMask(mask, width, height, tileSize, gapTiles) {
    const cols = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);
    if (!cols || !rows)
      return [];
    const hit = new Uint8Array(cols * rows);
    const minX = new Int32Array(cols * rows).fill(0);
    const minY = new Int32Array(cols * rows).fill(0);
    const maxX = new Int32Array(cols * rows).fill(0);
    const maxY = new Int32Array(cols * rows).fill(0);
    for (let y = 0;y < height; y++) {
      for (let x = 0;x < width; x++) {
        if (!mask[y * width + x])
          continue;
        const t = Math.floor(y / tileSize) * cols + Math.floor(x / tileSize);
        if (!hit[t]) {
          hit[t] = 1;
          minX[t] = x;
          maxX[t] = x;
          minY[t] = y;
          maxY[t] = y;
        } else {
          if (x < minX[t])
            minX[t] = x;
          if (x > maxX[t])
            maxX[t] = x;
          if (y < minY[t])
            minY[t] = y;
          if (y > maxY[t])
            maxY[t] = y;
        }
      }
    }
    const seen = new Uint8Array(cols * rows);
    const boxes = [];
    const stack = [];
    for (let t = 0;t < hit.length; t++) {
      if (!hit[t] || seen[t])
        continue;
      seen[t] = 1;
      stack.length = 0;
      stack.push(t);
      let bx1 = minX[t];
      let by1 = minY[t];
      let bx2 = maxX[t];
      let by2 = maxY[t];
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % cols;
        const cy = (cur - cx) / cols;
        if (minX[cur] < bx1)
          bx1 = minX[cur];
        if (minY[cur] < by1)
          by1 = minY[cur];
        if (maxX[cur] > bx2)
          bx2 = maxX[cur];
        if (maxY[cur] > by2)
          by2 = maxY[cur];
        const left = Math.max(0, cx - gapTiles);
        const right = Math.min(cols - 1, cx + gapTiles);
        const top = Math.max(0, cy - gapTiles);
        const bottom = Math.min(rows - 1, cy + gapTiles);
        for (let ny = top;ny <= bottom; ny++) {
          for (let nx = left;nx <= right; nx++) {
            const n = ny * cols + nx;
            if (!hit[n] || seen[n])
              continue;
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      boxes.push({ x: bx1, y: by1, width: bx2 - bx1 + 1, height: by2 - by1 + 1 });
    }
    return boxes;
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/core/errors.js
  var KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODES));

  class SnapEyeError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "SnapEyeError";
      this.code = KNOWN_ERROR_CODES.has(code) ? code : ERROR_CODES.CAPTURE_FAILED;
      if (details && typeof details === "object")
        this.details = details;
    }
  }
  function operationError(error, operation) {
    if (error instanceof SnapEyeError || KNOWN_ERROR_CODES.has(error?.code))
      return error;
    const fallback = operation === "diff" ? ERROR_CODES.DIFF_FAILED : operation === "record" ? ERROR_CODES.RECORD_FAILED : ERROR_CODES.CAPTURE_FAILED;
    return new SnapEyeError(fallback, publicMessage(error, operation));
  }
  function persistenceError(error) {
    if (error?.code === ERROR_CODES.PERSIST_FAILED)
      return error;
    return new SnapEyeError(ERROR_CODES.PERSIST_FAILED, "SnapEye could not persist the run artifacts");
  }
  function publicMessage(error, operation) {
    if (typeof error?.publicMessage === "string")
      return error.publicMessage;
    if (operation === "diff")
      return "SnapEye could not compare the current capture with its baseline";
    if (operation === "record")
      return "SnapEye could not record the target";
    return "SnapEye could not capture the target";
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/core/envelope.js
  var HEADER_BYTES = 4;
  var MAX_METADATA_BYTES = 1024 * 1024;
  async function encodeBaselineEnvelope({ image, meta }) {
    const metadata = new TextEncoder().encode(JSON.stringify(meta ?? {}));
    if (metadata.byteLength > MAX_METADATA_BYTES) {
      throw new RangeError("SnapEye baseline metadata is too large");
    }
    const imageBytes = await toUint8Array(image);
    const output = new Uint8Array(HEADER_BYTES + metadata.byteLength + imageBytes.byteLength);
    new DataView(output.buffer).setUint32(0, metadata.byteLength, false);
    output.set(metadata, HEADER_BYTES);
    output.set(imageBytes, HEADER_BYTES + metadata.byteLength);
    return output;
  }
  function decodeBaselineEnvelope(input) {
    const bytes = asUint8Array(input);
    if (bytes.byteLength < HEADER_BYTES)
      throw invalidEnvelope();
    const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES).getUint32(0, false);
    if (metadataLength > MAX_METADATA_BYTES || HEADER_BYTES + metadataLength > bytes.byteLength) {
      throw invalidEnvelope();
    }
    let meta;
    try {
      const metadata = bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength);
      meta = JSON.parse(new TextDecoder().decode(metadata));
    } catch {
      throw invalidEnvelope();
    }
    return {
      meta,
      image: bytes.subarray(HEADER_BYTES + metadataLength)
    };
  }
  async function toUint8Array(data) {
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    if (data instanceof ArrayBuffer)
      return new Uint8Array(data);
    return asUint8Array(data);
  }
  function asUint8Array(data) {
    if (data instanceof Uint8Array) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof ArrayBuffer)
      return new Uint8Array(data);
    throw new TypeError("SnapEye baseline image must be a Blob, Uint8Array or ArrayBuffer");
  }
  function invalidEnvelope() {
    const error = new Error("Invalid SnapEye baseline envelope");
    error.code = "INVALID_BASELINE_ENVELOPE";
    return error;
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/client/http-store.js
  var BASELINE_TYPE = "application/vnd.snapeye.baseline";
  function createHttpArtifactStore({
    endpoint = "/__snapeye",
    token,
    fetch: fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof fetchImpl !== "function")
      throw new TypeError("SnapEye HTTP transport requires fetch");
    const base = String(endpoint).replace(/\/+$/, "");
    async function request(path, init = {}, expected = null) {
      const headers = new Headers(init.headers);
      if (token)
        headers.set("x-snapeye-token", token);
      let response;
      try {
        response = await fetchImpl(`${base}${path}`, {
          ...init,
          headers,
          mode: "same-origin",
          credentials: "same-origin",
          redirect: "error"
        });
      } catch (error) {
        throw persistFailure(error);
      }
      if (!response.ok) {
        let message = `SnapEye artifact request failed (${response.status})`;
        try {
          const body = await response.json();
          if (typeof body?.error?.message === "string")
            message = body.error.message;
        } catch {}
        throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, message);
      }
      if (expected) {
        const received = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (received !== expected) {
          throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, "SnapEye artifact server returned an unexpected content type");
        }
      }
      return response;
    }
    async function readBaseline(name) {
      const response = await request(`/baseline?name=${encodeURIComponent(name)}`, { method: "GET" });
      if (response.status === 204)
        return null;
      const received = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (received !== BASELINE_TYPE) {
        throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, "SnapEye artifact server returned an invalid baseline");
      }
      let decoded;
      try {
        decoded = decodeBaselineEnvelope(await response.arrayBuffer());
      } catch {
        throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, "SnapEye artifact server returned an invalid baseline");
      }
      return {
        name,
        meta: decoded.meta,
        image: new Blob([decoded.image], { type: "image/png" })
      };
    }
    async function writeBaseline(name, baseline) {
      const body = await encodeBaselineEnvelope(baseline);
      await request(`/baseline?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": BASELINE_TYPE },
        body
      });
    }
    async function writeRunArtifact(runId, filename, data) {
      await request(`/artifact?run=${encodeURIComponent(runId)}&filename=${encodeURIComponent(filename)}`, {
        method: "POST",
        headers: { "content-type": artifactType(filename) },
        body: data
      });
    }
    async function commitResult(runId, result) {
      await request(`/result?run=${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result)
      });
    }
    async function log(level, ...args) {
      const body = args.map(formatLogValue).join(" ");
      try {
        await request("/log", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: `[${level}] ${body}`
        });
        return true;
      } catch {
        return false;
      }
    }
    return { readBaseline, writeBaseline, writeRunArtifact, commitResult, log };
  }
  function artifactType(filename) {
    if (filename.endsWith(".png"))
      return "image/png";
    if (filename.endsWith(".svg"))
      return "image/svg+xml";
    if (filename.endsWith(".gif"))
      return "image/gif";
    if (filename.endsWith(".webm"))
      return "video/webm";
    if (filename.endsWith(".mp4"))
      return "video/mp4";
    return "application/octet-stream";
  }
  function persistFailure() {
    return new SnapEyeError(ERROR_CODES.PERSIST_FAILED, "SnapEye artifact server is not reachable");
  }
  function formatLogValue(value) {
    if (value instanceof Error)
      return value.stack || value.message;
    if (typeof value === "object" && value !== null) {
      try {
        return JSON.stringify(value);
      } catch {}
    }
    return String(value);
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/client/legacy-store.js
  function createLegacyArtifactStore({
    endpoint = "/__snapeye__",
    fetch: fetchImpl = globalThis.fetch
  } = {}) {
    const base = String(endpoint).replace(/\/+$/, "");
    async function post(path, body, contentType) {
      let response;
      try {
        response = await fetchImpl(`${base}/${path}`, {
          method: "POST",
          headers: { "content-type": contentType },
          body
        });
      } catch {
        throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, "The legacy SnapEye server is not reachable");
      }
      if (!response.ok) {
        throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, `The legacy SnapEye server returned ${response.status}`);
      }
    }
    return {
      legacy: true,
      readBaseline: async () => null,
      writeBaseline: async (name, baseline) => {
        await post(`snap?name=${encodeURIComponent(name)}`, baseline.image, "image/png");
      },
      writeRunArtifact: async () => {},
      commitResult: async () => {},
      log: async (level, ...args) => {
        try {
          await post("log", `[${level}] ${args.map(String).join(" ")}`, "text/plain");
          return true;
        } catch {
          return false;
        }
      }
    };
  }

  // ../../packages/browser-visual/src/gifenc-safe.ts
  var exports_gifenc_safe = {};
  __export(exports_gifenc_safe, {
    quantize: () => quantize,
    encodeGifFrames: () => encodeGifFrames,
    default: () => gifenc_safe_default,
    applyPalette: () => applyPalette,
    GIFEncoder: () => GIFEncoder
  });

  // ../../node_modules/.bun/gifenc@1.0.3/node_modules/gifenc/src/stream.js
  function createStream(initialCapacity = 256) {
    let cursor = 0;
    let contents = new Uint8Array(initialCapacity);
    return {
      get buffer() {
        return contents.buffer;
      },
      reset() {
        cursor = 0;
      },
      bytesView() {
        return contents.subarray(0, cursor);
      },
      bytes() {
        return contents.slice(0, cursor);
      },
      writeByte(byte) {
        expand(cursor + 1);
        contents[cursor] = byte;
        cursor++;
      },
      writeBytes(data, offset = 0, byteLength = data.length) {
        expand(cursor + byteLength);
        for (let i = 0;i < byteLength; i++) {
          contents[cursor++] = data[i + offset];
        }
      },
      writeBytesView(data, offset = 0, byteLength = data.byteLength) {
        expand(cursor + byteLength);
        contents.set(data.subarray(offset, offset + byteLength), cursor);
        cursor += byteLength;
      }
    };
    function expand(newCapacity) {
      var prevCapacity = contents.length;
      if (prevCapacity >= newCapacity)
        return;
      var CAPACITY_DOUBLING_MAX = 1024 * 1024;
      newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) >>> 0);
      if (prevCapacity != 0)
        newCapacity = Math.max(newCapacity, 256);
      const oldContents = contents;
      contents = new Uint8Array(newCapacity);
      if (cursor > 0)
        contents.set(oldContents.subarray(0, cursor), 0);
    }
  }

  // ../../node_modules/.bun/gifenc@1.0.3/node_modules/gifenc/src/lzwEncode.js
  var BITS = 12;
  var DEFAULT_HSIZE = 5003;
  var MASKS = [
    0,
    1,
    3,
    7,
    15,
    31,
    63,
    127,
    255,
    511,
    1023,
    2047,
    4095,
    8191,
    16383,
    32767,
    65535
  ];
  function lzwEncode(width, height, pixels, colorDepth, outStream = createStream(512), accum = new Uint8Array(256), htab = new Int32Array(DEFAULT_HSIZE), codetab = new Int32Array(DEFAULT_HSIZE)) {
    const hsize = htab.length;
    const initCodeSize = Math.max(2, colorDepth);
    accum.fill(0);
    codetab.fill(0);
    htab.fill(-1);
    let cur_accum = 0;
    let cur_bits = 0;
    const init_bits = initCodeSize + 1;
    const g_init_bits = init_bits;
    let clear_flg = false;
    let n_bits = g_init_bits;
    let maxcode = (1 << n_bits) - 1;
    const ClearCode = 1 << init_bits - 1;
    const EOFCode = ClearCode + 1;
    let free_ent = ClearCode + 2;
    let a_count = 0;
    let ent = pixels[0];
    let hshift = 0;
    for (let fcode = hsize;fcode < 65536; fcode *= 2) {
      ++hshift;
    }
    hshift = 8 - hshift;
    outStream.writeByte(initCodeSize);
    output(ClearCode);
    const length = pixels.length;
    for (let idx = 1;idx < length; idx++) {
      next_block: {
        const c = pixels[idx];
        const fcode = (c << BITS) + ent;
        let i = c << hshift ^ ent;
        if (htab[i] === fcode) {
          ent = codetab[i];
          break next_block;
        }
        const disp = i === 0 ? 1 : hsize - i;
        while (htab[i] >= 0) {
          i -= disp;
          if (i < 0)
            i += hsize;
          if (htab[i] === fcode) {
            ent = codetab[i];
            break next_block;
          }
        }
        output(ent);
        ent = c;
        if (free_ent < 1 << BITS) {
          codetab[i] = free_ent++;
          htab[i] = fcode;
        } else {
          htab.fill(-1);
          free_ent = ClearCode + 2;
          clear_flg = true;
          output(ClearCode);
        }
      }
    }
    output(ent);
    output(EOFCode);
    outStream.writeByte(0);
    return outStream.bytesView();
    function output(code) {
      cur_accum &= MASKS[cur_bits];
      if (cur_bits > 0)
        cur_accum |= code << cur_bits;
      else
        cur_accum = code;
      cur_bits += n_bits;
      while (cur_bits >= 8) {
        accum[a_count++] = cur_accum & 255;
        if (a_count >= 254) {
          outStream.writeByte(a_count);
          outStream.writeBytesView(accum, 0, a_count);
          a_count = 0;
        }
        cur_accum >>= 8;
        cur_bits -= 8;
      }
      if (free_ent > maxcode || clear_flg) {
        if (clear_flg) {
          n_bits = g_init_bits;
          maxcode = (1 << n_bits) - 1;
          clear_flg = false;
        } else {
          ++n_bits;
          maxcode = n_bits === BITS ? 1 << n_bits : (1 << n_bits) - 1;
        }
      }
      if (code == EOFCode) {
        while (cur_bits > 0) {
          accum[a_count++] = cur_accum & 255;
          if (a_count >= 254) {
            outStream.writeByte(a_count);
            outStream.writeBytesView(accum, 0, a_count);
            a_count = 0;
          }
          cur_accum >>= 8;
          cur_bits -= 8;
        }
        if (a_count > 0) {
          outStream.writeByte(a_count);
          outStream.writeBytesView(accum, 0, a_count);
          a_count = 0;
        }
      }
    }
  }
  var lzwEncode_default = lzwEncode;

  // ../../packages/browser-visual/src/gifenc-safe.ts
  var MAX_GIF_BYTES = 64 * 1024 * 1024;
  var MAX_PALETTE_COLORS = 256;
  var HISTOGRAM_BITS = 5;
  var HISTOGRAM_LEVELS = 1 << HISTOGRAM_BITS;
  var HISTOGRAM_SIZE = HISTOGRAM_LEVELS ** 3;
  var HISTOGRAM_SHIFT = 8 - HISTOGRAM_BITS;
  var MAX_PALETTE_SAMPLE_PIXELS = 262144;
  var MAX_PALETTE_SAMPLE_FRAMES = 8;
  function quantize(rgba, maxColors = MAX_PALETTE_COLORS) {
    validateRgba(rgba);
    if (!Number.isFinite(maxColors) || maxColors < 2)
      throw new RangeError("GIF palette requires at least 2 colors");
    return adaptivePaletteFromArrays([rgba], Math.min(MAX_PALETTE_COLORS, Math.floor(maxColors)));
  }
  function applyPalette(rgba, palette) {
    validateRgba(rgba);
    if (!Array.isArray(palette) || palette.length < 2 || palette.length > 256) {
      throw new RangeError("GIF palette must contain 2-256 colors");
    }
    return applyPaletteWithMapper(rgba, createPaletteMapper(palette));
  }
  async function encodeGifFrames(frames, timestampsMs, options = {}) {
    if (!frames.length)
      throw new Error("Cannot encode a GIF without frames");
    const maxColors = Math.max(2, Math.min(MAX_PALETTE_COLORS, Math.floor(options.maxColors ?? MAX_PALETTE_COLORS)));
    const palette = adaptivePaletteFromCanvases(frames, maxColors);
    const mapper = createPaletteMapper(palette);
    const encoder = GIFEncoder();
    const fallbackDelay = Math.max(20, Math.round(1000 / (options.fps || 10)));
    for (let frameIndex = 0;frameIndex < frames.length; frameIndex++) {
      const canvas = frames[frameIndex];
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("GIF encoding requires a 2D canvas context");
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const indexed = applyPaletteWithMapper(rgba, mapper);
      const measuredDelay = frameDelay(timestampsMs, frameIndex, options.durationMs);
      encoder.writeFrame(indexed, canvas.width, canvas.height, {
        palette,
        delay: Number.isFinite(measuredDelay) && measuredDelay > 0 ? measuredDelay : fallbackDelay,
        repeat: options.repeat ?? 0
      });
    }
    encoder.finish();
    const encoded = encoder.bytes();
    const owned = new Uint8Array(encoded.byteLength);
    owned.set(encoded);
    return new Blob([owned.buffer], { type: "image/gif" });
  }
  function applyPaletteWithMapper(rgba, mapper) {
    const pixels = rgba.byteLength >>> 2;
    const indexed = new Uint8Array(pixels);
    for (let pixel = 0, offset = 0;pixel < pixels; pixel++, offset += 4) {
      indexed[pixel] = mapper(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
    }
    return indexed;
  }
  function GIFEncoder(options = {}) {
    const initialCapacity = boundedPositiveInt(options.initialCapacity ?? 4096, "initialCapacity");
    const auto = options.auto !== false;
    const raw = createStream(initialCapacity);
    const stream = boundedStream(raw);
    const accum = new Uint8Array(256);
    const htab = new Int32Array(5003);
    const codetab = new Int32Array(5003);
    let initialized = false;
    let globalPalette = null;
    return {
      reset() {
        raw.reset();
        initialized = false;
        globalPalette = null;
      },
      finish() {
        stream.writeByte(59);
      },
      bytes() {
        return raw.bytes();
      },
      bytesView() {
        return raw.bytesView();
      },
      get buffer() {
        return raw.buffer;
      },
      get stream() {
        return stream;
      },
      writeHeader() {
        writeAscii(stream, "GIF89a");
      },
      writeFrame(index, widthInput, heightInput, frame = {}) {
        const width = gifDimension(widthInput, "width");
        const height = gifDimension(heightInput, "height");
        if (!(index instanceof Uint8Array) || index.byteLength !== width * height) {
          throw new RangeError(`GIF frame index length ${index?.byteLength ?? 0} does not match ${width}x${height}`);
        }
        const palette = frame.palette ?? null;
        const colorDepth = Math.max(2, Math.min(8, Math.floor(frame.colorDepth ?? 8)));
        let first = false;
        if (auto) {
          if (!initialized) {
            first = true;
            writeAscii(stream, "GIF89a");
            initialized = true;
          }
        } else {
          first = frame.first === true;
        }
        if (first) {
          if (!palette)
            throw new Error("First GIF frame requires a palette");
          globalPalette = palette;
          logicalScreenDescriptor(stream, width, height, palette, colorDepth);
          colorTable(stream, palette);
          if ((frame.repeat ?? 0) >= 0)
            netscapeLoop(stream, frame.repeat ?? 0);
        }
        graphicControlExtension(stream, Math.floor(frame.dispose ?? -1), Math.round(Math.max(0, frame.delay ?? 0) / 10), frame.transparent === true, Math.floor(frame.transparentIndex ?? 0));
        const localPalette = palette && !first && palette !== globalPalette ? palette : null;
        imageDescriptor(stream, width, height, localPalette);
        if (localPalette)
          colorTable(stream, localPalette);
        encodePixels(stream, index, width, height, colorDepth, accum, htab, codetab);
      }
    };
  }
  var gifenc_safe_default = GIFEncoder;
  function createPaletteMapper(palette) {
    const cache = new Int16Array(HISTOGRAM_SIZE);
    cache.fill(-1);
    return (r, g, b) => {
      const key = histogramKey(r, g, b);
      const cached = cache[key];
      if (cached >= 0)
        return cached;
      const qr = Math.min(255, ((key >>> 10 & 31) << HISTOGRAM_SHIFT) + (1 << HISTOGRAM_SHIFT - 1));
      const qg = Math.min(255, ((key >>> 5 & 31) << HISTOGRAM_SHIFT) + (1 << HISTOGRAM_SHIFT - 1));
      const qb = Math.min(255, ((key & 31) << HISTOGRAM_SHIFT) + (1 << HISTOGRAM_SHIFT - 1));
      const index = nearestPaletteIndex(qr, qg, qb, palette);
      cache[key] = index;
      return index;
    };
  }
  function nearestPaletteIndex(r, g, b, palette) {
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0;index < palette.length; index++) {
      const color = palette[index];
      const next = sq(r - color[0]) + sq(g - color[1]) + sq(b - color[2]);
      if (next >= distance)
        continue;
      distance = next;
      best = index;
    }
    return best;
  }
  function adaptivePaletteFromArrays(arrays, maxColors) {
    const totalPixels = arrays.reduce((total, rgba) => total + (rgba.byteLength >>> 2), 0);
    const stride = Math.max(1, Math.ceil(totalPixels / MAX_PALETTE_SAMPLE_PIXELS));
    const histogram = createHistogram();
    let globalPixelOffset = 0;
    for (const rgba of arrays) {
      validateRgba(rgba);
      accumulateHistogram(histogram, rgba, stride, globalPixelOffset);
      globalPixelOffset += rgba.byteLength >>> 2;
    }
    return paletteFromHistogram(histogram, maxColors);
  }
  function adaptivePaletteFromCanvases(frames, maxColors) {
    const indices = paletteFrameIndices(frames.length);
    const totalPixels = indices.reduce((total, index) => {
      const frame = frames[index];
      return total + frame.width * frame.height;
    }, 0);
    const stride = Math.max(1, Math.ceil(totalPixels / MAX_PALETTE_SAMPLE_PIXELS));
    const histogram = createHistogram();
    let globalPixelOffset = 0;
    for (const index of indices) {
      const frame = frames[index];
      const context = frame.getContext("2d");
      if (!context)
        throw new Error("GIF palette analysis requires a 2D canvas context");
      const rgba = context.getImageData(0, 0, frame.width, frame.height).data;
      accumulateHistogram(histogram, rgba, stride, globalPixelOffset);
      globalPixelOffset += rgba.byteLength >>> 2;
    }
    return paletteFromHistogram(histogram, maxColors);
  }
  function paletteFrameIndices(frameCount) {
    if (frameCount <= MAX_PALETTE_SAMPLE_FRAMES)
      return Array.from({ length: frameCount }, (_, index) => index);
    const indices = new Set([0, frameCount - 1]);
    for (let slot = 1;slot < MAX_PALETTE_SAMPLE_FRAMES - 1; slot++) {
      indices.add(Math.round(slot * (frameCount - 1) / (MAX_PALETTE_SAMPLE_FRAMES - 1)));
    }
    return [...indices].sort((left, right) => left - right);
  }
  function createHistogram() {
    return {
      counts: new Uint32Array(HISTOGRAM_SIZE),
      sumsR: new Uint32Array(HISTOGRAM_SIZE),
      sumsG: new Uint32Array(HISTOGRAM_SIZE),
      sumsB: new Uint32Array(HISTOGRAM_SIZE)
    };
  }
  function accumulateHistogram(histogram, rgba, stride, globalPixelOffset) {
    const pixels = rgba.byteLength >>> 2;
    const first = (stride - globalPixelOffset % stride) % stride;
    for (let pixel = first;pixel < pixels; pixel += stride) {
      const offset = pixel << 2;
      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      const key = histogramKey(r, g, b);
      histogram.counts[key] = histogram.counts[key] + 1;
      histogram.sumsR[key] = histogram.sumsR[key] + r;
      histogram.sumsG[key] = histogram.sumsG[key] + g;
      histogram.sumsB[key] = histogram.sumsB[key] + b;
    }
  }
  function paletteFromHistogram(histogram, maxColors) {
    const bins = [];
    for (let key = 0;key < HISTOGRAM_SIZE; key++) {
      const count = histogram.counts[key];
      if (!count)
        continue;
      bins.push({
        key,
        count,
        r: Math.round(histogram.sumsR[key] / count),
        g: Math.round(histogram.sumsG[key] / count),
        b: Math.round(histogram.sumsB[key] / count)
      });
    }
    if (!bins.length)
      return Object.freeze([[0, 0, 0], [255, 255, 255]]);
    if (bins.length <= maxColors) {
      const exact = bins.map((bin) => Object.freeze([bin.r, bin.g, bin.b]));
      while (exact.length < 2)
        exact.push(exact[0]);
      return Object.freeze(exact);
    }
    const boxes = [makeColorBox(bins)];
    while (boxes.length < maxColors) {
      const splitIndex = selectSplitBox(boxes);
      if (splitIndex < 0)
        break;
      const split = splitColorBox(boxes[splitIndex]);
      if (!split)
        break;
      boxes.splice(splitIndex, 1, split[0], split[1]);
    }
    const palette = boxes.map((box) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const bin of box.bins) {
        r += bin.r * bin.count;
        g += bin.g * bin.count;
        b += bin.b * bin.count;
      }
      return Object.freeze([
        Math.round(r / box.total),
        Math.round(g / box.total),
        Math.round(b / box.total)
      ]);
    });
    palette.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
    while (palette.length < 2)
      palette.push(palette[0]);
    return Object.freeze(palette);
  }
  function makeColorBox(bins) {
    let total = 0;
    let minR = 255;
    let minG = 255;
    let minB = 255;
    let maxR = 0;
    let maxG = 0;
    let maxB = 0;
    let minKey = Number.POSITIVE_INFINITY;
    for (const bin of bins) {
      total += bin.count;
      minR = Math.min(minR, bin.r);
      maxR = Math.max(maxR, bin.r);
      minG = Math.min(minG, bin.g);
      maxG = Math.max(maxG, bin.g);
      minB = Math.min(minB, bin.b);
      maxB = Math.max(maxB, bin.b);
      minKey = Math.min(minKey, bin.key);
    }
    return { bins, total, minR, maxR, minG, maxG, minB, maxB, minKey };
  }
  function selectSplitBox(boxes) {
    let selected = -1;
    let selectedScore = -1;
    let selectedKey = Number.POSITIVE_INFINITY;
    for (let index = 0;index < boxes.length; index++) {
      const box = boxes[index];
      if (box.bins.length < 2)
        continue;
      const range = Math.max(box.maxR - box.minR, box.maxG - box.minG, box.maxB - box.minB);
      const score = range * box.total;
      if (score > selectedScore || score === selectedScore && box.minKey < selectedKey) {
        selected = index;
        selectedScore = score;
        selectedKey = box.minKey;
      }
    }
    return selected;
  }
  function splitColorBox(box) {
    if (box.bins.length < 2)
      return null;
    const rangeR = box.maxR - box.minR;
    const rangeG = box.maxG - box.minG;
    const rangeB = box.maxB - box.minB;
    const channel = rangeR >= rangeG && rangeR >= rangeB ? "r" : rangeG >= rangeB ? "g" : "b";
    const sorted = [...box.bins].sort((left, right) => left[channel] - right[channel] || left.key - right.key);
    const midpoint = box.total / 2;
    let accumulated = 0;
    let splitAt = 1;
    for (let index = 0;index < sorted.length - 1; index++) {
      accumulated += sorted[index].count;
      splitAt = index + 1;
      if (accumulated >= midpoint)
        break;
    }
    splitAt = Math.max(1, Math.min(sorted.length - 1, splitAt));
    return [makeColorBox(sorted.slice(0, splitAt)), makeColorBox(sorted.slice(splitAt))];
  }
  function histogramKey(r, g, b) {
    return r >>> HISTOGRAM_SHIFT << 10 | g >>> HISTOGRAM_SHIFT << 5 | b >>> HISTOGRAM_SHIFT;
  }
  function frameDelay(timestampsMs, index, durationMs) {
    const current = timestampsMs[index];
    const next = timestampsMs[index + 1];
    if (Number.isFinite(current) && Number.isFinite(next))
      return next - current;
    if (Number.isFinite(current) && Number.isFinite(durationMs))
      return durationMs - current;
    return Number.NaN;
  }
  function validateRgba(rgba) {
    if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray)) {
      throw new TypeError("GIF quantization requires Uint8Array RGBA data");
    }
    if ((rgba.byteLength & 3) !== 0)
      throw new RangeError("RGBA byte length must be divisible by four");
  }
  function boundedStream(raw) {
    const ensure = (additional) => {
      if (raw.bytesView().byteLength + additional > MAX_GIF_BYTES) {
        throw new RangeError(`GIF exceeded OpenFork's ${MAX_GIF_BYTES}-byte artifact ceiling`);
      }
    };
    return {
      get buffer() {
        return raw.buffer;
      },
      reset: () => raw.reset(),
      bytes: () => raw.bytes(),
      bytesView: () => raw.bytesView(),
      writeByte(byte) {
        ensure(1);
        raw.writeByte(byte);
      },
      writeBytes(data, offset = 0, byteLength = data.length - offset) {
        ensure(byteLength);
        raw.writeBytes(data, offset, byteLength);
      },
      writeBytesView(data, offset = 0, byteLength = data.byteLength - offset) {
        ensure(byteLength);
        raw.writeBytesView(data, offset, byteLength);
      }
    };
  }
  function encodePixels(stream, index, width, height, colorDepth, accum, htab, codetab) {
    lzwEncodePrimitive(width, height, index, colorDepth, stream, accum, htab, codetab);
  }
  var lzwEncodePrimitive = lzwEncode_default;
  function logicalScreenDescriptor(stream, width, height, palette, colorDepth) {
    writeUInt16(stream, width);
    writeUInt16(stream, height);
    const tableSize = colorTableSize(palette.length) - 1;
    stream.writeBytes([1 << 7 | colorDepth - 1 << 4 | tableSize, 0, 0]);
  }
  function netscapeLoop(stream, repeat) {
    stream.writeBytes([33, 255, 11]);
    writeAscii(stream, "NETSCAPE2.0");
    stream.writeBytes([3, 1]);
    writeUInt16(stream, repeat);
    stream.writeByte(0);
  }
  function graphicControlExtension(stream, dispose, delayCentiseconds, transparent, transparentIndex) {
    if (transparentIndex < 0) {
      transparentIndex = 0;
      transparent = false;
    }
    let disposal = transparent ? 2 : 0;
    if (dispose >= 0)
      disposal = dispose & 7;
    stream.writeBytes([33, 249, 4, disposal << 2 | (transparent ? 1 : 0)]);
    writeUInt16(stream, Math.min(65535, Math.max(0, delayCentiseconds)));
    stream.writeBytes([transparentIndex & 255, 0]);
  }
  function imageDescriptor(stream, width, height, palette) {
    stream.writeByte(44);
    writeUInt16(stream, 0);
    writeUInt16(stream, 0);
    writeUInt16(stream, width);
    writeUInt16(stream, height);
    stream.writeByte(palette ? 128 | colorTableSize(palette.length) - 1 : 0);
  }
  function colorTable(stream, palette) {
    if (palette.length < 2 || palette.length > 256)
      throw new RangeError("GIF palette must contain 2-256 colors");
    const length = 1 << colorTableSize(palette.length);
    for (let index = 0;index < length; index++) {
      const color = palette[index] ?? [0, 0, 0];
      stream.writeBytes(color);
    }
  }
  function writeUInt16(stream, value) {
    stream.writeBytes([value & 255, value >>> 8 & 255]);
  }
  function writeAscii(stream, text) {
    for (let index = 0;index < text.length; index++)
      stream.writeByte(text.charCodeAt(index));
  }
  function colorTableSize(length) {
    return Math.max(Math.ceil(Math.log2(length)), 1);
  }
  function gifDimension(value, label) {
    const rounded = Math.floor(value);
    if (!Number.isFinite(rounded) || rounded < 1 || rounded > 65535) {
      throw new RangeError(`GIF ${label} must be 1-65535`);
    }
    return rounded;
  }
  function boundedPositiveInt(value, label) {
    const rounded = Math.floor(value);
    if (!Number.isSafeInteger(rounded) || rounded < 1 || rounded > MAX_GIF_BYTES) {
      throw new RangeError(`${label} must be a positive safe integer <= ${MAX_GIF_BYTES}`);
    }
    return rounded;
  }
  var sq = (value) => value * value;

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/core/filmstrip.js
  function selectKeyFrames(timestampsMs, maxCells = FILMSTRIP_DEFAULTS.maxCells) {
    const n = Array.isArray(timestampsMs) ? timestampsMs.length : 0;
    if (n === 0)
      return [];
    const requestedCells = Number.isFinite(maxCells) ? Math.floor(maxCells) : FILMSTRIP_DEFAULTS.maxCells;
    const cells = Math.max(1, Math.min(requestedCells, n));
    if (cells === 1)
      return [0];
    if (cells >= n)
      return timestampsMs.map((_, i) => i);
    const first = timestampsMs[0];
    const span = timestampsMs[n - 1] - first;
    const picked = [0, n - 1];
    const seen = new Set(picked);
    for (let c = 1;c < cells - 1; c++) {
      const wantedIndex = (n - 1) * c / (cells - 1);
      const wanted = span > 0 ? first + span * c / (cells - 1) : timestampsMs[Math.round(wantedIndex)];
      let best = -1;
      let bestDelta = Infinity;
      let bestIndexDelta = Infinity;
      for (let i = 1;i < n - 1; i++) {
        if (seen.has(i))
          continue;
        const delta = Number.isFinite(timestampsMs[i]) && Number.isFinite(wanted) ? Math.abs(timestampsMs[i] - wanted) : Infinity;
        const indexDelta = Math.abs(i - wantedIndex);
        if (delta < bestDelta || delta === bestDelta && indexDelta < bestIndexDelta) {
          bestDelta = delta;
          bestIndexDelta = indexDelta;
          best = i;
        }
      }
      if (best < 0) {
        for (let i = 1;i < n - 1; i++) {
          if (seen.has(i))
            continue;
          const indexDelta = Math.abs(i - wantedIndex);
          if (indexDelta < bestIndexDelta) {
            bestIndexDelta = indexDelta;
            best = i;
          }
        }
      }
      seen.add(best);
      picked.push(best);
    }
    return picked.sort((a, b) => a - b);
  }
  function layoutFilmstrip({
    count,
    frameWidth,
    frameHeight,
    maxColumns = FILMSTRIP_DEFAULTS.maxColumns,
    maxWidth = FILMSTRIP_DEFAULTS.maxWidth,
    gap = FILMSTRIP_DEFAULTS.gap
  }) {
    const n = Math.max(0, Math.floor(finiteOr(count, 0)));
    const srcW = Math.max(1, Math.floor(finiteOr(frameWidth, 1)));
    const srcH = Math.max(1, Math.floor(finiteOr(frameHeight, 1)));
    const widthLimit = Math.max(1, Math.floor(Number(maxWidth) || 1));
    const requestedGap = Math.max(0, Math.floor(Number(gap) || 0));
    if (n === 0) {
      return { columns: 0, rows: 0, cellWidth: 0, cellHeight: 0, width: 0, height: 0, gap: requestedGap, cells: [] };
    }
    const requestedColumns = Math.max(1, Math.floor(Number(maxColumns) || 1));
    const columns = Math.max(1, Math.min(requestedColumns, n, widthLimit));
    const rows = Math.ceil(n / columns);
    const maxGap = Math.max(0, Math.floor((widthLimit - columns) / (columns + 1)));
    const effectiveGap = Math.min(requestedGap, maxGap);
    const available = widthLimit - effectiveGap * (columns + 1);
    const cellWidth = Math.max(1, Math.min(srcW, Math.floor(available / columns)));
    const cellHeight = Math.max(1, Math.round(srcH * (cellWidth / srcW)));
    const cells = [];
    for (let i = 0;i < n; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      cells.push({
        x: effectiveGap + col * (cellWidth + effectiveGap),
        y: effectiveGap + row * (cellHeight + effectiveGap)
      });
    }
    return {
      columns,
      rows,
      cellWidth,
      cellHeight,
      gap: effectiveGap,
      width: effectiveGap + columns * (cellWidth + effectiveGap),
      height: effectiveGap + rows * (cellHeight + effectiveGap),
      cells
    };
  }
  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  function buildFilmstripMeta({ indices, layout, timestampsMs, filename }) {
    return {
      file: filename,
      columns: layout.columns,
      rows: layout.rows,
      cellWidth: layout.cellWidth,
      cellHeight: layout.cellHeight,
      gap: layout.gap,
      width: layout.width,
      height: layout.height,
      cells: indices.map((frameIndex, i) => ({
        cell: i,
        frameIndex,
        timestampMs: Math.round(timestampsMs[frameIndex] ?? 0),
        x: layout.cells[i]?.x ?? 0,
        y: layout.cells[i]?.y ?? 0
      }))
    };
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/client/encoders.js
  var gifenc = typeof GIFEncoder === "function" ? exports_gifenc_safe : gifenc_safe_default ?? exports_gifenc_safe;
  var GIFEncoder2 = gifenc.GIFEncoder || gifenc.default;
  var { quantize: quantize2, applyPalette: applyPalette2 } = gifenc;
  async function encodeGifFrames2(frames, timestampsMs, options = {}) {
    if (!frames.length)
      throw new Error("Cannot encode a GIF without frames");
    const encoder = GIFEncoder2();
    const fallbackDelay = Math.max(20, Math.round(1000 / (options.fps || 10)));
    for (let index = 0;index < frames.length; index++) {
      const canvas = frames[index];
      const rgba = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const palette = quantize2(rgba, options.maxColors || 256);
      const indexed = applyPalette2(rgba, palette);
      const measuredDelay = frameDelay2(timestampsMs, index, options.durationMs);
      encoder.writeFrame(indexed, canvas.width, canvas.height, {
        palette,
        delay: Number.isFinite(measuredDelay) && measuredDelay > 0 ? measuredDelay : fallbackDelay,
        repeat: options.repeat ?? 0
      });
    }
    encoder.finish();
    return new Blob([encoder.bytes()], { type: "image/gif" });
  }
  async function encodeVideoFrames(frames, timestampsMs, options = {}) {
    if (!frames.length)
      throw new Error("Cannot encode a video without frames");
    const MediaRecorderImpl = options.MediaRecorder || globalThis.MediaRecorder;
    if (typeof MediaRecorderImpl !== "function") {
      throw new Error("MediaRecorder is not available in this browser");
    }
    const stage = createCanvas(frames[0].width, frames[0].height, options.document);
    if (typeof stage.captureStream !== "function") {
      throw new Error("Canvas captureStream is not available in this browser");
    }
    const fps = options.fps || 10;
    const mimeType = pickVideoMime(MediaRecorderImpl);
    const stream = stage.captureStream(fps);
    const recorderOptions = {};
    if (mimeType)
      recorderOptions.mimeType = mimeType;
    if (options.bitrate)
      recorderOptions.videoBitsPerSecond = options.bitrate;
    const chunks = [];
    const fallbackDelay = Math.max(1, Math.round(1000 / fps));
    let recorder;
    let stopRequested = false;
    try {
      recorder = new MediaRecorderImpl(stream, recorderOptions);
      const stopped = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = (event) => reject(event.error || new Error("MediaRecorder failed"));
      });
      stopped.catch(() => {});
      recorder.ondataavailable = (event) => {
        if (event.data?.size)
          chunks.push(event.data);
      };
      const context = stage.getContext("2d");
      const track = stream.getVideoTracks?.()[0];
      recorder.start();
      for (let index = 0;index < frames.length; index++) {
        context.clearRect(0, 0, stage.width, stage.height);
        context.drawImage(frames[index], 0, 0, stage.width, stage.height);
        if (typeof track?.requestFrame === "function")
          track.requestFrame();
        const measuredDelay = frameDelay2(timestampsMs, index, options.durationMs);
        await Promise.race([
          wait(Number.isFinite(measuredDelay) && measuredDelay > 0 ? measuredDelay : fallbackDelay),
          stopped
        ]);
      }
      recorder.stop();
      stopRequested = true;
      await stopped;
    } finally {
      if (recorder && !stopRequested) {
        try {
          recorder.stop();
        } catch {}
      }
      stream.getTracks?.().forEach((track) => track.stop());
    }
    const outputType = (recorder.mimeType || mimeType || "video/webm").split(";")[0];
    const filename = outputType === "video/mp4" ? ARTIFACTS.mp4 : ARTIFACTS.webm;
    return {
      blob: new Blob(chunks, { type: outputType }),
      filename,
      mimeType: outputType
    };
  }
  function createFilmstrip(frames, timestampsMs, options = {}) {
    if (!frames.length)
      throw new Error("Cannot create a filmstrip without frames");
    const indices = selectKeyFrames(timestampsMs, options.maxCells || FILMSTRIP_DEFAULTS.maxCells);
    const layout = layoutFilmstrip({
      count: indices.length,
      frameWidth: frames[0].width,
      frameHeight: frames[0].height,
      maxColumns: options.maxColumns || FILMSTRIP_DEFAULTS.maxColumns,
      maxWidth: options.maxWidth || FILMSTRIP_DEFAULTS.maxWidth,
      gap: options.gap ?? FILMSTRIP_DEFAULTS.gap
    });
    const canvas = createCanvas(layout.width, layout.height, options.document);
    const context = canvas.getContext("2d");
    context.fillStyle = options.background || FILMSTRIP_DEFAULTS.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    indices.forEach((frameIndex, cellIndex) => {
      const cell = layout.cells[cellIndex];
      context.drawImage(frames[frameIndex], cell.x, cell.y, layout.cellWidth, layout.cellHeight);
    });
    return {
      canvas,
      meta: buildFilmstripMeta({
        indices,
        layout,
        timestampsMs,
        filename: ARTIFACTS.frames
      })
    };
  }
  function pickVideoMime(MediaRecorderImpl) {
    const candidates = [
      "video/mp4;codecs=avc1",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm"
    ];
    if (typeof MediaRecorderImpl.isTypeSupported !== "function")
      return "";
    return candidates.find((type) => MediaRecorderImpl.isTypeSupported(type)) || "";
  }
  function createCanvas(width, height, documentImpl = globalThis.document) {
    const canvas = documentImpl.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  function frameDelay2(timestampsMs, index, durationMs) {
    const next = timestampsMs[index + 1];
    if (Number.isFinite(next))
      return next - timestampsMs[index];
    if (Number.isFinite(durationMs))
      return durationMs - timestampsMs[index];
    return NaN;
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/client/stability.js
  var FREEZE_ATTRIBUTE = "data-snapeye-freeze";
  var FREEZE_CSS = `*, *::before, *::after {
  animation-play-state: paused !important;
  transition-property: none !important;
}`;
  async function freezeMotion(documentImpl, { window: windowImpl, wait: wait2 } = {}) {
    const original = new Map(listAnimations(documentImpl).map((animation) => [animation, {
      animation,
      currentTime: readCurrentTime(animation),
      playState: animation.playState
    }]));
    const style = injectFreezeStyle(documentImpl);
    const entries = [];
    try {
      await nextFrames(windowImpl, wait2, 2);
      for (const animation of listAnimations(documentImpl)) {
        const entry = original.get(animation) || {
          animation,
          currentTime: readCurrentTime(animation),
          playState: animation.playState
        };
        entries.push(entry);
        try {
          if (isEndless(animation)) {
            animation.currentTime = 0;
            animation.pause();
          } else {
            animation.finish();
          }
        } catch {}
      }
    } catch (error) {
      restoreMotion();
      throw error;
    }
    return restoreMotion;
    function restoreMotion() {
      try {
        style?.remove();
      } catch {}
      for (const entry of entries.reverse()) {
        try {
          if (entry.currentTime != null)
            entry.animation.currentTime = entry.currentTime;
          if (entry.playState === "running")
            entry.animation.play();
          else if (entry.playState === "paused")
            entry.animation.pause();
        } catch {}
      }
      entries.length = 0;
    }
  }
  async function waitForSettled({ document: document2, window: windowImpl, element, budgetMs = 2500, wait: wait2 }) {
    if (!document2 || !(budgetMs > 0))
      return;
    const now = () => windowImpl?.performance?.now?.() ?? Date.now();
    const deadline = now() + budgetMs;
    let previous = null;
    let stable = 0;
    while (stable < 3) {
      await nextFrames(windowImpl, wait2, 1);
      const signature = pageSignature(document2, element);
      if (signature === previous)
        stable++;
      else {
        stable = 0;
        previous = signature;
      }
      if (now() >= deadline)
        return;
    }
  }
  function pageSignature(document2, element) {
    const root = document2.documentElement;
    const parts = [
      document2.readyState,
      root?.scrollWidth,
      root?.scrollHeight,
      document2.images?.length,
      document2.styleSheets?.length
    ];
    if (element?.getBoundingClientRect) {
      const rect = element.getBoundingClientRect();
      parts.push(Math.round(rect.width), Math.round(rect.height));
    }
    return parts.join("x");
  }
  async function waitForReady(spec, { document: document2, wait: wait2, now, timeoutMs = 5000 }) {
    if (spec == null || spec === "")
      return;
    const milliseconds = asMilliseconds(spec);
    if (milliseconds != null) {
      if (milliseconds > 0)
        await wait2(milliseconds);
      return;
    }
    const selector = String(spec);
    const deadline = now() + timeoutMs;
    for (;; ) {
      let found = null;
      try {
        found = document2.querySelector(selector);
      } catch {
        throw waitError(`SnapEye cannot wait for an invalid selector: ${selector}`);
      }
      if (found)
        return;
      if (now() >= deadline) {
        throw waitError(`SnapEye waited ${timeoutMs}ms for ${selector} and it never appeared`);
      }
      await wait2(50);
    }
  }
  function asMilliseconds(spec) {
    if (typeof spec === "number")
      return Number.isFinite(spec) && spec >= 0 ? spec : null;
    if (typeof spec === "string" && /^\d+(\.\d+)?$/.test(spec.trim()))
      return Number(spec);
    return null;
  }
  async function nextFrames(windowImpl, wait2, count) {
    for (let i = 0;i < count; i++) {
      if (typeof windowImpl?.requestAnimationFrame === "function") {
        await nextFrame(windowImpl);
      } else if (typeof wait2 === "function") {
        await wait2(16);
      } else {
        return;
      }
    }
  }
  function nextFrame(windowImpl) {
    const schedule = windowImpl.setTimeout?.bind(windowImpl) || globalThis.setTimeout;
    const cancel = windowImpl.clearTimeout?.bind(windowImpl) || globalThis.clearTimeout;
    return new Promise((resolve, reject) => {
      let frame;
      const timer = schedule(() => {
        try {
          windowImpl.cancelAnimationFrame?.(frame);
        } catch {}
        resolve();
      }, 100);
      try {
        frame = windowImpl.requestAnimationFrame(() => {
          cancel(timer);
          resolve();
        });
      } catch (error) {
        cancel(timer);
        reject(error);
      }
    });
  }
  function listAnimations(documentImpl) {
    if (typeof documentImpl?.getAnimations !== "function")
      return [];
    try {
      return Array.from(documentImpl.getAnimations()).filter(Boolean);
    } catch {
      return [];
    }
  }
  function isEndless(animation) {
    let timing;
    try {
      timing = animation.effect?.getComputedTiming?.();
    } catch {}
    if (!timing)
      return true;
    if (!Number.isFinite(timing.iterations))
      return true;
    return !Number.isFinite(timing.duration);
  }
  function readCurrentTime(animation) {
    try {
      return animation.currentTime;
    } catch {
      return null;
    }
  }
  function injectFreezeStyle(documentImpl) {
    const host = documentImpl?.head || documentImpl?.documentElement;
    if (!host || typeof documentImpl.createElement !== "function" || typeof host.appendChild !== "function") {
      return null;
    }
    try {
      const style = documentImpl.createElement("style");
      style.setAttribute(FREEZE_ATTRIBUTE, "");
      style.textContent = FREEZE_CSS;
      host.appendChild(style);
      return style;
    } catch {
      return null;
    }
  }
  function waitError(message) {
    const error = new Error(message);
    error.code = "CAPTURE_FAILED";
    error.publicMessage = message;
    return error;
  }

  // ../../node_modules/.bun/@zumer+snapeye@0.4.0+d2c423ec9f7d8080/node_modules/@zumer/snapeye/src/client/runtime.js
  var RUNTIME_STATE = Symbol.for("@zumer/snapeye/runtime");
  var KNOWN_OPERATIONS2 = new Set(OPERATIONS);
  var DEFAULTS2 = {
    snapdom: null,
    store: null,
    endpoint: "/__snapeye",
    token: null,
    autoOnQuery: true,
    triggerDelay: 100,
    forwardConsole: true,
    errorOverlay: true,
    hotkey: "S",
    hotkeyName: "current",
    hideSelectors: ["#__snapeye_err__"],
    stabilize: true,
    waitFor: null,
    settle: true,
    settleTimeout: 2500,
    waitTimeout: 5000,
    svg: true,
    snapdomOptions: {
      format: "png",
      dpr: 1,
      scale: 1,
      embedFonts: false
    },
    diffOptions: {
      threshold: DIFF_DEFAULTS.threshold,
      includeAA: false
    },
    filmstripOptions: {}
  };
  function attachSnapEye(userOptions = {}) {
    const windowImpl = userOptions.window || globalThis.window;
    const documentImpl = userOptions.document || windowImpl?.document || globalThis.document;
    if (!windowImpl || !documentImpl)
      throw new Error("SnapEye must be attached in a browser document");
    if (userOptions.reuse !== false && windowImpl[RUNTIME_STATE]?.api) {
      return windowImpl[RUNTIME_STATE].api;
    }
    const options = {
      ...DEFAULTS2,
      ...userOptions,
      snapdomOptions: { ...DEFAULTS2.snapdomOptions, ...userOptions.snapdomOptions },
      diffOptions: { ...DEFAULTS2.diffOptions, ...userOptions.diffOptions },
      filmstripOptions: { ...DEFAULTS2.filmstripOptions, ...userOptions.filmstripOptions }
    };
    if (typeof options.snapdom !== "function")
      throw new Error("snapeye: pass the `snapdom` function");
    const configuredStore = options.store || options.artifactStore;
    const legacy = options.legacy === true || options.legacy !== false && !configuredStore && userOptions.endpoint == null && userOptions.token == null;
    if (legacy)
      options.endpoint = "/__snapeye__";
    const store = configuredStore || (legacy ? createLegacyArtifactStore({
      endpoint: options.endpoint,
      fetch: options.fetch || windowImpl.fetch?.bind(windowImpl)
    }) : createHttpArtifactStore({
      endpoint: options.endpoint,
      token: options.token,
      fetch: options.fetch || windowImpl.fetch?.bind(windowImpl)
    }));
    assertArtifactStore(store);
    const clock = {
      now: options.now || (() => windowImpl.performance.now()),
      dateNow: options.dateNow || Date.now,
      wait: options.wait || ((ms) => new Promise((resolve) => windowImpl.setTimeout(resolve, ms)))
    };
    const dependencies = {
      diffCanvas: options.diffCanvas || diffCanvas,
      waitForSettled: options.waitForSettled || waitForSettled,
      encodeGif: options.encodeGif || encodeGifFrames2,
      encodeVideo: options.encodeVideo || encodeVideoFrames,
      createFilmstrip: options.createFilmstrip || createFilmstrip,
      freezeMotion: options.freezeMotion || freezeMotion,
      waitForReady: options.waitForReady || waitForReady
    };
    const originalConsole = {};
    let errorBox = null;
    async function capture(name, target, callOptions) {
      const args = normalizeCall(target, callOptions);
      return execute("capture", name, args.target, args.options);
    }
    async function diff(name, target, callOptions) {
      const args = normalizeCall(target, callOptions);
      return execute("diff", name, args.target, args.options);
    }
    async function record(name, target, callOptions) {
      const args = normalizeCall(target, callOptions);
      return execute("record", name, args.target, args.options);
    }
    async function execute(operation, name, targetInput, operationOptions = {}) {
      const runId = operationOptions.runId || generateRunId(clock.dateNow(), options.random || Math.random);
      const startedAt = new Date(clock.dateNow()).toISOString();
      try {
        assertRunId(runId);
      } catch (error) {
        reportTechnical(error);
        throw error;
      }
      let safeName;
      try {
        safeName = assertName(name);
      } catch (error) {
        return commitError({ runId, operation, name, startedAt, error });
      }
      if (!KNOWN_OPERATIONS2.has(operation)) {
        return commitError({
          runId,
          operation: "unknown",
          name: safeName,
          startedAt,
          error: new SnapEyeError(ERROR_CODES.INVALID_OPERATION, `Unknown SnapEye operation: ${operation}`)
        });
      }
      if (legacy && operation !== "capture") {
        return commitError({
          runId,
          operation,
          name: safeName,
          startedAt,
          error: new SnapEyeError(operation === "diff" ? ERROR_CODES.DIFF_FAILED : ERROR_CODES.RECORD_FAILED, "The legacy SnapEye handler supports capture only; use the Vite plugin for V1 operations")
        });
      }
      let resolved;
      try {
        const payload = await withHiddenElements(async () => {
          await dependencies.waitForReady(operationOptions.waitFor ?? options.waitFor, {
            document: documentImpl,
            wait: clock.wait,
            now: clock.now,
            timeoutMs: operationOptions.waitTimeout ?? options.waitTimeout
          });
          resolved = resolveTarget(targetInput, operationOptions);
          if ((operationOptions.settle ?? options.settle) !== false) {
            await dependencies.waitForSettled({
              document: documentImpl,
              window: windowImpl,
              element: resolved.element,
              budgetMs: operationOptions.settleTimeout ?? options.settleTimeout,
              wait: clock.wait
            });
          }
          const stabilize = operation !== "record" && (operationOptions.stabilize ?? options.stabilize) !== false;
          const restoreMotion = stabilize ? await dependencies.freezeMotion(documentImpl, { window: windowImpl, wait: clock.wait }) : null;
          try {
            if (operation === "capture")
              return await performCapture(runId, safeName, resolved, operationOptions);
            if (operation === "diff")
              return await performDiff(runId, safeName, resolved, operationOptions);
            return await performRecord(runId, safeName, resolved, operationOptions);
          } finally {
            restoreMotion?.();
          }
        });
        const result = buildResult({
          runId,
          status: "ok",
          operation,
          name: safeName,
          target: resolved.meta,
          startedAt,
          finishedAt: new Date(clock.dateNow()).toISOString(),
          ...payload
        });
        try {
          await store.commitResult(runId, result);
        } catch (error) {
          reportTechnical(error);
          throw persistenceError(error);
        }
        return result;
      } catch (error) {
        return commitError({ runId, operation, name: safeName, target: resolved?.meta, startedAt, error });
      }
    }
    async function commitError({ runId, operation, name, target, startedAt, error }) {
      const normalized = operationError(error, operation);
      reportTechnical(error);
      const result = buildErrorResult({
        runId,
        operation: KNOWN_OPERATIONS2.has(operation) ? operation : "unknown",
        name,
        target,
        startedAt,
        finishedAt: new Date(clock.dateNow()).toISOString(),
        code: normalized.code,
        message: normalized.message,
        details: normalized.details
      });
      try {
        await store.commitResult(runId, result);
        return result;
      } catch (commitFailure) {
        reportTechnical(commitFailure);
        throw persistenceError(commitFailure);
      }
    }
    async function performCapture(runId, name, target, operationOptions) {
      const captured = await captureTarget(target.element, operationOptions, true);
      const baselineMeta = {
        schemaVersion: SCHEMA_VERSION,
        name,
        capturedAt: new Date(clock.dateNow()).toISOString(),
        target: target.meta,
        image: captured.image
      };
      try {
        await store.writeBaseline(name, { image: captured.blob, meta: baselineMeta });
      } catch (error) {
        throw persistenceError(error);
      }
      const artifacts = { baseline: `../../baselines/${name}.png` };
      if (captured.svg != null) {
        await persistRunArtifacts(runId, [{ filename: ARTIFACTS.svg, data: captured.svg }]);
        artifacts.svg = ARTIFACTS.svg;
      }
      return {
        image: captured.image,
        timing: { captureMs: captured.captureMs },
        artifacts
      };
    }
    async function performDiff(runId, name, target, operationOptions) {
      let baseline;
      try {
        baseline = await store.readBaseline(name);
      } catch (error) {
        throw persistenceError(error);
      }
      if (!baseline)
        throw new SnapEyeError(ERROR_CODES.BASELINE_NOT_FOUND, `No baseline exists for ${name}`);
      validateBaselineMetadata(baseline.meta, name);
      let baselineCanvas;
      try {
        baselineCanvas = await blobToCanvas(baseline.image);
      } catch {
        throw new SnapEyeError(ERROR_CODES.BASELINE_INCOMPATIBLE, `Baseline ${name} is not a readable PNG`);
      }
      const captured = await captureTarget(target.element, operationOptions, true);
      assertBaselineCompatible(baseline.meta, baselineCanvas, captured.image);
      const diffOptions = {
        ...options.diffOptions,
        ...operationOptions.diffOptions
      };
      let comparison;
      try {
        comparison = dependencies.diffCanvas(baselineCanvas, captured.canvas, diffOptions);
      } catch {
        throw new SnapEyeError(ERROR_CODES.DIFF_FAILED, "SnapEye could not compare the current capture");
      }
      if (!comparison.dimsMatch) {
        throw new SnapEyeError(ERROR_CODES.BASELINE_INCOMPATIBLE, `Baseline ${name} has incompatible raster dimensions`);
      }
      const diffBlob = await canvasToPng(comparison.canvas);
      const changed = comparison.diff > 0;
      let regionCanvas = comparison.canvas;
      if (changed && needsRegionMask(diffOptions)) {
        try {
          regionCanvas = dependencies.diffCanvas(baselineCanvas, captured.canvas, {
            ...diffOptions,
            diffMask: true
          }).canvas;
        } catch {
          throw new SnapEyeError(ERROR_CODES.DIFF_FAILED, "SnapEye could not compare the current capture");
        }
      }
      const diffPixels2 = changed ? regionCanvas.getContext("2d").getImageData(0, 0, comparison.width, comparison.height).data : null;
      const regions = extractRegions(changed ? maskFromDiffBuffer(diffPixels2, diffOptions.diffColor) : new Uint8Array(0), changed ? comparison.width : 0, changed ? comparison.height : 0, { scale: captured.image.scale, ...operationOptions.regionOptions });
      const artifacts = {
        baseline: `../../baselines/${name}.png`,
        current: ARTIFACTS.current,
        diff: ARTIFACTS.diff
      };
      const runArtifacts = [
        { filename: ARTIFACTS.current, data: captured.blob },
        { filename: ARTIFACTS.diff, data: diffBlob }
      ];
      if (captured.svg != null) {
        runArtifacts.push({ filename: ARTIFACTS.svg, data: captured.svg });
        artifacts.svg = ARTIFACTS.svg;
      }
      await persistRunArtifacts(runId, runArtifacts);
      return {
        image: captured.image,
        timing: { captureMs: captured.captureMs },
        diff: {
          changed,
          changedRatio: computeChangedRatio(comparison.diff, comparison.total),
          ...regions
        },
        artifacts
      };
    }
    async function performRecord(runId, name, target, operationOptions) {
      let plan;
      try {
        plan = clampRecordOptions(operationOptions, readCssSize(target.element));
      } catch (error) {
        if (error?.code === "RECORD_BUDGET_EXCEEDED") {
          throw new SnapEyeError(ERROR_CODES.RECORD_FAILED, "The target is too large for SnapEye recording limits", error.details);
        }
        throw error;
      }
      const format = normalizeRecordFormat(operationOptions.format);
      const recordSnapdomOptions = {
        ...operationOptions.snapdomOptions,
        dpr: 1,
        outerShadows: false,
        burst: false,
        width: undefined,
        height: undefined
      };
      const frames = [];
      const timestampsMs = [];
      let firstImage = null;
      let firstWidth = 0;
      let firstHeight = 0;
      const started = clock.now();
      for (let frameIndex = 0;frameIndex < plan.frameCount; frameIndex++) {
        if (frameIndex > 0) {
          const delay = started + frameIndex * plan.intervalMs - clock.now();
          if (delay > 0)
            await clock.wait(delay);
          if (clock.now() - started >= plan.durationMs)
            break;
        }
        const timestamp = clock.now() - started;
        let captured;
        try {
          captured = await captureTarget(target.element, {
            ...operationOptions,
            scale: plan.scale,
            snapdomOptions: recordSnapdomOptions
          }, false);
        } catch {
          throw new SnapEyeError(ERROR_CODES.RECORD_FAILED, "SnapEye could not capture a recording frame");
        }
        if (!firstImage) {
          firstImage = captured.image;
          firstWidth = captured.canvas.width;
          firstHeight = captured.canvas.height;
          const actualFramePixels = firstWidth * firstHeight;
          const rasterBudgetFrames = Math.floor(plan.maxTotalPixels / actualFramePixels);
          if (rasterBudgetFrames < 1) {
            throw new SnapEyeError(ERROR_CODES.RECORD_FAILED, "The produced raster is too large for SnapEye recording limits", { actualFramePixels, maxTotalPixels: plan.maxTotalPixels });
          }
          if (rasterBudgetFrames < plan.frameCount) {
            plan.frameCount = rasterBudgetFrames;
            plan.intervalMs = plan.durationMs / plan.frameCount;
            plan.captureFps = Math.round(1000 / plan.intervalMs * 100) / 100;
          }
        }
        frames.push(normalizeFrame(captured.canvas, firstWidth, firstHeight));
        timestampsMs.push(roundTimestamp(timestamp));
      }
      if (!frames.length)
        throw new SnapEyeError(ERROR_CODES.RECORD_FAILED, "SnapEye did not capture any recording frames");
      const remaining = plan.durationMs - (clock.now() - started);
      if (remaining > 0)
        await clock.wait(remaining);
      const durationActualMs = Math.max(0, Math.round(clock.now() - started));
      const filmstrip = dependencies.createFilmstrip(frames, timestampsMs, {
        ...options.filmstripOptions,
        ...operationOptions.filmstripOptions,
        document: documentImpl
      });
      const filmstripBlob = await canvasToPng(filmstrip.canvas);
      const artifacts = { frames: ARTIFACTS.frames };
      const encodedArtifacts = [{ filename: ARTIFACTS.frames, data: filmstripBlob }];
      if (format === "gif" || format === "both") {
        const gif = await dependencies.encodeGif(frames, timestampsMs, {
          fps: plan.captureFps,
          durationMs: durationActualMs
        });
        artifacts.gif = ARTIFACTS.gif;
        encodedArtifacts.push({ filename: ARTIFACTS.gif, data: gif });
      }
      if (format === "video" || format === "both") {
        const video = await dependencies.encodeVideo(frames, timestampsMs, {
          fps: plan.captureFps,
          durationMs: durationActualMs,
          bitrate: operationOptions.bitrate,
          document: documentImpl
        });
        artifacts.video = video.filename;
        encodedArtifacts.push({ filename: video.filename, data: video.blob });
      }
      await persistRunArtifacts(runId, encodedArtifacts);
      return {
        image: firstImage,
        record: {
          durationRequestedMs: plan.durationRequestedMs,
          durationActualMs,
          fpsRequested: plan.fpsRequested,
          fpsActual: computeFpsActual(timestampsMs),
          frameCount: frames.length,
          timestampsMs,
          format,
          filmstrip: filmstrip.meta
        },
        artifacts
      };
    }
    async function persistRunArtifacts(runId, artifacts) {
      const settled = await Promise.allSettled(artifacts.map(({ filename, data }) => Promise.resolve().then(() => store.writeRunArtifact(runId, filename, data))));
      const failure = settled.find((result) => result.status === "rejected");
      if (failure)
        throw persistenceError(failure.reason);
    }
    async function captureTarget(element, operationOptions, includeBlob) {
      const fallbackCss = readCssSize(element);
      const captureOptions = { ...options.snapdomOptions, ...operationOptions.snapdomOptions };
      if (captureOptions.width == null)
        delete captureOptions.width;
      if (captureOptions.height == null)
        delete captureOptions.height;
      captureOptions.invalidate ??= true;
      captureOptions.canvas = null;
      if (operationOptions.scale != null)
        captureOptions.scale = Number(operationOptions.scale);
      const keepSvg = includeBlob && !legacy && (operationOptions.svg ?? options.svg) !== false;
      let canvas;
      let svg = null;
      const captureStart = clock.now();
      try {
        const result = await options.snapdom(element, captureOptions);
        if (typeof result?.toCanvas === "function")
          canvas = await result.toCanvas({ canvas: null });
        else if (typeof options.snapdom.toCanvas === "function")
          canvas = await options.snapdom.toCanvas(element, captureOptions);
        if (keepSvg)
          svg = readSvg(result);
        if (result?.meta?.vbW > 0 && result?.meta?.vbH > 0) {
          fallbackCss.width = result.meta.vbW;
          fallbackCss.height = result.meta.vbH;
        } else if (result?.meta?.w0 > 0 && result?.meta?.h0 > 0) {
          fallbackCss.width = result.meta.w0;
          fallbackCss.height = result.meta.h0;
        }
      } catch (error) {
        throw operationError(error, "capture");
      }
      const captureMs = Math.max(0, Math.round(clock.now() - captureStart));
      if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) {
        throw new SnapEyeError(ERROR_CODES.CAPTURE_FAILED, "SnapEye produced an empty capture");
      }
      const image = buildImageMeta({
        cssWidth: fallbackCss.width,
        cssHeight: fallbackCss.height,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height
      }, COORDINATE_SPACE);
      return { canvas, image, blob: includeBlob ? await canvasToPng(canvas) : null, svg, captureMs };
    }
    function resolveTarget(input, operationOptions) {
      const fallback = options.defaultTarget ? options.defaultTarget() : documentImpl.documentElement;
      const requested = input ?? operationOptions.target ?? fallback ?? documentImpl.documentElement;
      let element = requested;
      let selector;
      if (typeof requested === "string") {
        selector = requested;
        try {
          element = documentImpl.querySelector(requested);
        } catch {
          element = null;
        }
      }
      if (!isElement(element)) {
        throw new SnapEyeError(ERROR_CODES.TARGET_NOT_FOUND, `SnapEye target was not found: ${selector || describeTarget(requested)}`);
      }
      return { element, meta: selector ? { selector } : descriptorForElement(element) };
    }
    async function blobToCanvas(blob) {
      const canvas = documentImpl.createElement("canvas");
      if (typeof windowImpl.createImageBitmap === "function") {
        const bitmap = await windowImpl.createImageBitmap(blob);
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        bitmap.close?.();
        return canvas;
      }
      const image = new windowImpl.Image;
      const objectUrl = windowImpl.URL.createObjectURL(blob);
      try {
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error("Baseline PNG could not be decoded"));
          image.src = objectUrl;
        });
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return canvas;
      } finally {
        windowImpl.URL.revokeObjectURL(objectUrl);
      }
    }
    async function canvasToPng(canvas) {
      if (typeof canvas.convertToBlob === "function")
        return canvas.convertToBlob({ type: "image/png" });
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Canvas PNG export failed")), "image/png");
      });
    }
    function normalizeFrame(canvas, width, height) {
      if (canvas.width === width && canvas.height === height)
        return canvas;
      const fixed = documentImpl.createElement("canvas");
      fixed.width = width;
      fixed.height = height;
      fixed.getContext("2d").drawImage(canvas, 0, 0, width, height);
      return fixed;
    }
    async function withHiddenElements(work) {
      const hidden = [];
      for (const selector of options.hideSelectors || []) {
        let elements = [];
        try {
          elements = documentImpl.querySelectorAll(selector);
        } catch {}
        elements.forEach((element) => {
          hidden.push([element, element.style.display]);
          element.style.display = "none";
        });
      }
      try {
        return await work();
      } finally {
        hidden.forEach(([element, display]) => {
          element.style.display = display;
        });
      }
    }
    function log(level, ...args) {
      if (!options.forwardConsole)
        return Promise.resolve(false);
      return store.log ? store.log(level, ...args) : Promise.resolve(false);
    }
    function reportTechnical(error) {
      const output = originalConsole.error || windowImpl.console.error.bind(windowImpl.console);
      output("[snapeye]", error);
    }
    function showError(message) {
      if (!options.errorOverlay)
        return;
      if (!errorBox) {
        errorBox = documentImpl.createElement("div");
        errorBox.id = "__snapeye_err__";
        errorBox.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;font:13px/1.4 ui-monospace,Menlo,monospace;padding:10px 16px;max-height:40vh;overflow:auto;white-space:pre-wrap";
        const close = documentImpl.createElement("button");
        close.type = "button";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close SnapEye error overlay");
        close.style.cssText = "float:right;background:none;border:0;color:inherit;font:20px/1 monospace;cursor:pointer";
        close.onclick = () => {
          errorBox.remove();
          errorBox = null;
        };
        errorBox.appendChild(close);
        documentImpl.body?.appendChild(errorBox);
      }
      const row = documentImpl.createElement("div");
      row.textContent = message;
      errorBox.appendChild(row);
      log("error", message);
    }
    function installConsoleForwarding() {
      if (!options.forwardConsole)
        return;
      ["log", "warn", "error", "info"].forEach((method) => {
        const original = windowImpl.console[method]?.bind(windowImpl.console);
        if (!original)
          return;
        originalConsole[method] = original;
        windowImpl.console[method] = (...args) => {
          original(...args);
          log(method, ...args);
        };
      });
    }
    const onWindowError = (event) => showError(`ERROR: ${event.message} (${event.filename}:${event.lineno})`);
    const onUnhandledRejection = (event) => showError(`PROMISE: ${event.reason?.message || event.reason || event}`);
    const onKeydown = (event) => {
      if (!options.hotkey)
        return;
      if (event.ctrlKey || event.metaKey || event.altKey)
        return;
      if (!event.shiftKey || typeof event.key !== "string")
        return;
      if (event.key.toUpperCase() !== String(options.hotkey).toUpperCase())
        return;
      if (isEditableEventTarget(event))
        return;
      event.preventDefault();
      capture(options.hotkeyName || "current").catch(reportTechnical);
    };
    function installListeners() {
      installConsoleForwarding();
      if (options.errorOverlay) {
        windowImpl.addEventListener("error", onWindowError);
        windowImpl.addEventListener("unhandledrejection", onUnhandledRejection);
      }
      if (options.hotkey)
        documentImpl.addEventListener("keydown", onKeydown);
    }
    function destroy() {
      Object.entries(originalConsole).forEach(([method, original]) => {
        windowImpl.console[method] = original;
      });
      windowImpl.removeEventListener("error", onWindowError);
      windowImpl.removeEventListener("unhandledrejection", onUnhandledRejection);
      documentImpl.removeEventListener("keydown", onKeydown);
      errorBox?.remove();
      delete windowImpl[RUNTIME_STATE];
    }
    async function runUrlTrigger(href = windowImpl.location.href) {
      const url = new URL(href);
      const hasOperation = url.searchParams.has(TRIGGER_PARAM);
      const operation = hasOperation ? url.searchParams.get(TRIGGER_PARAM) : null;
      const legacyName = !hasOperation ? url.searchParams.get("snap") : null;
      if (!hasOperation && !legacyName)
        return null;
      if (legacyName)
        return capture(legacyName === "1" ? "current" : legacyName);
      const runId = url.searchParams.get("run");
      const name = url.searchParams.get("name");
      if (!runId || !isValidRunId(runId)) {
        reportTechnical(new SnapEyeError(ERROR_CODES.INVALID_RUN_ID, "SnapEye URL operations require a valid `run` parameter (1-64 chars of [A-Za-z0-9_-])"));
        return null;
      }
      const target = url.searchParams.get("target") || undefined;
      const urlOptions = {
        runId,
        duration: url.searchParams.get("duration") || undefined,
        fps: url.searchParams.get("fps") || undefined,
        format: url.searchParams.get("format") || undefined,
        scale: url.searchParams.get("scale") || undefined,
        waitFor: url.searchParams.get("wait") || undefined,
        stabilize: url.searchParams.get("stabilize") === "0" ? false : undefined,
        settle: url.searchParams.get("settle") === "0" ? false : undefined,
        svg: url.searchParams.get("svg") === "0" ? false : undefined
      };
      const rawSnapdomOptions = url.searchParams.get(SNAPDOM_OPTIONS_PARAM);
      if (rawSnapdomOptions && KNOWN_OPERATIONS2.has(operation)) {
        try {
          urlOptions.snapdomOptions = parseSnapdomOptionsParam(rawSnapdomOptions);
        } catch (error) {
          return commitError({
            runId,
            operation,
            name,
            startedAt: new Date(clock.dateNow()).toISOString(),
            error: new SnapEyeError(operation === "diff" ? ERROR_CODES.DIFF_FAILED : operation === "record" ? ERROR_CODES.RECORD_FAILED : ERROR_CODES.CAPTURE_FAILED, `Invalid ${SNAPDOM_OPTIONS_PARAM} in the URL: ${error.message}`)
          });
        }
      }
      if (operation === "capture")
        return capture(name, target, urlOptions);
      if (operation === "diff")
        return diff(name, target, urlOptions);
      if (operation === "record")
        return record(name, target, urlOptions);
      return execute(operation, name, target, urlOptions);
    }
    function queueUrlTrigger() {
      const run = () => windowImpl.setTimeout(() => runUrlTrigger().catch(reportTechnical), Math.max(0, options.triggerDelay));
      if (documentImpl.readyState === "loading")
        documentImpl.addEventListener("DOMContentLoaded", run, { once: true });
      else
        run();
    }
    const api = {
      capture,
      diff,
      record,
      snap: capture,
      log,
      runUrlTrigger,
      destroy,
      options: publicOptions(options),
      protocolVersion: PROTOCOL_VERSION
    };
    windowImpl.snapeye = api;
    windowImpl[RUNTIME_STATE] = { api };
    installListeners();
    if (options.autoOnQuery)
      queueUrlTrigger();
    return api;
  }
  function normalizeCall(target, options) {
    if (options == null && isOptionsObject(target))
      return { target: undefined, options: target };
    return { target, options: options || {} };
  }
  function isOptionsObject(value) {
    return value && typeof value === "object" && !isElement(value) && !Array.isArray(value);
  }
  function isEditableEventTarget(event) {
    const target = event?.target;
    if (!target || typeof target !== "object")
      return false;
    if (target.isContentEditable === true)
      return true;
    const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }
  function isElement(value) {
    return value != null && value.nodeType === 1 && typeof value.tagName === "string";
  }
  function descriptorForElement(element) {
    if (element.id)
      return { selector: `#${safeCssIdentifier(element.id)}` };
    const tag = element.tagName.toLowerCase();
    const classes = Array.from(element.classList || []).slice(0, 3);
    return { descriptor: classes.length ? `${tag}.${classes.map(safeCssIdentifier).join(".")}` : tag };
  }
  function safeCssIdentifier(value) {
    if (globalThis.CSS?.escape)
      return globalThis.CSS.escape(value);
    return String(value).replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
  }
  function describeTarget(target) {
    if (target == null)
      return "default target";
    if (typeof target === "string")
      return target;
    return Object.prototype.toString.call(target);
  }
  function readCssSize(element) {
    const rect = element.getBoundingClientRect();
    const width = rect.width || element.scrollWidth || element.clientWidth;
    const height = rect.height || element.scrollHeight || element.clientHeight;
    if (!(width > 0) || !(height > 0)) {
      throw new SnapEyeError(ERROR_CODES.CAPTURE_FAILED, "SnapEye target has no visible dimensions");
    }
    return { width, height };
  }
  function validateBaselineMetadata(meta, name) {
    if (!meta || meta.schemaVersion !== SCHEMA_VERSION || !meta.image || meta.name !== name) {
      throw new SnapEyeError(ERROR_CODES.BASELINE_INCOMPATIBLE, `Baseline ${name} has missing or unsupported metadata`);
    }
  }
  function assertBaselineCompatible(meta, canvas, current) {
    const baseline = meta.image;
    const rasterMatches = canvas.width === baseline.pixelWidth && canvas.height === baseline.pixelHeight && current.pixelWidth === baseline.pixelWidth && current.pixelHeight === baseline.pixelHeight;
    const cssMatches = nearlyEqual(current.cssWidth, baseline.cssWidth, 0.5) && nearlyEqual(current.cssHeight, baseline.cssHeight, 0.5);
    const scaleMatches = nearlyEqual(current.scale, baseline.scale, 0.01);
    if (!rasterMatches || !cssMatches || !scaleMatches) {
      throw new SnapEyeError(ERROR_CODES.BASELINE_INCOMPATIBLE, "Baseline and current capture use incompatible dimensions or scale", {
        baseline: {
          cssWidth: baseline.cssWidth,
          cssHeight: baseline.cssHeight,
          pixelWidth: baseline.pixelWidth,
          pixelHeight: baseline.pixelHeight,
          scale: baseline.scale
        },
        current
      });
    }
  }
  function nearlyEqual(left, right, tolerance) {
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
  }
  function normalizeRecordFormat(value) {
    const format = value || "gif";
    if (format === "gif" || format === "video" || format === "both")
      return format;
    throw new SnapEyeError(ERROR_CODES.RECORD_FAILED, 'Record format must be "gif", "video", or "both"');
  }
  function needsRegionMask(options) {
    if (options.diffMask)
      return false;
    const [r, g, b] = options.diffColor ?? [255, 0, 0];
    if (r === g && g === b)
      return true;
    const aaColor = options.aaColor ?? [255, 255, 0];
    return !options.includeAA && r === aaColor[0] && g === aaColor[1] && b === aaColor[2];
  }
  function roundTimestamp(value) {
    return Math.max(0, Math.round(value));
  }
  function assertArtifactStore(store) {
    for (const method of ["readBaseline", "writeBaseline", "writeRunArtifact", "commitResult"]) {
      if (typeof store?.[method] !== "function")
        throw new TypeError(`SnapEye ArtifactStore is missing ${method}()`);
    }
  }
  function publicOptions(options) {
    return {
      endpoint: options.endpoint,
      autoOnQuery: options.autoOnQuery,
      forwardConsole: options.forwardConsole,
      errorOverlay: options.errorOverlay,
      hotkey: options.hotkey,
      hotkeyName: options.hotkeyName || "current",
      hideSelectors: [...options.hideSelectors || []],
      stabilize: options.stabilize !== false,
      settle: options.settle !== false,
      waitFor: options.waitFor ?? null,
      svg: options.svg !== false,
      snapdomOptions: { ...options.snapdomOptions }
    };
  }
  function readSvg(result) {
    if (typeof result?.toRaw !== "function")
      return null;
    let raw;
    try {
      raw = result.toRaw();
    } catch {
      return null;
    }
    if (typeof raw !== "string")
      return null;
    if (/^\s*<(\?xml|svg)/i.test(raw))
      return raw;
    const comma = raw.indexOf(",");
    if (!/^data:image\/svg\+xml/i.test(raw) || comma < 0)
      return null;
    const header = raw.slice(0, comma);
    const payload = raw.slice(comma + 1);
    try {
      if (/;base64/i.test(header)) {
        const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
        return new TextDecoder().decode(bytes);
      }
      return decodeURIComponent(payload);
    } catch {
      return null;
    }
  }
  // ../../node_modules/.bun/@zumer+snapdom@3.0.0/node_modules/@zumer/snapdom/dist/snapdom.mjs
  var Wa = Object.defineProperty;
  var ct = (t, e, n) => () => {
    if (n)
      throw n[0];
    try {
      return t && (e = t(t = 0)), e;
    } catch (r) {
      throw n = [r], r;
    }
  };
  var ze = (t, e) => {
    for (var n in e)
      Wa(t, n, { get: e[n], enumerable: true });
  };
  function zo(t) {
    return t === false || typeof t == "string" && t.toLowerCase().trim() === "disabled" ? "disabled" : "soft";
  }
  function jo(t = "soft") {
    t === "disabled" && (P.computedStyle = new WeakMap, P.measureHints = new WeakMap, P.baseStyle = new ot(50), P.defaultStyle = new ot(64), P.image = new ot(100), P.background = new ot(100), P.resource = new ot(150), P.compress = new ot(50));
  }
  var ot;
  var P;
  var dt = ct(() => {
    ot = class extends Map {
      constructor(e = 100, ...n) {
        super(...n), this._maxSize = e;
      }
      set(e, n) {
        if (this.size >= this._maxSize && !this.has(e)) {
          let r = this.keys().next().value;
          r !== undefined && this.delete(r);
        }
        return super.set(e, n);
      }
    }, P = { image: new ot(100), background: new ot(100), resource: new ot(150), defaultStyle: new ot(64), baseStyle: new ot(50), compress: new ot(50), computedStyle: new WeakMap, measureHints: new WeakMap, warnedReconcile: false };
  });
  function Kt(t) {
    let e = t.match(/url\((['"]?)(.*?)(\1)\)/);
    if (!e)
      return null;
    let n = e[2].trim();
    return n.startsWith("#") ? null : n;
  }
  function Da(t) {
    let e = [], n = 0, r = 0, i = "";
    for (let o = 0;o < t.length; o++) {
      let s = t[o];
      if (s === "\\") {
        o++;
        continue;
      }
      i ? s === i && (i = "") : s === '"' || s === "'" ? i = s : s === "(" ? r++ : s === ")" ? r-- : s === "," && r === 0 && (e.push(t.slice(n, o)), n = o + 1);
    }
    return e.push(t.slice(n)), e;
  }
  function je(t, e = 1) {
    let n = t.match(/^\s*-?(?:webkit-)?image-set\(([\s\S]*)\)\s*$/i);
    if (!n)
      return null;
    let r = [];
    for (let o of Da(n[1])) {
      let s = o.match(/url\((['"]?)(.*?)(\1)\)/);
      if (!s)
        continue;
      let a = o.match(/type\(\s*["']([^"']+)["']\s*\)/i);
      if (a && !Oa.test(a[1].trim()))
        continue;
      let c = o.replace(/url\((['"]?)[\s\S]*?\1\)/, " ").match(/(\d+(?:\.\d+)?)\s*(x|dpi|dppx)\b/i), f = 1;
      if (c) {
        let l = parseFloat(c[1]);
        f = /dpi/i.test(c[2]) ? l / 96 : l;
      }
      r.push({ url: s[2].trim(), dppx: f });
    }
    return r.length ? (r.sort((o, s) => o.dppx - s.dppx), (r.find((o) => o.dppx >= e) || r[r.length - 1]).url) : null;
  }
  function mr(t) {
    if (!t || t === "none")
      return "";
    let e = t.replace(/translate[XY]?\([^)]*\)/g, "");
    return e = e.replace(/matrix\(([^)]+)\)/g, (n, r) => {
      let i = r.split(",").map((o) => o.trim());
      return i.length !== 6 ? `matrix(${r})` : (i[4] = "0", i[5] = "0", `matrix(${i.join(", ")})`);
    }), e = e.replace(/matrix3d\(([^)]+)\)/g, (n, r) => {
      let i = r.split(",").map((o) => o.trim());
      return i.length !== 16 ? `matrix3d(${r})` : (i[12] = "0", i[13] = "0", `matrix3d(${i.join(", ")})`);
    }), e.trim().replace(/\s{2,}/g, " ");
  }
  function Dt(t) {
    if (/%[0-9A-Fa-f]{2}/.test(t))
      return t;
    try {
      return encodeURI(t);
    } catch {
      return t;
    }
  }
  function gr(t, e) {
    if (!t || /^(data|blob|about|#)/i.test(t.trim()))
      return t;
    try {
      let n = e || typeof document < "u" && (document.baseURI || document.location?.href) || "http://localhost/";
      return new URL(t, n).href;
    } catch {
      return t;
    }
  }
  function Ve(t) {
    return !!t && t.tagName === "INPUT" && (t.getAttribute("type") || "").toLowerCase() === "password";
  }
  function yr(t) {
    return "•".repeat(String(t ?? "").length);
  }
  function rt(t, e) {
    return t?.nodeType === 1 && t.localName === e;
  }
  function vt(t) {
    return t?.nodeType === 1 && t.namespaceURI === Ba;
  }
  function Bt(t) {
    return t?.nodeType === 1 && t.namespaceURI === Ua;
  }
  function ue(t) {
    return t?.nodeType === 11 && !!t.host;
  }
  function br(t) {
    return t?.nodeType === 9;
  }
  var hr;
  var Oa;
  var Ba;
  var Ua;
  var bt = ct(() => {
    hr = /^image\/(jpeg|jpg|png|gif|webp|avif|apng|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)\s*(;|$)/i, Oa = hr;
    Ba = "http://www.w3.org/1999/xhtml", Ua = "http://www.w3.org/2000/svg";
  });
  function Ha(t = "[snapDOM]", { ttlMs: e = 5 * 60000, maxEntries: n = 12 } = {}) {
    let r = new Map, i = 0;
    function o(s, a, c) {
      if (i >= n)
        return;
      let f = Date.now();
      (r.get(a) || 0) > f || (r.set(a, f + e), i++, s === "warn" && console && console.warn ? console.warn(`${t} ${c}`) : console && console.error && console.error(`${t} ${c}`));
    }
    return { warnOnce(s, a) {
      o("warn", s, a);
    }, errorOnce(s, a) {
      o("error", s, a);
    }, reset() {
      r.clear(), i = 0;
    } };
  }
  function Go(t, e, n) {
    if (Pt.size >= qo) {
      let r = Date.now();
      for (let [i, o] of Pt)
        o.until <= r && Pt.delete(i);
      for (;Pt.size >= qo; )
        Pt.delete(Pt.keys().next().value);
    }
    Pt.set(t, { until: Date.now() + n, result: e });
  }
  function za(t) {
    return /^data:|^blob:|^about:blank$/i.test(t);
  }
  function ja(t, e) {
    try {
      let n = typeof location < "u" && location.href ? location.href : "http://localhost/", r = e.split(/\{url(?:Raw)?\}/)[0], i = new URL(r || ".", n);
      if (new URL(t, n).origin === i.origin)
        return true;
    } catch {}
    return false;
  }
  function Va(t, e) {
    if (!e || za(t) || ja(t, e))
      return false;
    try {
      let n = typeof location < "u" && location.href ? location.href : "http://localhost/", r = new URL(t, n);
      return typeof location < "u" ? r.origin !== location.origin : true;
    } catch {
      return !!e;
    }
  }
  function qa(t, e) {
    if (!e)
      return t;
    if (/\{url(?:Raw)?\}/.test(e))
      return e.replace("{urlRaw}", () => Dt(t)).replace("{url}", () => encodeURIComponent(t));
    if (/[?&]url=?$/.test(e))
      return `${e}${encodeURIComponent(t)}`;
    if (e.endsWith("?"))
      return `${e}url=${encodeURIComponent(t)}`;
    if (e.endsWith("/"))
      return `${e}${Dt(t)}`;
    let n = e.includes("?") ? "&" : "?";
    return `${e}${n}url=${encodeURIComponent(t)}`;
  }
  function Xo(t) {
    return new Promise((e, n) => {
      let r = new FileReader;
      r.onload = () => e(String(r.result || "")), r.onerror = () => n(new Error("read_failed")), r.readAsDataURL(t);
    });
  }
  function Ga(t, e) {
    return new Headers(e.headers || {}).keys().next().done ? JSON.stringify([e.as || "blob", e.timeout ?? 3000, e.useProxy || "", e.errorTTL ?? 8000, e.credentials || "", t]) : null;
  }
  function Yo(t) {
    try {
      return new URL(t, globalThis.location?.href || "http://localhost/").origin;
    } catch {
      return "invalid-url";
    }
  }
  function Sr(t, e) {
    try {
      t.onError?.(e);
    } catch {}
  }
  async function it(t, e = {}) {
    let n = e.as ?? "blob", r = e.timeout ?? 3000, i = e.useProxy || "", o = e.errorTTL ?? 8000, s = e.headers || {}, a = !!e.silent;
    if (/^data:/i.test(t))
      try {
        if (n === "text")
          return { ok: true, data: String(t), status: 200, url: t, fromCache: false };
        if (n === "dataURL")
          return { ok: true, data: String(t), status: 200, url: t, fromCache: false, mime: String(t).slice(5).split(";")[0] || "" };
        let [, g = "", y = ""] = String(t).match(/^data:([^,]*),(.*)$/) || [], w = /;base64/i.test(g) ? atob(y) : decodeURIComponent(y), C = new Uint8Array([...w].map((S) => S.charCodeAt(0))), x = new Blob([C], { type: (g || "").split(";")[0] || "" });
        return { ok: true, data: x, status: 200, url: t, fromCache: false, mime: x.type || "" };
      } catch {
        return { ok: false, data: null, status: 0, url: t, fromCache: false, reason: "special_url_error" };
      }
    if (/^blob:/i.test(t))
      try {
        let g = await fetch(t);
        if (!g.ok)
          return { ok: false, data: null, status: g.status, url: t, fromCache: false, reason: "http_error" };
        let y = await g.blob(), b = y.type || g.headers.get("content-type") || "";
        return n === "dataURL" ? { ok: true, data: await Xo(y), blob: y, status: g.status, url: t, fromCache: false, mime: b } : n === "text" ? { ok: true, data: await y.text(), status: g.status, url: t, fromCache: false, mime: b } : { ok: true, data: y, status: g.status, url: t, fromCache: false, mime: b };
      } catch {
        return { ok: false, data: null, status: 0, url: t, fromCache: false, reason: "network" };
      }
    if (/^about:blank$/i.test(t))
      return n === "dataURL" ? { ok: true, data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", status: 200, url: t, fromCache: false, mime: "image/png" } : { ok: true, data: n === "text" ? "" : new Blob([]), status: 200, url: t, fromCache: false };
    let c;
    try {
      c = Ga(t, { as: n, timeout: r, useProxy: i, errorTTL: o, credentials: e.credentials, headers: s });
    } catch {
      let g = { ok: false, data: null, status: 0, url: t, fromCache: false, reason: "network" };
      return Sr(e, g), g;
    }
    let f = Pt.get(c);
    if (f && f.until > Date.now())
      return { ...f.result, fromCache: true };
    f && Pt.delete(c);
    let l = wr.get(c);
    if (l)
      return l;
    let u = Va(t, i) ? qa(t, i) : t, p = e.credentials;
    if (!p)
      try {
        let g = typeof location < "u" && location.href ? location.href : "http://localhost/", y = new URL(t, g);
        p = typeof location < "u" && y.origin === location.origin ? "include" : "omit";
      } catch {
        p = "omit";
      }
    let h = new AbortController, d = setTimeout(() => h.abort("timeout"), r), m = (async () => {
      try {
        let g = await fetch(u, { signal: h.signal, credentials: p, headers: s });
        if (!g.ok) {
          let w = { ok: false, data: null, status: g.status, url: u, fromCache: false, reason: "http_error" };
          if (c !== null && o > 0 && Go(c, w, o), !a) {
            let C = `${g.status} ${g.statusText || ""}`.trim();
            Vo.warnOnce(`http:${g.status}:${n}:${Yo(t)}`, `HTTP error ${C} while fetching ${n} ${t}`);
          }
          return Sr(e, w), w;
        }
        if (n === "text")
          return { ok: true, data: await g.text(), status: g.status, url: u, fromCache: false };
        let y = await g.blob(), b = y.type || g.headers.get("content-type") || "";
        return n === "dataURL" ? { ok: true, data: await Xo(y), blob: y, status: g.status, url: u, fromCache: false, mime: b } : { ok: true, data: y, status: g.status, url: u, fromCache: false, mime: b };
      } catch (g) {
        let y = h.signal.aborted ? h.signal.reason === "timeout" ? "timeout" : "abort" : g && typeof g == "object" && g.name === "AbortError" ? "abort" : "network", b = { ok: false, data: null, status: 0, url: u, fromCache: false, reason: y };
        if (c !== null && !/^blob:/i.test(t) && o > 0 && Go(c, b, o), !a) {
          let w = `${y}:${n}:${Yo(t)}`, C = y === "timeout" ? `Timeout after ${r}ms. Consider increasing timeout or using a proxy for ${t}` : y === "abort" ? `Request aborted while fetching ${n} ${t}` : `Network/CORS issue while fetching ${n} ${t}. A proxy may be required`;
          Vo.errorOnce(w, C);
        }
        return Sr(e, b), b;
      } finally {
        clearTimeout(d), wr.delete(c);
      }
    })();
    return c !== null && wr.set(c, m), m;
  }
  var Vo;
  var wr;
  var qo;
  var Pt;
  var de = ct(() => {
    bt();
    Vo = Ha("[snapDOM]", { ttlMs: 3 * 60000, maxEntries: 10 }), wr = new Map, qo = 50, Pt = new Map;
  });
  async function pe(t, e = {}) {
    if (/^((repeating-)?(linear|radial|conic)-gradient)\(/i.test(t) || t.trim() === "none")
      return t;
    let r = je(t, typeof devicePixelRatio < "u" && devicePixelRatio || 1) ?? Kt(t);
    if (!r)
      return t;
    let i = gr(r), o = Dt(i), s = (e.useProxy || "") + "|" + o;
    if (P.background.has(s)) {
      let a = P.background.get(s);
      return a ? `url("${a}")` : "none";
    }
    try {
      let a = await it(o, { as: "dataURL", useProxy: e.useProxy });
      return a.ok ? (P.background.set(s, a.data), `url("${a.data}")`) : (P.background.set(s, null), "none");
    } catch {
      return P.background.set(s, null), "none";
    }
  }
  var Ko = ct(() => {
    dt();
    bt();
    de();
  });
  function Za(t) {
    let e = t.replace(Ja, "").trim();
    return e ? e.replace(/(^|,)(\s*)(?=,|$)/g, "$1$2*") : "*";
  }
  function Zo(t, e, n, r) {
    for (let i = 0;i < t.length; i++) {
      if (--r.budget < 0)
        return false;
      let o = t[i], s = o.style;
      if (s) {
        let c = !!o.selectorText && Ka.test(o.selectorText);
        for (let f = 0;f < s.length; f++) {
          let l = s[f];
          if (e.add(l), c && r.pseudoProps.add(l), s.getPropertyPriority(l) && r.importantProps.add(l), l.length > 5 && (l[0] === "m" || l[0] === "p")) {
            let u = l.startsWith("margin") ? "marginUnstable" : l.startsWith("padding") ? "paddingUnstable" : null;
            u && !r[u] && Qa.test(s.getPropertyValue(l)) && (r[u] = true);
          }
        }
      }
      let a = o.selectorText;
      if (a && a.includes(":has(") && (r.usesHas = true), a && a.includes("&"))
        for (let c = o.parentRule;c && a.includes("&"); c = c.parentRule)
          c.selectorText && (a = a.replace(/&/g, `:is(${c.selectorText})`));
      if (a && (r.inContainer || Jo.test(a) || a.includes("+") || a.includes("~")))
        for (let c of tc(a, ",")) {
          let f = c.trim();
          f && (r.inContainer || Jo.test(f) || f.includes("+") || f.includes("~")) && r.shareUnsafeSels.add(f);
        }
      if (a && a.includes(":"))
        for (let c in Qo)
          Qo[c].test(a) && n[c].push(Za(a));
      if (o.styleSheet) {
        if (!xr(o.styleSheet, e, n, r))
          return false;
      } else if (o.cssRules && o.cssRules.length) {
        let c = o.constructor?.name === "CSSContainerRule";
        c && r.inContainer++;
        let f = Zo(o.cssRules, e, n, r);
        if (c && r.inContainer--, !f)
          return false;
      }
    }
    return true;
  }
  function xr(t, e, n, r) {
    let i;
    try {
      i = t.cssRules;
    } catch {
      return false;
    }
    return i ? Zo(i, e, n, r) : false;
  }
  function tc(t, e) {
    let n = [], r = 0, i = null, o = 0;
    for (let s = 0;s < t.length; s++) {
      let a = t[s];
      if (i) {
        a === i && t[s - 1] !== "\\" && (i = null);
        continue;
      }
      a === '"' || a === "'" ? i = a : a === "(" || a === "[" ? r++ : a === ")" || a === "]" ? r-- : r === 0 && a === e && (n.push(t.slice(o, s)), o = s + 1);
    }
    return n.push(t.slice(o)), n;
  }
  function ec(t) {
    let e = 0, n = null, r = 0;
    for (let l = 0;l < t.length; l++) {
      let u = t[l];
      if (n) {
        u === n && t[l - 1] !== "\\" && (n = null);
        continue;
      }
      u === '"' || u === "'" ? n = u : u === "(" || u === "[" ? e++ : u === ")" || u === "]" ? e-- : e === 0 && (u === " " || u === ">" || u === "+" || u === "~") && (r = l + 1);
    }
    let i = "", o = 0;
    for (let l of t.slice(r))
      l === "(" || l === "[" ? o++ : l === ")" || l === "]" ? o-- : o === 0 && (i += l);
    let s = (l) => !l || /\\[0-9a-fA-F]/.test(l) ? null : l.replace(/\\(.)/g, "$1"), a = s((i.match(/\.((?:\\.|[\w-])+)/) || [])[1]);
    if (a)
      return "c" + a;
    let c = s((i.match(/#((?:\\.|[\w-])+)/) || [])[1]);
    if (c)
      return "i" + c;
    let f = (i.match(/^([a-zA-Z][\w-]*)/) || [])[1];
    return f ? "t" + f.toLowerCase() : null;
  }
  function ti(t, e) {
    if (!e.length)
      return "";
    if (e.some((r) => r.includes("&")))
      return null;
    let n = e.join(",");
    try {
      return t.matches(n), n;
    } catch {
      return null;
    }
  }
  function nc(t, e) {
    let n = t.createElement("div"), r = {};
    for (let i in e) {
      let o = e[i];
      (i === "before" || i === "after") && o.push("q"), r[i] = ti(n, o);
    }
    return r;
  }
  function ei(t) {
    let e = { universe: null, pseudoUniverse: null, usesHas: true, shareGate: null, marginUnstable: true, paddingUnstable: true, importantProps: null, pseudoGates: { before: null, after: null, firstLetter: null, marker: null, firstLine: null } };
    try {
      let n = new Set(vr), r = { before: [], after: [], firstLetter: [], marker: [], firstLine: [] }, i = { budget: 20000, usesHas: false, shareUnsafeSels: new Set, inContainer: 0, marginUnstable: false, paddingUnstable: false, importantProps: new Set, pseudoProps: new Set };
      for (let f of t.styleSheets)
        if (!xr(f, n, r, i))
          return e;
      let o = t.adoptedStyleSheets;
      if (Array.isArray(o)) {
        for (let f of o)
          if (!xr(f, n, r, i))
            return e;
      }
      if (typeof t.getAnimations == "function")
        for (let f of t.getAnimations()) {
          let l = f.effect?.getKeyframes?.() || [];
          for (let u of l)
            for (let p of Object.keys(u))
              p === "offset" || p === "easing" || p === "composite" || p === "computedOffset" || n.add(p.replace(/[A-Z]/g, (h) => "-" + h.toLowerCase()));
        }
      let s = Array.from(i.shareUnsafeSels), a = ti(t.createElement("div"), s) === null ? null : s.map((f) => ({ sel: f, key: ec(f) })), c = new Set(Ya);
      for (let f of Xa)
        n.has(f) && c.add(f);
      for (let f of i.pseudoProps)
        c.add(f);
      return { universe: n, pseudoUniverse: c, pseudoGates: nc(t, r), usesHas: i.usesHas, shareGate: a, marginUnstable: i.marginUnstable, paddingUnstable: i.paddingUnstable, importantProps: i.importantProps };
    } catch {
      return e;
    }
  }
  var vr;
  var Xa;
  var Ya;
  var Ka;
  var Qa;
  var Qo;
  var Ja;
  var Jo;
  var kr = ct(() => {
    vr = ["display", "position", "top", "right", "bottom", "left", "float", "clear", "z-index", "box-sizing", "width", "height", "min-width", "min-height", "max-width", "max-height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "overflow-x", "overflow-y", "visibility", "opacity", "content-visibility", "vertical-align", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "order", "align-items", "align-self", "align-content", "justify-content", "justify-items", "justify-self", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-auto-flow", "grid-auto-columns", "grid-auto-rows", "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end", "color", "font-family", "font-size", "font-weight", "font-style", "font-stretch", "line-height", "letter-spacing", "word-spacing", "white-space", "text-align", "text-transform", "text-indent", "text-overflow", "text-shadow", "direction", "unicode-bidi", "writing-mode", "text-orientation", "word-break", "overflow-wrap", "tab-size", "list-style-type", "list-style-position", "list-style-image", "counter-reset", "counter-increment", "counter-set", "background-color", "background-image", "background-size", "background-position", "background-repeat", "background-clip", "background-origin", "background-attachment", "box-shadow", "outline-width", "outline-style", "outline-color", "outline-offset", "transform", "transform-origin", "rotate", "scale", "translate", "filter", "mix-blend-mode", "clip-path", "object-fit", "object-position", "border-collapse", "border-spacing", "table-layout", "caption-side", "empty-cells"], Xa = ["color", "font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant", "font-kerning", "font-feature-settings", "font-variation-settings", "line-height", "letter-spacing", "word-spacing", "white-space", "text-align", "text-align-last", "text-indent", "text-transform", "text-shadow", "text-rendering", "direction", "unicode-bidi", "word-break", "overflow-wrap", "writing-mode", "text-orientation", "hyphens", "tab-size", "visibility", "list-style-type", "list-style-position", "list-style-image", "border-collapse", "border-spacing", "caption-side", "empty-cells", "quotes", "color-scheme", "-webkit-text-fill-color", "-webkit-font-smoothing", "image-rendering"], Ya = ["display", "width", "height", "min-width", "min-height"], Ka = /::?(?:before|after|first-letter|first-line|marker)/, Qa = /%|\bauto\b|calc\(|var\(/i, Qo = { before: /::?before\b/, after: /::?after\b/, firstLetter: /::?first-letter\b/, marker: /::marker\b/, firstLine: /::?first-line\b/ }, Ja = /::?(?:before|after|first-letter|first-line|marker)\b/g;
    Jo = /:(nth-|first-child|last-child|only-|first-of-type|last-of-type|empty|hover|focus|active|target|checked|indeterminate|disabled|enabled|read-only|read-write|placeholder-shown|autofill|valid|invalid|user-valid|user-invalid|in-range|out-of-range|required|optional|default|link|any-link|scope|defined|modal|fullscreen|picture-in-picture|playing|paused|dir\(|lang\(|has\()/;
  });
  function J(t) {
    return ni.add(t), t.setAttribute("data-snapdom-internal", ""), t;
  }
  function Ut(t) {
    return ni.has(t);
  }
  var ni;
  var wt = ct(() => {
    ni = new WeakSet;
  });
  function Ar(t) {
    if (t = String(t).toLowerCase(), qe.has(t)) {
      let o = {};
      return P.defaultStyle.set(t, o), o;
    }
    if (P.defaultStyle.has(t))
      return P.defaultStyle.get(t);
    let e = [...document.querySelectorAll("#snapdom-sandbox")].find(Ut);
    e || (e = document.createElement("div"), J(e), e.id = "snapdom-sandbox", e.setAttribute("data-snapdom-sandbox", "true"), e.setAttribute("aria-hidden", "true"), e.style.position = "absolute", e.style.left = "-9999px", e.style.top = "-9999px", e.style.width = "0px", e.style.height = "0px", e.style.overflow = "hidden", document.body.appendChild(e));
    let n = document.createElement(t);
    n.style.all = "initial", e.appendChild(n);
    let r = getComputedStyle(n), i = {};
    for (let o of r) {
      if (he(o))
        continue;
      let s = r.getPropertyValue(o);
      i[o] = s;
    }
    for (let o of vr)
      !(o in i) && !he(o) && (i[o] = r.getPropertyValue(o));
    return e.removeChild(n), P.defaultStyle.set(t, i), i;
  }
  function he(t) {
    let e = ri.get(t);
    if (e === undefined) {
      let n = String(t).toLowerCase();
      e = ic.has(n) || oc.test(n) || rc.test(n), ri.set(t, e);
    }
    return e;
  }
  function ii(t, e) {
    let n = fc.get(t);
    if (n === undefined || e[n] !== e[t])
      return false;
    let r = e["writing-mode"];
    if (r && r !== "horizontal-tb")
      return false;
    let i = e.direction;
    return !(i && i !== "ltr");
  }
  function hn(t, e) {
    return !ac.has(t) && (e === "inline" || sc.has(t) || oi.has(t));
  }
  function Mr(t, e, n) {
    let r = (e.display || "").toLowerCase();
    if (r === "inline" || oi.has(t))
      return false;
    if (n)
      return true;
    if ((e.float || "none").toLowerCase() !== "none")
      return false;
    let o = (e.position || "static").toLowerCase();
    return o === "absolute" || o === "fixed" ? false : !dc.has(r);
  }
  function me(t, e, n = true, r = false) {
    if (e = String(e || "").toLowerCase(), qe.has(e))
      return "";
    let i = [], o = Ar(e), s = (t.display || "").toLowerCase(), a = s === "inline", c = hn(e, s), f = t["text-wrap-mode"] || t["white-space"] || "", l = f === "nowrap" || f === "pre", p = c && n && !(c && n && !a && l), h = false;
    for (let d in t) {
      if (he(d) || ii(d, t))
        continue;
      let m = t[d];
      if (p) {
        if (cc.has(d))
          continue;
        if (lc.has(d)) {
          m && m !== o[d] && (i.push(`${d}:${m}`), m !== "auto" && (h = true));
          continue;
        }
      }
      if (m && m !== o[d]) {
        if (!l && (d === "width" || d === "inline-size") && m.endsWith("px") && m.includes(".")) {
          let g = parseFloat(m);
          if (Number.isFinite(g)) {
            i.push(`${d}:${(g + uc).toFixed(3)}px`);
            continue;
          }
        }
        i.push(`${d}:${m}`);
      }
    }
    if (p && !a && !r && !h) {
      let d = t.width;
      d && d !== "auto" && d !== o.width && i.push(`min-width:${d}`);
    }
    return i.sort(), i.join(";");
  }
  function Er(t) {
    let e = new Set;
    return t.nodeType !== Node.ELEMENT_NODE && t.nodeType !== Node.DOCUMENT_FRAGMENT_NODE ? [] : (t.tagName && e.add(t.tagName.toLowerCase()), typeof t.querySelectorAll == "function" && t.querySelectorAll("*").forEach((n) => e.add(n.tagName.toLowerCase())), Array.from(e));
  }
  function _r(t, e = null) {
    let n = new Map;
    for (let s of t) {
      let a = Ar(s);
      if (!a)
        continue;
      let l = (e ? Object.entries(a).filter(([p]) => e.has(p)) : Object.entries(a)).filter(([p]) => !ii(p, a)).map(([p, h]) => `${p}:${h};`).sort(), u = l.join("");
      u && (n.has(u) || n.set(u, { tagList: [], declarations: l }), n.get(u).tagList.push(s));
    }
    let r = [...n.values()], i = null;
    for (let { declarations: s } of r) {
      let a = new Set(s);
      if (!i) {
        i = a;
        continue;
      }
      for (let c of i)
        a.has(c) || i.delete(c);
    }
    i ??= new Set;
    let o = "";
    if (i.size && r.length > 1) {
      let s = r.flatMap((a) => a.tagList);
      o += `${s.join(",")} { ${[...i].join("")} }
`;
    }
    for (let { tagList: s, declarations: a } of r) {
      let c = r.length > 1 ? a.filter((l) => !i.has(l)) : a;
      if (!c.length)
        continue;
      let f = c.join("");
      o += `${s.join(",")} { ${f} }
`;
    }
    return o;
  }
  function Ge(t) {
    let e = Array.from(new Set(t.values())).filter(Boolean).sort(), n = new Map, r = 1;
    for (let i of e)
      n.set(i, `c${r++}`);
    return n;
  }
  function pc(t) {
    try {
      let e = t?.ownerDocument;
      if (!e)
        return typeof window < "u" ? window : null;
      let n = e.defaultView;
      if (n && typeof n.getComputedStyle == "function")
        return n;
      if (typeof window < "u" && window.frames)
        for (let r = 0;r < window.frames.length; r++)
          try {
            if (window.frames[r]?.document === e)
              return window.frames[r];
          } catch {}
    } catch {}
    return typeof window < "u" ? window : null;
  }
  function W(t, e = null) {
    let n = () => {
      let o = { length: 0, getPropertyValue: () => "", item: () => "" };
      return o[Symbol.iterator] = function* () {}, o;
    };
    if (t?.nodeType !== 1) {
      let o = typeof window < "u" ? window : null;
      if (o && typeof o.getComputedStyle == "function")
        try {
          return o.getComputedStyle(t, e) || n();
        } catch {
          return n();
        }
      return n();
    }
    let r = P.computedStyle.get(t);
    r || (r = new Map, P.computedStyle.set(t, r));
    let i = r.get(e);
    if (!i) {
      let o = pc(t), s = null;
      try {
        s = o && typeof o.getComputedStyle == "function" ? o.getComputedStyle(t, e) : null;
      } catch {}
      if (!s && typeof window < "u" && typeof window.getComputedStyle == "function")
        try {
          t.ownerDocument === document && (s = window.getComputedStyle(t, e));
        } catch {}
      i = s || n(), r.set(e, i);
    }
    return i;
  }
  function ge(t, e = null) {
    let n = {};
    for (let r of e || t) {
      let i = t.getPropertyValue(r);
      i && (n[r] = i);
    }
    for (let r of hc) {
      let i = n[`border-${r}-style`], o = n[`border-${r}-width`];
      (i === "none" || i === "hidden" || o === "0px") && (delete n[`border-${r}-style`], delete n[`border-${r}-width`], delete n[`border-${r}-color`]);
    }
    return n;
  }
  function Ht(t) {
    let e = [], n = 0, r = 0;
    for (let i = 0;i < t.length; i++) {
      let o = t[i];
      o === "(" && n++, o === ")" && n--, o === "," && n === 0 && (e.push(t.slice(r, i).trim()), r = i + 1);
    }
    return e.push(t.slice(r).trim()), e;
  }
  var Cr;
  var qe;
  var rc;
  var oc;
  var ic;
  var ri;
  var sc;
  var oi;
  var ac;
  var cc;
  var lc;
  var fc;
  var uc;
  var dc;
  var hc;
  var ye = ct(() => {
    dt();
    kr();
    wt();
    Cr = new Set(["meta", "script", "noscript", "title", "link", "template"]), qe = new Set(["meta", "link", "style", "title", "noscript", "script", "template", "g", "defs", "use", "marker", "mask", "clipPath", "pattern", "symbol", "path", "polygon", "polyline", "line", "circle", "ellipse", "rect", "filter", "lineargradient", "radialgradient", "stop"]);
    rc = /(?:^|-)(animation|transition)(?:-|$)/i, oc = /^(--.+|view-timeline|scroll-timeline|animation-trigger|offset-|position-try|app-region|interactivity|overlay|view-transition|-webkit-locale|-webkit-user-(?:drag|modify)|-webkit-tap-highlight-color|-webkit-text-security)$/i, ic = new Set(["cursor", "pointer-events", "touch-action", "user-select", "print-color-adjust", "speak", "reading-flow", "reading-order", "anchor-name", "anchor-scope", "container-name", "container-type", "timeline-scope", "zoom", "stroke-color"]), ri = new Map;
    sc = new Set(["span", "small", "em", "strong", "b", "i", "u", "s", "code", "cite", "mark", "sub", "sup"]), oi = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th"]), ac = new Set(["img", "video", "canvas", "svg", "iframe", "embed", "object", "input", "textarea", "select"]), cc = new Set(["width", "max-width", "inline-size", "max-inline-size"]), lc = new Set(["min-width", "min-inline-size"]), fc = new Map(Object.entries({ "block-size": "height", "inline-size": "width", "min-block-size": "min-height", "min-inline-size": "min-width", "max-block-size": "max-height", "max-inline-size": "max-width", "margin-block-start": "margin-top", "margin-block-end": "margin-bottom", "margin-inline-start": "margin-left", "margin-inline-end": "margin-right", "padding-block-start": "padding-top", "padding-block-end": "padding-bottom", "padding-inline-start": "padding-left", "padding-inline-end": "padding-right", "inset-block-start": "top", "inset-block-end": "bottom", "inset-inline-start": "left", "inset-inline-end": "right", "border-block-start-width": "border-top-width", "border-block-start-style": "border-top-style", "border-block-start-color": "border-top-color", "border-block-end-width": "border-bottom-width", "border-block-end-style": "border-bottom-style", "border-block-end-color": "border-bottom-color", "border-inline-start-width": "border-left-width", "border-inline-start-style": "border-left-style", "border-inline-start-color": "border-left-color", "border-inline-end-width": "border-right-width", "border-inline-end-style": "border-right-style", "border-inline-end-color": "border-right-color", "border-start-start-radius": "border-top-left-radius", "border-start-end-radius": "border-top-right-radius", "border-end-start-radius": "border-bottom-left-radius", "border-end-end-radius": "border-bottom-right-radius", "overflow-block": "overflow-y", "overflow-inline": "overflow-x", "overscroll-behavior-block": "overscroll-behavior-y", "overscroll-behavior-inline": "overscroll-behavior-x", "contain-intrinsic-block-size": "contain-intrinsic-height", "contain-intrinsic-inline-size": "contain-intrinsic-width" }));
    uc = 0.001;
    dc = new Set(["inline-block", "inline-flex", "inline-grid", "inline-table", "inline-flow-root", "table"]);
    hc = ["top", "right", "bottom", "left"];
  });
  function pt(t = 1000) {
    return typeof requestAnimationFrame != "function" || typeof document < "u" && document.visibilityState === "hidden" ? Promise.resolve() : new Promise((e) => {
      let n = false, r = () => {
        n || (n = true, e());
      };
      try {
        requestAnimationFrame(r);
      } catch {
        r();
        return;
      }
      setTimeout(r, t);
    });
  }
  function Xe() {
    if (typeof navigator > "u")
      return false;
    if (navigator.userAgentData)
      return navigator.userAgentData.platform === "iOS";
    let t = navigator.userAgent || "", e = /iPhone|iPad|iPod/.test(t), n = navigator.maxTouchPoints > 2 && /Macintosh/.test(t);
    return e || n;
  }
  function Y() {
    if (typeof navigator > "u")
      return false;
    let t = navigator.userAgent || "", e = t.toLowerCase(), n = e.includes("safari") && !e.includes("chrome") && !e.includes("crios") && !e.includes("fxios") && !e.includes("android"), r = /applewebkit/i.test(t), i = /mobile/i.test(t), o = !/safari/i.test(t), s = r && i && o, a = /(micromessenger|wxwork|wecom|windowswechat|macwechat)/i.test(t), c = /(baiduboxapp|baidubrowser|baidusearch|baiduboxlite)/i.test(e), f = /ipad|iphone|ipod/.test(e) && r;
    return n || s || a || c || f;
  }
  function zt() {
    return typeof navigator > "u" ? false : (navigator.userAgent || "").toLowerCase().includes("firefox");
  }
  var kt = ct(() => {});
  function D(t, e, n) {
    let r = t && typeof t == "object" && (t.options || t);
    r && r.debug && (n !== undefined ? console.warn("[snapdom]", e, n) : console.warn("[snapdom]", e));
  }
  function St(t, e, n, r) {
    let i = t && t.warnings;
    i && i.length < mc && i.push(r === undefined ? { code: e, message: n } : { code: e, message: n, detail: r });
  }
  var mc;
  var Qt = ct(() => {
    mc = 50;
  });
  var ht = ct(() => {
    Ko();
    ye();
    kt();
    bt();
    Qt();
  });
  var Fa = {};
  ze(Fa, { decodeSvgFromDataURL: () => ln, encodeSvgToDataURL: () => fn, fixSafariShadows: () => lr, toCanvas: () => le });
  function Lu(t, e) {
    try {
      let n = t.match(/<svg\b[^>]*>/i);
      if (!n)
        return t;
      let r = n[0], i = parseFloat((r.match(/\bwidth="([\d.]+)/i) || [])[1]), o = parseFloat((r.match(/\bheight="([\d.]+)/i) || [])[1]);
      if (!Number.isFinite(i) || !Number.isFinite(o) || i <= 0 || o <= 0)
        return t;
      let s = Math.min(1, Gt / i, Gt / o, Math.sqrt(Lo / (i * o)));
      if (s >= 1)
        return t;
      let a = Math.max(1, Math.floor(i * s)), c = Math.max(1, Math.floor(o * s));
      return St(e, "raster-clamp", `capture ${Math.round(i)}x${Math.round(o)}px exceeds decode limits; downscaled to ${a}x${c}px`), console.warn(`[snapDOM] Capture ${Math.round(i)}×${Math.round(o)}px exceeds the browser image-decode limit (${Gt}px/side); downscaling to ${a}×${c}px. Lower \`scale\` or set \`width\`/\`height\` to control output size.`), t.replace(r, r.replace(/(\bwidth=")[\d.]+/i, `$1${a}`).replace(/(\bheight=")[\d.]+/i, `$1${c}`));
    } catch {
      return t;
    }
  }
  function Iu(t, e) {
    let n = ["x", "y", "width", "height"].map((S) => Number(e?.[S]));
    if (!n.every(Number.isFinite) || n[2] <= 0 || n[3] <= 0)
      throw new RangeError("[snapdom] canvas crop requires finite x/y and positive width/height");
    let r = t.match(/<svg\b[^>]*>/i);
    if (!r)
      throw new Error("[snapdom] cannot crop a non-SVG capture");
    let i = r[0], o = (i.match(/\bviewBox="([^"]+)"/i) || [])[1], s = String(o || "").trim().split(/[\s,]+/).map(Number);
    if (s.length !== 4 || !s.every(Number.isFinite) || s[2] <= 0 || s[3] <= 0)
      throw new Error("[snapdom] cannot crop an SVG without a finite viewBox");
    let [a, c, f, l] = s, u = Math.max(a, n[0]), p = Math.max(c, n[1]), h = Math.min(a + f, n[0] + n[2]), d = Math.min(c + l, n[1] + n[3]);
    if (!(h > u) || !(d > p))
      throw new RangeError("[snapdom] canvas crop does not intersect the SVG viewBox");
    let m = parseFloat((i.match(/\bwidth="([\d.]+)/i) || [])[1]), g = parseFloat((i.match(/\bheight="([\d.]+)/i) || [])[1]), y = Number.isFinite(m) && m > 0 ? m / f : 1, b = Number.isFinite(g) && g > 0 ? g / l : 1, w = Math.max(1, (h - u) * y), C = Math.max(1, (d - p) * b), x = i.replace(/(\bwidth=")[^"]*/i, `$1${w}`).replace(/(\bheight=")[^"]*/i, `$1${C}`).replace(/(\bviewBox=")[^"]*/i, `$1${u} ${p} ${h - u} ${d - p}`);
    return t.replace(i, x);
  }
  function Ca(t) {
    return typeof t == "string" && /^data:image\/svg\+xml/i.test(t);
  }
  function ln(t) {
    let e = t.indexOf(",");
    return e >= 0 ? decodeURIComponent(t.slice(e + 1)) : "";
  }
  function Wu(t) {
    let e = t.indexOf(",");
    if (e < 0)
      return "";
    let n = t.slice(e + 1, e + 1201).replace(/%[0-9A-Fa-f]?$/, "");
    try {
      return decodeURIComponent(n);
    } catch {
      return "";
    }
  }
  function fn(t) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(t)}`;
  }
  function _a(t) {
    let e = [], n = "", r = 0;
    for (let i = 0;i < t.length; i++) {
      let o = t[i];
      o === "(" && r++, o === ")" && (r = Math.max(0, r - 1)), o === ";" && r === 0 ? (e.push(n), n = "") : n += o;
    }
    return n.trim() && e.push(n), e.map((i) => i.trim()).filter(Boolean);
  }
  function Ou(t) {
    let e = [], n = "", r = 0;
    for (let o = 0;o < t.length; o++) {
      let s = t[o];
      s === "(" && r++, s === ")" && (r = Math.max(0, r - 1)), s === "," && r === 0 ? (e.push(n.trim()), n = "") : n += s;
    }
    n.trim() && e.push(n.trim());
    let i = [];
    for (let o of e) {
      if (/\binset\b/i.test(o))
        continue;
      let s = o.match(/-?\d+(?:\.\d+)?px/gi) || [], [a = "0px", c = "0px", f = "0px"] = s;
      f = `${parseFloat(f) / 2}px`;
      let l = o.replace(/-?\d+(?:\.\d+)?px/gi, "").replace(/\binset\b/ig, "").trim().replace(/\s{2,}/g, " "), u = !!l && l !== ",";
      i.push(`drop-shadow(${a} ${c} ${f}${u ? ` ${l}` : ""})`);
    }
    return i.join(" ");
  }
  function Ra(t) {
    let e = _a(t), n = null, r = null, i = null, o = [];
    for (let a of e) {
      let c = a.indexOf(":");
      if (c < 0)
        continue;
      let f = a.slice(0, c).trim().toLowerCase(), l = a.slice(c + 1).trim();
      f === "box-shadow" ? i = l : f === "filter" ? n = l : f === "-webkit-filter" ? r = l : o.push([f, l]);
    }
    if (i) {
      let a = Ou(i);
      a && (n = n ? `${n} ${a}` : a, r = r ? `${r} ${a}` : a);
    }
    let s = [...o];
    return n && s.push(["filter", n]), r && s.push(["-webkit-filter", r]), s.map(([a, c]) => `${a}:${c}`).join(";");
  }
  function Du(t) {
    return t.replace(/([^{}]+)\{([^}]*)\}/g, (e, n, r) => `${n}{${Ra(r)}}`);
  }
  function Bu(t) {
    return t = t.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (e, n) => e.replace(n, Du(n))), t = t.replace(/style=(['"])([\s\S]*?)\1/gi, (e, n, r) => `style=${n}${Ra(r)}${n}`), t;
  }
  function Uu() {
    return sr || (sr = (async () => {
      try {
        let t = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="20"><foreignObject width="8" height="20"><div xmlns="http://www.w3.org/1999/xhtml" style="width:4px;height:4px;margin-top:8px;background:#000;box-shadow:0 8px 0 0 #000"></div></foreignObject></svg>', e = new Image;
        e.decoding = "sync", e.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(t)}`, await e.decode();
        let n = document.createElement("canvas");
        n.width = 8, n.height = 20;
        let r = n.getContext("2d", { willReadFrequently: true });
        r.drawImage(e, 0, 0);
        let i = r.getImageData(2, 18, 1, 1).data[3] > 128, o = r.getImageData(2, 2, 1, 1).data[3] > 128;
        return { native: i || o, flippedY: o && !i };
      } catch {
        return { native: false, flippedY: false };
      }
    })(), sr);
  }
  function Hu(t) {
    let e = [], n = 0, r = 0;
    for (let i = 0;i < t.length; i++) {
      let o = t[i];
      o === "(" ? n++ : o === ")" ? n = Math.max(0, n - 1) : o === "," && n === 0 && (e.push(t.slice(r, i)), r = i + 1);
    }
    return e.push(t.slice(r)), e.map((i) => {
      let o = 0, s = 0, a = "", c = 0;
      for (;c < i.length; ) {
        let f = i[c];
        if (f === "(" ? o++ : f === ")" && (o = Math.max(0, o - 1)), o === 0 && (c === 0 || i[c - 1] === " ")) {
          let l = /^-?\d*\.?\d+px/.exec(i.slice(c));
          if (l) {
            s++, a += s === 2 ? `${-parseFloat(l[0])}px` : l[0], c += l[0].length;
            continue;
          }
        }
        a += f, c++;
      }
      return a;
    }).join(",");
  }
  function zu(t, e) {
    let n = (r) => _a(r).map((i) => {
      let o = i.indexOf(":");
      if (o < 0)
        return i;
      let s = i.slice(0, o).trim().toLowerCase();
      return s === "text-shadow" || e && s === "box-shadow" ? `${s}:${Hu(i.slice(o + 1))}` : i;
    }).join(";");
    return t = t.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (r, i) => r.replace(i, i.replace(/([^{}]+)\{([^}]*)\}/g, (o, s, a) => `${s}{${n(a)}}`))), t = t.replace(/style=(['"])([\s\S]*?)\1/gi, (r, i, o) => `style=${i}${n(o)}${i}`), t;
  }
  async function lr(t) {
    if (!/(?:box-shadow|text-shadow)\s*:[^;"}]*px/i.test(t))
      return { svg: t, naturalOnly: false };
    let { native: n, flippedY: r } = await Uu();
    try {
      let i = t;
      return n || (i = Bu(i)), r && (i = zu(i, n)), { svg: i, naturalOnly: true };
    } catch {
      return { svg: t, naturalOnly: true };
    }
  }
  function ju() {
    let t = document.createElement("canvas");
    t.width = 16, t.height = 16;
    let e = t.getContext("2d", { willReadFrequently: true });
    return e ? (n) => {
      e.clearRect(0, 0, 16, 16), e.drawImage(n, 0, 0, 16, 16);
      let r = e.getImageData(0, 0, 16, 16).data;
      for (let i = 3;i < r.length; i += 4)
        if (r[i] > 0)
          return true;
      return false;
    } : null;
  }
  async function Vu(t, e, n) {
    J(t), t.style.cssText = "position:fixed;left:-99999px;top:-99999px;pointer-events:none", document.body.appendChild(t);
    try {
      if (!n)
        return await ar(), await ar(), false;
      let r = performance.now() + (e ? 600 : 150);
      for (;; ) {
        let i;
        try {
          i = n(t);
        } catch {
          return false;
        }
        if (i)
          return true;
        if (performance.now() > r)
          return false;
        await ar();
      }
    } finally {
      try {
        t.remove();
      } catch {}
    }
  }
  function Aa(t) {
    if (typeof document > "u" || !document.body)
      return new Image;
    if (Tt && !Tt.contentDocument) {
      try {
        Tt.remove();
      } catch {}
      Tt = null;
    }
    if (Tt && Po > qu && cr === 0) {
      try {
        Tt.remove();
      } catch {}
      Tt = null;
    }
    if (!Tt) {
      let n = document.createElement("iframe");
      J(n), n.setAttribute("aria-hidden", "true"), n.style.cssText = "position:absolute;left:-9999px;top:0;width:0;height:0;border:0;visibility:hidden;pointer-events:none";
      try {
        document.body.appendChild(n);
      } catch {}
      if (n.contentDocument)
        Tt = n, Po = 0;
      else {
        try {
          n.remove();
        } catch {}
        return new Image;
      }
    }
    Po += t.length, cr += 1;
    let e = Tt.contentDocument.createElement("img");
    return e.__snapdomDecodeFrame = true, e;
  }
  function No(t) {
    !t || !t.__snapdomDecodeFrame || (t.__snapdomDecodeFrame = false, cr = Math.max(0, cr - 1));
  }
  function Ma(t, e) {
    return t.loading = "eager", t.decoding = "sync", t.crossOrigin = "anonymous", t.src = e, t.decode();
  }
  function Qu(t) {
    if (typeof t != "string")
      return false;
    let e = t.indexOf(",") + 1, n = Math.max(48, Math.floor((t.length - e) / 200)), r = 0, i = 0;
    for (let o = e;o + 48 <= t.length; o += n) {
      let s = t.slice(o, o + 48);
      r++, Ku.some((a) => s.includes(a)) || i++;
    }
    return i * 2 > r;
  }
  function Ea(t, e, n, r, i) {
    if (!e.naturalWidth) {
      t.drawImage(e, 0, 0, n, r);
      return;
    }
    let o = n * r, s = o > Gu && !Qu(i) ? Math.min(Yu, Math.ceil(o / Xu)) : 1;
    if (s === 1) {
      t.drawImage(e, 0, 0, n, r);
      return;
    }
    let a = e.naturalWidth, c = e.naturalHeight / r;
    for (let f = 0;f < s; f++) {
      let l = Math.round(f * r / s), u = f === s - 1 ? r : Math.round((f + 1) * r / s);
      t.drawImage(e, 0, l * c, a, (u - l) * c, 0, l, n, u - l);
    }
  }
  async function le(t, e) {
    let { width: n, height: r, scale: i = 1, dpr: o = 1, meta: s = {}, backgroundColor: a, crop: c = null } = e, f = typeof HTMLCanvasElement < "u" && t instanceof HTMLCanvasElement ? t : null, l = t, u = false, p = false;
    if (c && !Ca(t))
      throw new RangeError("[snapdom] canvas crop requires an SVG capture payload");
    if (Ca(t)) {
      let d = (Wu(t).match(/<svg\b[^>]*>/i) || [])[0] || "", m = parseFloat((d.match(/\bwidth="([\d.]+)/i) || [])[1]), g = parseFloat((d.match(/\bheight="([\d.]+)/i) || [])[1]), y = Number.isFinite(m) && Number.isFinite(g) && m > 0 && g > 0 && Math.min(1, Gt / m, Gt / g, Math.sqrt(Lo / (m * g))) < 1;
      if (c || y || Y())
        try {
          let b = ln(t);
          if (c && (b = Iu(b, c)), Y()) {
            let w = await lr(b);
            b = w.svg, u = w.naturalOnly, p = /@font-face|data:image\//i.test(b);
          }
          (y || c) && (b = Lu(b, e.__session)), l = fn(b);
        } catch (b) {
          if (c)
            throw b;
          l = t;
        }
    }
    let h = f || Aa(l);
    try {
      f || await Ma(h, l);
    } catch (d) {
      if (!h.__snapdomDecodeFrame)
        throw d;
      No(h), h = Aa(l);
      try {
        await Ma(h, l);
      } catch (m) {
        throw No(h), m;
      }
    }
    try {
      let d = Y() && !f ? ju() : null, m = false;
      d && (m = await Vu(h, p, d));
      let g = f ? f.width : h.naturalWidth, y = f ? f.height : h.naturalHeight, b = c ? g : Number.isFinite(s.vbW) ? s.vbW : Number.isFinite(s.w0) ? s.w0 : g, w = c ? y : Number.isFinite(s.vbH) ? s.vbH : Number.isFinite(s.h0) ? s.h0 : y, C, x, S = Number.isFinite(n), A = Number.isFinite(r);
      if (S && A)
        C = Math.max(1, n), x = Math.max(1, r);
      else if (S) {
        let N = n / Math.max(1, b);
        C = n, x = w * N;
      } else if (A) {
        let N = r / Math.max(1, w);
        x = r, C = b * N;
      } else {
        let N = f && Number.isFinite(s.vbW) && Number.isFinite(s.vbH);
        C = N ? s.vbW : g, x = N ? s.vbH : y;
      }
      !S && !A && (C = C * i, x = x * i);
      let v = C * o, M = x * o, k = Math.max(v / Gt, M / Gt, Math.sqrt(v * M / Lo));
      k > 1 && (St(e.__session, "canvas-clamp", `output ${Math.round(v)}x${Math.round(M)}px exceeds canvas limits; downscaled`), console.warn(`[snapDOM] Output ${Math.round(v)}×${Math.round(M)}px exceeds the browser canvas limit (${Gt}px/side); downscaling. Lower \`scale\`/\`dpr\` or set \`width\`/\`height\`.`), C /= k, x /= k);
      let R = vt(e.canvas) && rt(e.canvas, "canvas") ? e.canvas : document.createElement("canvas");
      R.width = Math.max(1, C * o), R.height = Math.max(1, x * o), R.style.width = `${C}px`, R.style.height = `${x}px`;
      let E = R.getContext("2d");
      if (!E)
        throw new Error("[snapdom] toCanvas: the target canvas has no 2d context");
      let T = () => {
        if (o !== 1 && E.scale(o, o), a && (E.save(), E.fillStyle = a, E.fillRect(0, 0, C, x), E.restore()), u && (Math.round(C * o) !== g || Math.round(x * o) !== y)) {
          let N = document.createElement("canvas");
          N.width = g, N.height = y, Ea(N.getContext("2d"), h, g, y, l), E.drawImage(N, 0, 0, C, x);
        } else
          E.save(), E.setTransform(1, 0, 0, 1, 0, 0), Ea(E, h, C * o, x * o, l), E.restore();
      };
      if (T(), d && m && p) {
        let N = true;
        try {
          N = d(h);
        } catch {}
        if (!N) {
          let O = performance.now() + 600;
          do {
            await ar();
            try {
              N = d(h);
            } catch {
              break;
            }
          } while (!N && performance.now() < O);
          R.width = R.width, T();
        }
      }
      return R;
    } finally {
      No(h);
    }
  }
  var Gt;
  var Lo;
  var sr;
  var ar;
  var qu;
  var Tt;
  var Po;
  var cr;
  var Gu;
  var Xu;
  var Yu;
  var Ku;
  var Oe = ct(() => {
    kt();
    Qt();
    bt();
    wt();
    Gt = Y() ? 16384 : 32767, Lo = 16384 * 16384;
    sr = null;
    ar = () => new Promise((t) => {
      requestAnimationFrame(t), setTimeout(t, 50);
    });
    qu = 24 * 1024 * 1024, Tt = null, Po = 0, cr = 0;
    Gu = 4000000, Xu = 2000000, Yu = 8, Ku = ["%3C", "%3E", "%20", "%7B", "%7D", "%3B"];
  });
  var un = {};
  ze(un, { rasterize: () => Io });
  async function Io(t, e) {
    let n = await le(t, e), o = n.width * n.height <= 2000000 ? n.toDataURL(`image/${e.format}`, e.quality) : await new Promise((a) => {
      let c = () => a(n.toDataURL(`image/${e.format}`, e.quality));
      try {
        n.toBlob((f) => {
          if (!f)
            return c();
          let l = new FileReader;
          l.onload = () => a(String(l.result || "")), l.onerror = c, l.readAsDataURL(f);
        }, `image/${e.format}`, e.quality);
      } catch {
        c();
      }
    }), s = new Image;
    return s.src = o, Y() ? await s.decode() : await new Promise((a, c) => {
      if (s.complete && s.naturalWidth)
        return a();
      s.onload = a, s.onerror = c;
    }), s.style.width = `${n.width / e.dpr}px`, s.style.height = `${n.height / e.dpr}px`, s;
  }
  var De = ct(() => {
    Oe();
    kt();
  });
  var Wo = {};
  ze(Wo, { toImg: () => Ju, toSvg: () => Ju });
  async function Ju(t, e) {
    let { scale: n = 1, width: r, height: i, meta: o = {} } = e, s = Number.isFinite(r), a = Number.isFinite(i), c = Number.isFinite(n) && n !== 1 || s || a;
    if (Y() && c)
      try {
        let { svg: p } = await lr(ln(t)), h = (p.match(/<svg\b[^>]*>/i) || [])[0] || "", d = parseFloat((h.match(/\bwidth="([\d.]+)/i) || [])[1]), m = parseFloat((h.match(/\bheight="([\d.]+)/i) || [])[1]);
        if (!Number.isFinite(d) || !Number.isFinite(m))
          throw new Error("svg without dimensions");
        let g = Number.isFinite(o.vbW) ? o.vbW : Number.isFinite(o.w0) ? o.w0 : d, y = Number.isFinite(o.vbH) ? o.vbH : Number.isFinite(o.h0) ? o.h0 : m, b, w;
        s && a ? (b = r, w = i) : s ? (b = r, w = Math.max(1, Math.round(y * (r / Math.max(1, g))))) : a ? (w = i, b = Math.max(1, Math.round(g * (i / Math.max(1, y))))) : (b = Math.max(1, Math.round(d * n)), w = Math.max(1, Math.round(m * n)));
        let C = p.replace(/width="[^"]*"/, `width="${b}"`).replace(/height="[^"]*"/, `height="${w}"`), x = new Image;
        return x.decoding = "sync", x.loading = "eager", x.src = fn(C), await x.decode(), x.style.width = `${b}px`, x.style.height = `${w}px`, x;
      } catch (p) {
        return St(e.__session, "safari-png-fallback", "safari vector toImg failed, falling back to PNG raster", p), D(e, "safari vector toImg failed, falling back to PNG", p), Io(t, { ...e, format: "png", quality: 1, meta: o });
      }
    let f = t, l = false;
    if (!s && !a && n !== 1 && typeof t == "string" && t.startsWith("data:image/svg+xml"))
      try {
        let p = ln(t), h = (p.match(/<svg\b[^>]*>/i) || [])[0] || "", d = Number((h.match(/\bwidth="([\d.]+)"/i) || [])[1]), m = Number((h.match(/\bheight="([\d.]+)"/i) || [])[1]);
        if (d > 0 && m > 0) {
          let g = h.replace(/\bwidth="[^"]*"/i, `width="${Math.max(1, Math.round(d * n))}"`).replace(/\bheight="[^"]*"/i, `height="${Math.max(1, Math.round(m * n))}"`);
          f = fn(p.replace(h, g)), l = true;
        }
      } catch {}
    let u = new Image;
    u.decoding = "sync", u.loading = "eager", u.src = f;
    try {
      await u.decode();
    } catch (p) {
      if (!l)
        throw p;
      u.src = t, l = false, await u.decode();
    }
    if (s && a)
      u.style.width = `${r}px`, u.style.height = `${i}px`;
    else if (s) {
      let p = Number.isFinite(o.vbW) ? o.vbW : Number.isFinite(o.w0) ? o.w0 : u.naturalWidth, h = Number.isFinite(o.vbH) ? o.vbH : Number.isFinite(o.h0) ? o.h0 : u.naturalHeight, d = r / Math.max(1, p);
      u.style.width = `${r}px`, u.style.height = `${Math.max(1, Math.round(h * d))}px`;
    } else if (a) {
      let p = Number.isFinite(o.vbW) ? o.vbW : Number.isFinite(o.w0) ? o.w0 : u.naturalWidth, h = Number.isFinite(o.vbH) ? o.vbH : Number.isFinite(o.h0) ? o.h0 : u.naturalHeight, d = i / Math.max(1, h);
      u.style.height = `${i}px`, u.style.width = `${Math.max(1, Math.round(p * d))}px`;
    } else {
      let p = Math.max(1, Math.round(u.naturalWidth * (l ? 1 : n))), h = Math.max(1, Math.round(u.naturalHeight * (l ? 1 : n)));
      if (u.style.width = `${p}px`, u.style.height = `${h}px`, !l && n !== 1 && typeof t == "string" && t.startsWith("data:image/svg+xml"))
        try {
          let m = decodeURIComponent(t.split(",")[1]).replace(/width="[^"]*"/, `width="${p}"`).replace(/height="[^"]*"/, `height="${h}"`);
          u.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(m)}`, await u.decode();
        } catch (d) {
          D(e, "SVG width/height patch in toImg failed", d), u.src !== t && (u.src = t, await u.decode().catch(() => {}));
        }
    }
    return u;
  }
  var Oo = ct(() => {
    ht();
    Qt();
    De();
    Oe();
  });
  var Ta = {};
  ze(Ta, { toBlob: () => Do });
  async function Do(t, e) {
    let n = e.format || e.type || "svg";
    if (n === "svg") {
      if (typeof HTMLCanvasElement < "u" && t instanceof HTMLCanvasElement)
        throw new Error("[snapdom] toBlob: engine:'html-in-canvas' produces a raster capture; ask for png/jpeg/webp");
      let i = decodeURIComponent(t.split(",")[1]);
      return new Blob([i], { type: "image/svg+xml" });
    }
    let r = await le(t, e);
    return new Promise((i) => r.toBlob((o) => i(o), `image/${n === "jpg" ? "jpeg" : n}`, e.quality));
  }
  var Bo = ct(() => {
    Oe();
  });
  var Pa = {};
  ze(Pa, { download: () => Zu });
  async function $a(t, e) {
    let n = new File([t], e, { type: t.type });
    if (!navigator.canShare?.({ files: [n] }))
      return false;
    try {
      await navigator.share({ files: [n], title: e });
    } catch (r) {
      if (r.name !== "AbortError")
        return false;
    }
    return true;
  }
  async function Zu(t, e) {
    let n = new Set(["png", "jpeg", "jpg", "webp", "svg"]), r = (e?.type || "").toLowerCase(), i = n.has(r) ? r : "", o = (e?.format || i || "").toLowerCase(), s = o === "jpg" ? "jpeg" : o || "png", a = e?.filename || "snapdom", c = /\.(png|jpe?g|webp|svg)$/i.test(a) ? a : `${a}.${s}`, f = { ...e || {}, format: s, type: s };
    f.dpr = 1;
    let l = Xe();
    if (s === "svg") {
      let h = await Do(t, { ...f, type: "svg" });
      if (l && await $a(h, c))
        return;
      let d = URL.createObjectURL(h), m = document.createElement("a");
      m.href = d, m.download = c, document.body.appendChild(m), m.click(), URL.revokeObjectURL(d), m.remove();
      return;
    }
    let u = await le(t, f);
    if (l) {
      let h = `image/${s}`, d = await new Promise((m) => u.toBlob(m, h, e?.quality));
      if (d && await $a(d, c))
        return;
    }
    let p = document.createElement("a");
    p.href = u.toDataURL(`image/${s}`, e?.quality), p.download = c, document.body.appendChild(p), p.click(), p.remove();
  }
  var Na = ct(() => {
    Bo();
    Oe();
    kt();
  });
  ht();
  ht();
  kt();
  dt();
  kr();
  wt();
  var Jt = new WeakMap;
  var si = ["margin-top", "margin-right", "margin-bottom", "margin-left", "margin-block-start", "margin-block-end", "margin-inline-start", "margin-inline-end"];
  var Rr = new Map;
  var gc = 2000;
  var gn = 0;
  function _t() {
    gn++;
  }
  function mn(t) {
    let e = t && (t.nodeType === 1 ? t : t.parentElement);
    for (;e; ) {
      if (Ut(e))
        return true;
      if (e.parentElement)
        e = e.parentElement;
      else {
        let n = e.getRootNode?.();
        e = n && n.host ? n.host : null;
      }
    }
    return false;
  }
  function bn(t) {
    for (let e of t)
      if (te(e))
        return true;
    return false;
  }
  function te(t) {
    if (mn(t.target))
      return false;
    if (t.type === "childList") {
      let e = true;
      for (let n of t.addedNodes)
        if (!mn(n)) {
          e = false;
          break;
        }
      if (e) {
        for (let n of t.removedNodes)
          if (!mn(n)) {
            e = false;
            break;
          }
      }
      if (e)
        return false;
    }
    return true;
  }
  var be = new WeakMap;
  function ui(t) {
    for (let e of t) {
      if (!te(e))
        continue;
      let n = e.target.ownerDocument || document;
      be.set(n, (be.get(n) || 0) + 1);
      let r = e.target.nodeType === 1 ? e.target : e.target.parentElement || e.target.host;
      for (;r; r = r.parentElement || r.getRootNode?.()?.host)
        be.set(r, (be.get(r) || 0) + 1);
    }
  }
  function wn(t) {
    let e = t.ownerDocument || document;
    return xe(e), (be.get(e) || 0) - (be.get(t) || 0);
  }
  var Ct = 0;
  function we(t = document) {
    return xe(t), Ct;
  }
  function ee() {
    return xe(), gn;
  }
  function Je(t) {
    return t ? (xe(t.ownerDocument || document), Sn(t, Ir(t))) : 0;
  }
  function Se() {
    _t(), Ct++;
  }
  var Zt = new WeakMap;
  var jt = 0;
  var Vt = 0;
  function yc(t) {
    Zt.set(t, ++jt);
  }
  function Nr(t) {
    if (!t || t.nodeType !== 1)
      return;
    jt++, Zt.set(t, jt);
    let e = t.querySelectorAll("*");
    for (let n = 0;n < e.length; n++)
      Zt.set(e[n], jt);
  }
  function Lr(t) {
    Nr(t.parentElement || t);
    for (let e = t.parentElement;e; e = e.parentElement)
      yc(e);
  }
  function Sn(t, e = null) {
    let n = Zt.get(t) || 0;
    if (e)
      for (let r of e)
        n = Math.max(n, Zt.get(r) || 0);
    return Vt * 1e9 + n;
  }
  function Ir(t) {
    let e = t.getRootNode?.();
    if (!e?.host)
      return null;
    let n = [];
    for (;e?.host; )
      e.mode === "open" && Or(e), n.push(e.host), e = e.host.getRootNode?.();
    return n;
  }
  var Fr = new WeakMap;
  function Wr(t) {
    t = t || document;
    let e = Fr.get(t);
    if (!e || e.env !== Ct) {
      let n = true;
      try {
        n = re(t).usesHas;
      } catch {}
      e = { env: Ct, usesHas: n }, Fr.set(t, e);
    }
    return !e.usesHas;
  }
  function bc(t) {
    let e = (n) => n?.nodeType === 1 && (n.matches?.("style,link") || n.querySelector?.("style,link"));
    for (let n of t) {
      let r = n.target, i = r && (r.nodeType === 1 ? r : r.parentElement);
      if (i && (i.tagName === "STYLE" || i.tagName === "LINK"))
        return i.ownerDocument || document;
      for (let o of n.addedNodes)
        if (e(o))
          return o.ownerDocument || document;
      for (let o of n.removedNodes)
        if (e(o))
          return o.ownerDocument || r && r.ownerDocument || document;
    }
    return null;
  }
  var Tr = new WeakSet;
  var Ye = [];
  function di(t) {
    if (!bn(t))
      return;
    ui(t), _t();
    let e = new Set;
    for (let n of t) {
      if (!te(n))
        continue;
      let r = n.target.getRootNode && n.target.getRootNode();
      if (!r || r.nodeType !== 11 || e.has(r))
        continue;
      e.add(r), r.host ? Nr(r.host) : jt++;
      let i = r.querySelectorAll("*");
      for (let o = 0;o < i.length; o++)
        Zt.set(i[o], jt);
    }
  }
  function Or(t) {
    if (!(!t || Tr.has(t))) {
      Tr.add(t);
      try {
        let e = new MutationObserver(di);
        e.observe(t, { subtree: true, childList: true, characterData: true, attributes: true }), Ye.push({ o: e, root: t });
      } catch {}
    }
  }
  function pi(t) {
    if (!bn(t))
      return;
    ui(t), _t();
    let e = bc(t);
    if (e) {
      Fr.delete(e), Ct++, Vt++;
      return;
    }
    let n = new Set;
    for (let r of t) {
      if (!te(r))
        continue;
      let i = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!i)
        continue;
      let o = i.ownerDocument || document;
      if (!Wr(o)) {
        Vt++;
        return;
      }
      if (i === o.documentElement || i === o.body) {
        Vt++;
        return;
      }
      let s = i.parentElement || i;
      n.has(s) || (n.add(s), Lr(i));
    }
  }
  var $r = new WeakSet;
  var Ke = null;
  var Qe = [];
  function xe(t = document) {
    if (t === Ke || !t || t.nodeType !== 9)
      return;
    if ($r.has(t)) {
      Ke = t;
      return;
    }
    $r.add(t), Ke = t;
    let e = t.defaultView, n = (i) => {
      bn(i) && (_t(), Ct++);
    }, r = () => {
      _t(), Ct++;
    };
    try {
      let i = new MutationObserver(pi);
      i.observe(t.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }), Qe.push({ o: i, env: false, doc: t });
    } catch {}
    try {
      let i = new MutationObserver(n);
      i.observe(t.head, { subtree: true, childList: true, characterData: true, attributes: true }), Qe.push({ o: i, env: true, doc: t });
    } catch {}
    try {
      e?.addEventListener("resize", r, { passive: true });
    } catch {}
    try {
      let i = (o) => {
        _t();
        let s = o.composedPath?.()[0] || o.target;
        s && s.nodeType === 1 && !mn(s) && Wr(s.ownerDocument || t) ? Lr(s) : Vt++;
      };
      t.addEventListener("focusin", i, { capture: true, passive: true }), t.addEventListener("focusout", i, { capture: true, passive: true }), t.addEventListener("change", i, { capture: true, passive: true }), t.addEventListener("pointerdown", i, { capture: true, passive: true }), t.addEventListener("pointerup", i, { capture: true, passive: true }), t.addEventListener("pointercancel", i, { capture: true, passive: true }), t.addEventListener("keydown", i, { capture: true, passive: true }), t.addEventListener("keyup", i, { capture: true, passive: true }), t.addEventListener("beforetoggle", i, { capture: true, passive: true }), t.addEventListener("toggle", i, { capture: true, passive: true }), e?.addEventListener("hashchange", () => {
        _t(), Vt++;
      }, { passive: true });
    } catch {}
    try {
      let i = t.fonts;
      i && (i.addEventListener?.("loadingdone", r), i.status === "loading" && i.ready?.then(r).catch(() => {}));
    } catch {}
  }
  var ai = new WeakMap;
  function ci(t, e) {
    if (!t?.querySelectorAll)
      return;
    let n;
    try {
      n = Array.from(t.querySelectorAll(":hover"));
    } catch {
      return;
    }
    let r = ai.get(t) || [];
    if (r.length === n.length && r.every((o, s) => o === n[s]))
      return;
    if (ai.set(t, n), _t(), t.nodeType === 11) {
      t.host ? Nr(t.host) : jt++;
      for (let o of t.querySelectorAll("*"))
        Zt.set(o, jt);
      return;
    }
    let i = r.filter((o) => !n.includes(o)).concat(n.filter((o) => !r.includes(o)));
    for (let o of i)
      if (o.isConnected)
        if (Wr(e))
          Lr(o);
        else {
          Vt++;
          return;
        }
  }
  function xn(t, e = null) {
    if (!t)
      return;
    ci(t, t);
    let n = e || Ye.filter(({ root: r }) => r.host?.isConnected).map(({ root: r }) => r);
    for (let r of n)
      ci(r, t);
  }
  function Rt() {
    xe();
    try {
      for (let t = Qe.length - 1;t >= 0; t--) {
        let { o: e, env: n, doc: r } = Qe[t];
        if (r !== document && !r.defaultView) {
          try {
            e.disconnect();
          } catch {}
          $r.delete(r), Ke === r && (Ke = null), Qe.splice(t, 1);
          continue;
        }
        let i = e.takeRecords();
        i.length && (n ? bn(i) && (_t(), Ct++) : pi(i));
      }
      for (let t = Ye.length - 1;t >= 0; t--) {
        let { o: e, root: n } = Ye[t];
        if (!n.host || !n.host.isConnected) {
          try {
            e.disconnect();
          } catch {}
          Tr.delete(n), Ye.splice(t, 1);
          continue;
        }
        let r = e.takeRecords();
        r.length && di(r);
      }
    } catch {}
  }
  function ne(t) {
    if (!(!t || t.nodeType !== 1)) {
      Jt.delete(t);
      try {
        let e = (t.ownerDocument || document).createTreeWalker(t, NodeFilter.SHOW_ELEMENT);
        for (;e.nextNode(); )
          Jt.delete(e.currentNode);
      } catch {}
    }
  }
  var wc = ["mask", "mask-image", "-webkit-mask", "-webkit-mask-image", "mask-source", "mask-box-image-source", "mask-border-source", "-webkit-mask-box-image-source", "border-image", "border-image-source"];
  function Dr(t) {
    let e = Jt.get(t);
    if (e && Br(e, t)) {
      let n = e.snapshot && e.snapshot.__needsBgInline;
      if (n !== undefined)
        return n;
    }
    return true;
  }
  function hi(t) {
    let e = Jt.get(t);
    if (!e || !Br(e, t))
      return null;
    let n = e.snapshot;
    return !n || n.__bgClipTextFix ? null : n;
  }
  var li = new WeakMap;
  function re(t) {
    let e = li.get(t);
    return (!e || e.epoch !== gn) && (e = { epoch: gn, ...ei(t) }, li.set(t, e)), e;
  }
  function mi(t) {
    try {
      let e = re(t.ownerDocument || document).shareGate;
      if (e === null)
        return false;
      if (!e.length)
        return true;
      let n = new Set, r = (s) => {
        n.add("t" + s.localName), s.id && n.add("i" + s.id);
        let a = s.classList;
        for (let c = 0;c < a.length; c++)
          n.add("c" + a[c]);
      };
      r(t);
      for (let s of t.querySelectorAll("*"))
        r(s);
      let i = [];
      for (let { sel: s, key: a } of e)
        (a === null || n.has(a)) && i.push(s);
      if (!i.length)
        return true;
      let o = i.join(",");
      return !t.matches(o) && t.querySelector(o) === null;
    } catch {
      return false;
    }
  }
  function Sc(t) {
    let e = t.ownerDocument || document;
    return t.getRootNode && t.getRootNode() !== e ? null : re(e).importantProps;
  }
  function Ze(t) {
    let e = t.ownerDocument || document;
    return t.getRootNode && t.getRootNode() !== e ? null : re(e).universe;
  }
  function yn(t) {
    let e = t.ownerDocument || document;
    return t.getRootNode && t.getRootNode() !== e ? null : re(e).pseudoUniverse;
  }
  var xc = { before: null, after: null, firstLetter: null, marker: null, firstLine: null };
  function ve(t) {
    let e = t.ownerDocument || document;
    return t.getRootNode && t.getRootNode() !== e ? xc : re(e).pseudoGates;
  }
  function vc(t, e = {}, n = null, r = null) {
    let i = {}, o = e.excludeStyleProps, s = (h) => {
      if (i[h] !== undefined || he(h) || o && (o instanceof RegExp && o.test(h) || typeof o == "function" && o(h)))
        return;
      let d = t.getPropertyValue(h);
      d && ((h === "background-image" || h === "content") && d.includes("url(") && !d.includes("data:") && (d = "none"), i[h] = d);
    };
    if (r) {
      for (let d of r)
        s(d);
      let h = n && n.style;
      if (h && h.length)
        for (let d = 0;d < h.length; d++)
          s(h[d]);
    } else
      for (let h = 0;h < t.length; h++)
        s(t[h]);
    let a = ["text-decoration-line", "text-decoration-color", "text-decoration-style", "text-decoration-thickness", "text-underline-offset", "text-decoration-skip-ink"];
    for (let h of a)
      if (!i[h])
        try {
          let d = t.getPropertyValue(h);
          d && (i[h] = d);
        } catch {}
    let c = ["-webkit-text-stroke", "-webkit-text-stroke-width", "-webkit-text-stroke-color", "paint-order"];
    for (let h of c)
      if (!i[h])
        try {
          let d = t.getPropertyValue(h);
          d && (i[h] = d);
        } catch {}
    if (e.embedFonts) {
      let h = ["font-feature-settings", "font-variation-settings", "font-kerning", "font-variant", "font-variant-ligatures", "font-optical-sizing"];
      for (let d of h)
        if (!i[d])
          try {
            let m = t.getPropertyValue(d);
            m && (i[d] = m);
          } catch {}
    }
    try {
      (i["content-visibility"] || t.getPropertyValue("content-visibility")) === "hidden" && (i["content-visibility"] = "hidden");
    } catch {}
    Object.defineProperty(i, "__needsBgInline", { value: gi(t), enumerable: false });
    let f = parseFloat(t.getPropertyValue("border-top-width") || 0) || 0, l = parseFloat(t.getPropertyValue("border-right-width") || 0) || 0, u = parseFloat(t.getPropertyValue("border-bottom-width") || 0) || 0, p = parseFloat(t.getPropertyValue("border-left-width") || 0) || 0;
    if (f === 0 && l === 0 && u === 0 && p === 0) {
      let h = (t.getPropertyValue("border-image-source") || "").trim(), d = h && h !== "none", m = ["border", "border-top", "border-right", "border-bottom", "border-left", "border-width", "border-style", "border-color", "border-top-width", "border-top-style", "border-top-color", "border-right-width", "border-right-style", "border-right-color", "border-bottom-width", "border-bottom-style", "border-bottom-color", "border-left-width", "border-left-style", "border-left-color", "border-block", "border-block-width", "border-block-style", "border-block-color", "border-inline", "border-inline-width", "border-inline-style", "border-inline-color", "border-block-start", "border-block-start-width", "border-block-start-style", "border-block-start-color", "border-block-end", "border-block-end-width", "border-block-end-style", "border-block-end-color", "border-inline-start", "border-inline-start-width", "border-inline-start-style", "border-inline-start-color", "border-inline-end", "border-inline-end-width", "border-inline-end-style", "border-inline-end-color"];
      for (let g of m)
        delete i[g];
      d || (i.border = "none");
    }
    return kc(i), i;
  }
  function kc(t) {
    if (!zt())
      return;
    let e = t["background-clip"] || t["-webkit-background-clip"];
    if (!e || !e.includes("text"))
      return;
    let n = (o) => o === "transparent" || o === "rgba(0, 0, 0, 0)", r = t["-webkit-text-fill-color"];
    if (!n(r !== undefined ? r : t.color))
      return;
    let i = Cc(t["background-image"], t["background-color"]);
    i && (n(t.color) && (t.color = i), r !== undefined && (t["-webkit-text-fill-color"] = i), t["background-image"] = "none", t["background-color"] = "transparent", delete t["background-clip"], delete t["-webkit-background-clip"], Object.defineProperty(t, "__bgClipTextFix", { value: i, enumerable: false }));
  }
  function Cc(t, e) {
    let n = (o) => {
      let s = [], a = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)/g, c;
      for (;c = a.exec(o || ""); ) {
        let f = c[4];
        (f === undefined ? 1 : parseFloat(f) / (f.endsWith("%") ? 100 : 1)) > 0.05 && s.push([+c[1], +c[2], +c[3]]);
      }
      return s;
    }, r = n(t);
    if (r.length || (r = n(e)), !r.length)
      return null;
    let i = [0, 0, 0];
    for (let [o, s, a] of r)
      i[0] += o, i[1] += s, i[2] += a;
    return `rgb(${i.map((o) => Math.round(o / r.length)).join(", ")})`;
  }
  function gi(t) {
    let e = t.getPropertyValue("background-image");
    if (e && e !== "none")
      return true;
    let n = t.getPropertyValue("background-color");
    if (n && n !== "rgba(0, 0, 0, 0)" && n !== "transparent")
      return true;
    for (let i of wc) {
      let o = t.getPropertyValue(i);
      if (o && o !== "none")
        return true;
    }
    let r = t.getPropertyValue("background");
    return !!(r && /url\s*\(/i.test(r));
  }
  function Ac(t) {
    for (let e = t.firstChild;e; e = e.nextSibling) {
      if (e.nodeType === 3 && /\S/.test(e.nodeValue || ""))
        return true;
      if (e.nodeType === 1) {
        let n = W(e).position;
        if (n !== "absolute" && n !== "fixed")
          return true;
      }
    }
    return false;
  }
  function Mc(t, e, n) {
    try {
      if (typeof t.computedStyleMap == "function") {
        let i = t.computedStyleMap().get("width");
        if (i != null)
          return !fi(String(i).trim().toLowerCase());
      }
    } catch {}
    let r = t.style && (t.style.width || t.style.inlineSize);
    return r && !fi(String(r).trim().toLowerCase()) ? true : _c(t, e) ? n || Rc(t, e) : false;
  }
  var Ec = new Set(["auto", "min-content", "max-content", "stretch", "fill-available", "-webkit-fill-available"]);
  function fi(t) {
    return Ec.has(t) || t.startsWith("fit-content");
  }
  function _c(t, e) {
    let n = t.getBoundingClientRect().width - (parseFloat(e.paddingLeft) || 0) - (parseFloat(e.paddingRight) || 0) - (parseFloat(e.borderLeftWidth) || 0) - (parseFloat(e.borderRightWidth) || 0);
    if (!(n > 0))
      return false;
    let r = 1 / 0, i = -1 / 0, o = null;
    for (let s = t.firstChild;s; s = s.nextSibling) {
      let a;
      if (s.nodeType === 3) {
        if (!/\S/.test(s.nodeValue || "") || (o = o || document.createRange(), o.selectNode(s), a = o.getBoundingClientRect(), !a.width && !a.height))
          continue;
      } else if (s.nodeType === 1) {
        let c = W(s);
        if (c.display === "none" || c.position === "absolute" || c.position === "fixed")
          continue;
        a = s.getBoundingClientRect();
      } else
        continue;
      a.left < r && (r = a.left), a.right > i && (i = a.right);
    }
    return i === -1 / 0 ? false : i - r < n - 0.5;
  }
  function Rc(t, e) {
    let n = t.parentElement;
    if (!n)
      return false;
    let r = W(n), i = n.getBoundingClientRect().width - (parseFloat(r.paddingLeft) || 0) - (parseFloat(r.paddingRight) || 0) - (parseFloat(r.borderLeftWidth) || 0) - (parseFloat(r.borderRightWidth) || 0) - (parseFloat(e.marginLeft) || 0) - (parseFloat(e.marginRight) || 0);
    return i > 0 ? Math.abs(t.getBoundingClientRect().width - i) > 0.5 : false;
  }
  var Pr = new WeakMap;
  function Fc(t) {
    let e = Pr.get(t);
    if (e)
      return e;
    let n = [];
    for (let r in t)
      n.push(r, t[r]);
    return e = n.join("\x01"), Pr.set(t, e), e;
  }
  function Br(t, e) {
    return t.env === Ct && t.stamp === Sn(e, t.hosts);
  }
  var Tc = /^(width|height|inline-size|block-size|top|right|bottom|left|transform-origin|perspective-origin)$|^inset-/;
  var $c = /(margin|padding)[a-z-]*\s*:[^;]*(%|\bauto\b|calc\(|var\()/i;
  var Pc = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "OPTGROUP", "PROGRESS", "METER", "BUTTON", "DATALIST"]);
  function Nc(t) {
    let e = t.__styleShare;
    return e || (e = t.__styleShare = { ids: new WeakMap, intern: new Map, snaps: new Map, rootSeen: false }), e;
  }
  function Lc(t, e) {
    let n = e.ids.get(t);
    if (n !== undefined)
      return n;
    let r = t.parentElement, i;
    if (!r)
      i = "R";
    else if (i = e.ids.get(r), i === undefined) {
      if (e.rootSeen)
        return e.ids.set(t, -1), -1;
      i = "R";
    }
    if (e.rootSeen = true, i === -1)
      return e.ids.set(t, -1), -1;
    let o = "", s = t.attributes;
    if (s && s.length)
      if (s.length === 1)
        o = s[0].name + "=" + s[0].value;
      else {
        let c = [];
        for (let f = 0;f < s.length; f++)
          c.push(s[f].name + "=" + s[f].value);
        c.sort(), o = c.join("\x01");
      }
    let a = i + "|" + t.tagName + "|" + o;
    return n = e.intern.get(a), n === undefined && (n = e.intern.size, e.intern.set(a, n)), e.ids.set(t, n), n;
  }
  function yi(t, e) {
    let n = t.snap, r = t.snap = { ...n };
    Object.defineProperty(r, "__needsBgInline", { value: n.__needsBgInline, enumerable: false }), n.__bgClipTextFix !== undefined && Object.defineProperty(r, "__bgClipTextFix", { value: n.__bgClipTextFix, enumerable: false });
    let i = re(e.ownerDocument || document), o = e.getAttribute && e.getAttribute("style") || "", s = o && $c.test(o), a = !!i.marginUnstable || s && /margin/i.test(o), c = !!i.paddingUnstable || s && /padding/i.test(o), f = r.display !== undefined && r.display.includes("grid"), l = r.transform !== undefined && r.transform !== "none", u = [];
    for (let d in r)
      (Tc.test(d) || f && (d === "grid-template-columns" || d === "grid-template-rows") || l && d === "transform" || a && d.charCodeAt(0) === 109 && d.startsWith("margin-") || c && d.charCodeAt(0) === 112 && d.startsWith("padding-")) && u.push(d);
    t.h && !("height" in r) && u.push("height"), t.b && !("block-size" in r) && u.push("block-size");
    let p = new Set(u), h = [];
    for (let d in r)
      p.has(d) || h.push(d, r[d]);
    return t.rr = u, t.sig = h.join("\x01") + "\x02" + u.join("\x01"), u;
  }
  function bi(t, e, n, r, i) {
    let o = i && i.__styleShare ? r && r.__styleShare : null, s = o ? o.ids.get(t) : undefined;
    if (s === undefined || s === -1 || t.shadowRoot || t.assignedSlot)
      return ge(n, yn(t));
    let a = s + e, c = o.pseudo || (o.pseudo = new Map), f = c.get(a);
    if (f) {
      let u = { ...f.snap }, p = f.rr || yi(f, t);
      for (let h = 0;h < p.length; h++) {
        let d = n.getPropertyValue(p[h]);
        d ? u[p[h]] = d : delete u[p[h]];
      }
      return u;
    }
    let l = ge(n, yn(t));
    return c.set(a, { snap: l, rr: null, sig: null, h: "height" in l, b: "block-size" in l }), l;
  }
  function Ic(t, e = null, n = {}, r = null) {
    let i = Jt.get(t), o = !!(n && n.embedFonts), s = n && n.excludeStyleProps || null;
    if (typeof s != "function" && i && Br(i, t) && i.embedFonts === o && i.excludeStyleProps === s)
      return i.snapshot;
    let a = e || getComputedStyle(t), c, f = null, l = r && r.st.snaps.get(r.id);
    if (l) {
      c = { ...l.snap };
      let h = l.rr || yi(l, t);
      f = [];
      for (let d = 0;d < h.length; d++) {
        let m = h[d], g = a.getPropertyValue(m);
        g ? c[m] = g : delete c[m], f.push(g);
      }
      Object.defineProperty(c, "__needsBgInline", { value: l.snap.__needsBgInline, enumerable: false }), l.snap.__bgClipTextFix !== undefined && Object.defineProperty(c, "__bgClipTextFix", { value: l.snap.__bgClipTextFix, enumerable: false });
    } else
      c = vc(a, n, t, Ze(t)), r && r.st.snaps.set(r.id, { snap: c, rr: null, sig: null, h: "height" in c, b: "block-size" in c });
    let u = false;
    if (typeof t.computedStyleMap == "function") {
      let h;
      for (let d of si)
        if (c[d] === "0px")
          try {
            h ||= t.computedStyleMap(), h.get(d)?.toString() === "auto" && (c[d] = "auto", u = true);
          } catch {}
    }
    Vc(t, a, c), f !== null && (u && f.push("\x05", ...si.map((h) => c[h])), Pr.set(c, l.sig + "\x02" + f.join("\x01") + ("height" in c ? "" : "\x03") + ("block-size" in c ? "" : "\x04")));
    let p = Ir(t);
    return Jt.set(t, { env: Ct, stamp: Sn(t, p), hosts: p, snapshot: c, embedFonts: o, excludeStyleProps: s }), c;
  }
  function Wc(t, e) {
    if (t && t.session && t.persist)
      return t;
    if (t && (t.styleMap || t.styleCache || t.nodeMap)) {
      let n = t.__ctx;
      return (!n || t.__ctxOpts !== e) && (n = { session: t, persist: { snapshotKeyCache: Rr, defaultStyle: P.defaultStyle, baseStyle: P.baseStyle, image: P.image, resource: P.resource, background: P.background }, options: e || {} }, t.__ctx = n, t.__ctxOpts = e), n;
    }
    return { session: { styleMap: new Map, styleCache: new WeakMap, nodeMap: new Map }, persist: { snapshotKeyCache: Rr, defaultStyle: P.defaultStyle, baseStyle: P.baseStyle, image: P.image, resource: P.resource, background: P.background }, options: t || e || {} };
  }
  var Oc = /%|[\d.](?:em|rem|ex|ch|cap|ic|lh|rlh|v[whib]|vmin|vmax|cq[whbi]|cqmin|cqmax)\b|\b(?:calc|var|min|max|clamp|env|attr)\(|\b(?:auto|inherit|initial|unset|revert|currentcolor|-webkit-fill-available|fit-content|min-content|max-content)\b/i;
  var Dc = (t) => t.tagName === "INPUT" || t.tagName === "TEXTAREA";
  function Bc(t, e, n) {
    if (!t.style || t.style.length === 0)
      return;
    let r = Sc(t), i = r != null && !Oc.test(t.getAttribute("style") || "");
    for (let o = 0;o < t.style.length; o++) {
      let s = t.style[o];
      if (i && !r.has(s) && !(s.startsWith("background") && Dc(t)))
        continue;
      let a = n.getPropertyValue(s);
      a && e.style.setProperty(s, a, t.style.getPropertyPriority(s));
    }
  }
  function lt(t, e, n, r) {
    if (t.tagName === "STYLE")
      return;
    let i = Wc(n, r), o = i.options && i.options.cache || "soft";
    o !== "disabled" && xe(t.ownerDocument), o === "disabled" && !i.session.__bumpedForDisabled && (_t(), Rr.clear(), i.session.__bumpedForDisabled = true);
    let { session: s, persist: a } = i;
    if (!s.styleCache.has(t)) {
      let y = null;
      try {
        y = getComputedStyle(t);
      } catch {}
      s.styleCache.set(t, y || getComputedStyle((t.ownerDocument || document).documentElement));
    }
    let c = s.styleCache.get(t);
    t.getAttribute?.("style") && Bc(t, e, c);
    let f = c.getPropertyValue("animation-name");
    e && e.style && f && f !== "none" && e.style.setProperty("animation", "none", "important");
    let l = t.tagName?.toLowerCase() || "div";
    if (qe.has(l)) {
      let y = {};
      Object.defineProperty(y, "__needsBgInline", { value: gi(c), enumerable: false });
      let b = Ir(t);
      Jt.set(t, { env: Ct, stamp: Sn(t, b), hosts: b, snapshot: y, embedFonts: !!(i.options && i.options.embedFonts), excludeStyleProps: i.options && i.options.excludeStyleProps || null }), s.styleMap.set(e, "");
      return;
    }
    let u = null;
    if (i.options && i.options.__styleShare && s.styleMap) {
      let y = Nc(s), b = Lc(t, y), w = t.ownerDocument || document, C = w.activeElement;
      b !== -1 && !Pc.has(t.tagName) && !(C && C !== w.body && C !== w.documentElement && C === t) && (!t.getRootNode || t.getRootNode() === w) && !t.shadowRoot && !t.assignedSlot && (u = { st: y, id: b });
    }
    let p = Ic(t, c, i.options, u);
    if (t.getAttribute?.("style"))
      for (let y of ["top", "right", "bottom", "left"]) {
        let b = `margin-${y}`;
        p[b] === "auto" && e.style.setProperty(b, "auto", "important");
      }
    p.__bgClipTextFix && e && e.style && (e.style.setProperty("background-image", "none", "important"), e.style.setProperty("background-color", "transparent", "important"), e.style.setProperty("color", p.__bgClipTextFix, "important"), e.style.setProperty("-webkit-text-fill-color", p.__bgClipTextFix, "important")), Uc(t, c, p);
    let h = wi(t);
    if (h) {
      let y = c.getPropertyValue("min-width");
      (!y || y === "auto" || y === "0px") && (p["min-width"] = "0px");
    }
    let d = Fc(p), m = true;
    if (hn(l, (p.display || "").toLowerCase())) {
      m = Ac(t), m && Mr(l, p, h) && Mc(t, c, h) && (m = false), d = `${d}|${l}${m ? "|c" : ""}${h ? "|f" : ""}`;
      let y = p["text-wrap-mode"] || p["white-space"] || "";
      m && y !== "nowrap" && y !== "pre" && (s.reconcileRisk = (s.reconcileRisk || 0) + 1);
    }
    let g = a.snapshotKeyCache.get(d);
    g === undefined && (g = me(p, l, m, h), a.snapshotKeyCache.size >= gc && a.snapshotKeyCache.delete(a.snapshotKeyCache.keys().next().value), a.snapshotKeyCache.set(d, g)), s.styleMap.set(e, g);
  }
  function Uc(t, e, n) {
    let r = e.getPropertyValue("overflow-x"), i = e.getPropertyValue("overflow-y");
    if ((r === "visible" || !r) && (i === "visible" || !i) || e.getPropertyValue("box-sizing") === "border-box" || typeof t.clientWidth != "number" || !t.offsetWidth)
      return;
    let o = (f) => parseFloat(f) || 0, s = t.offsetWidth - t.clientWidth - o(e.getPropertyValue("border-left-width")) - o(e.getPropertyValue("border-right-width")), a = t.offsetHeight - t.clientHeight - o(e.getPropertyValue("border-top-width")) - o(e.getPropertyValue("border-bottom-width")), c = (f, l) => {
      let u = n[f];
      if (!u || !u.endsWith("px"))
        return;
      let p = parseFloat(u);
      Number.isFinite(p) && (n[f] = `${Math.round((p + l) * 1000) / 1000}px`);
    };
    s > 0.5 && (c("width", s), c("inline-size", s)), a > 0.5 && (c("height", a), c("block-size", a));
  }
  function Hc(t) {
    return t.backgroundImage && t.backgroundImage !== "none" || t.backgroundColor && t.backgroundColor !== "rgba(0, 0, 0, 0)" && t.backgroundColor !== "transparent" || (parseFloat(t.borderTopWidth) || 0) > 0 || (parseFloat(t.borderBottomWidth) || 0) > 0 || (parseFloat(t.paddingTop) || 0) > 0 || (parseFloat(t.paddingBottom) || 0) > 0 ? true : (t.overflowBlock || t.overflowY || "visible") !== "visible";
  }
  function wi(t) {
    let e = t.parentElement;
    if (!e)
      return false;
    let n = W(e).display || "";
    return n.includes("flex") || n.includes("grid");
  }
  function zc(t) {
    for (let r = t.firstChild;r; r = r.nextSibling)
      if (r.nodeType === 3 && /\S/.test(r.nodeValue))
        return true;
    let { firstElementChild: e, lastElementChild: n } = t;
    if (e && e.tagName === "BR" || n && n.tagName === "BR")
      return true;
    for (let r = t.firstElementChild;r; r = r.nextElementSibling) {
      let i = W(r);
      if (i.display === "none")
        continue;
      let o = i.position;
      if (o !== "absolute" && o !== "fixed")
        return true;
    }
    return false;
  }
  function jc(t) {
    let e = t.getBoundingClientRect().top, n = -1 / 0, r = null;
    for (let i = t.firstChild;i; i = i.nextSibling) {
      if (i.nodeType === 3) {
        if (!/\S/.test(i.nodeValue || ""))
          continue;
        r = r || document.createRange(), r.selectNode(i);
        let a = r.getBoundingClientRect();
        (a.width || a.height) && (n = Math.max(n, a.bottom));
        continue;
      }
      if (i.nodeType !== 1)
        continue;
      let o = W(i);
      if (o.display === "none")
        continue;
      let s = o.position;
      s === "absolute" || s === "fixed" || o.float && o.float !== "none" || (n = Math.max(n, i.getBoundingClientRect().bottom));
    }
    return n === -1 / 0 ? NaN : n - e;
  }
  function Vc(t, e, n) {
    if (vt(t) && t.style && t.style.height)
      return;
    let r = t.tagName && t.tagName.toLowerCase();
    if (!r || !["div", "section", "article", "main", "aside", "header", "footer", "nav"].includes(r) || e.aspectRatio && e.aspectRatio !== "none" && e.aspectRatio !== "auto")
      return;
    let o = e.display || "";
    if (o.includes("flex") || o.includes("grid"))
      return;
    let s = e.position;
    if (s === "absolute" || s === "fixed" || s === "sticky" || e.transform !== "none" || Hc(e) || wi(t))
      return;
    let a = e.overflowX || e.overflow || "visible", c = e.overflowY || e.overflow || "visible";
    if (a !== "visible" || c !== "visible")
      return;
    let f = e.clip;
    if (f && f !== "auto" && f !== "rect(auto, auto, auto, auto)" || e.visibility === "hidden" || e.opacity === "0" || !zc(t))
      return;
    let l = parseFloat(e.height), u = jc(t);
    Number.isFinite(l) && Number.isFinite(u) && Math.abs(l - u) > 2 || (delete n.height, delete n["block-size"]);
  }
  ye();
  var qc = new Set(["symbol", "defs", "pattern", "marker", "linearGradient", "radialGradient", "filter"]);
  var Ur = new WeakMap;
  var Si = -1;
  function vn(t) {
    let e = ee();
    return e !== Si && (Ur = new WeakMap, Si = e), xi(t);
  }
  function xi(t) {
    let e = Ur.get(t);
    if (e !== undefined)
      return e;
    let n;
    if (t.namespaceURI === "http://www.w3.org/2000/svg" && (t.localName === "mask" || t.localName === "clipPath" ? n = false : qc.has(t.localName) && (n = true)), n === undefined) {
      let r = t.parentNode;
      n = !!(r && r.nodeType === 1) && xi(r);
    }
    return Ur.set(t, n), n;
  }
  function vi(t, e) {
    if (t?.nodeType !== 1 || e?.nodeType !== 1 || vn(t))
      return;
    let n = t.getAttribute?.("style"), r = !!(n && n.includes("var("));
    if (!r && t.attributes?.length) {
      let o = t.attributes;
      for (let s = 0;s < o.length; s++) {
        let a = o[s];
        if (a && typeof a.value == "string" && !a.value.startsWith("data:") && a.value.includes("var(")) {
          r = true;
          break;
        }
      }
    }
    let i = null;
    if (r)
      try {
        i = getComputedStyle(t);
      } catch {}
    if (r) {
      let o = t.style;
      if (o && o.length) {
        let s = new Set;
        for (let a = 0;a < o.length; a++) {
          let c = o[a];
          if (s.has(c))
            continue;
          s.add(c);
          let f = o.getPropertyValue(c);
          if (!f || !f.includes("var("))
            continue;
          let l = i && i.getPropertyValue(c);
          if (l)
            try {
              e.style.setProperty(c, l.trim(), o.getPropertyPriority(c));
            } catch {}
        }
      }
    }
    if (r && t.attributes?.length) {
      let o = t.attributes;
      for (let s = 0;s < o.length; s++) {
        let a = o[s];
        if (!a || typeof a.value != "string" || a.value.startsWith("data:") || !a.value.includes("var("))
          continue;
        let c = a.name, f = i && i.getPropertyValue(c);
        if (f)
          try {
            e.style.setProperty(c, f.trim());
          } catch {}
      }
    }
  }
  ht();
  ht();
  dt();
  de();
  bt();
  function ke(t) {
    return !!(!t || t.startsWith("data:") || t.startsWith("blob:"));
  }
  function Ce(t, e) {
    if (!t)
      return null;
    let n = 0;
    try {
      n = e ? e.getBoundingClientRect().width || e.width : 0;
    } catch {}
    n || (n = window.innerWidth || 1000);
    let r = [];
    for (let o of t.split(",")) {
      let s = o.trim().split(/\s+/);
      if (!s[0])
        continue;
      let a = s[1] || "", c = 1;
      /^\d*\.?\d+x$/i.test(a) ? c = parseFloat(a) : /^\d+w$/i.test(a) && (c = parseInt(a, 10) / n), r.push({ url: s[0], d: c });
    }
    if (!r.length)
      return null;
    r.sort((o, s) => o.d - s.d);
    let i = window.devicePixelRatio || 1;
    return (r.find((o) => o.d >= i) || r[r.length - 1]).url;
  }
  function ki(t, e) {
    let n = t.currentSrc || "";
    if (n && !ke(n))
      return n;
    let r = e.querySelectorAll("source[srcset]"), i = null;
    for (let o of r) {
      let s = o.getAttribute("srcset");
      if (!s || ke(s))
        continue;
      let a = o.getAttribute("type");
      if (a && !hr.test(a.trim()))
        continue;
      let c = o.getAttribute("media");
      if (c)
        try {
          if (window.matchMedia(c).matches)
            return Ce(s, t);
        } catch {}
      i || (i = Ce(s, t));
    }
    return i;
  }
  function Ci(t) {
    let e = [t.getAttribute("data-src"), t.getAttribute("data-lazy-src"), t.getAttribute("data-original"), t.getAttribute("data-hi-res-src")];
    for (let r of e)
      if (r && !ke(r))
        return r;
    let n = t.getAttribute("data-srcset") || t.getAttribute("data-lazy-srcset");
    if (n) {
      let r = n.split(",")[0].trim().split(/\s+/)[0];
      if (r && !ke(r))
        return r;
    }
    return null;
  }
  wt();
  function Gc(t, e) {
    if (t = t.trim(), !t)
      return t;
    let n = e ? `[data-sd-slotted~="${e}"]` : "[data-sd-slotted]";
    return t.endsWith(":not([data-sd-slotted])") || t.endsWith(`:not(${n})`) ? t : `${t}:not(${n})`;
  }
  var Xc = /::[a-zA-Z-]+(?:\([^)]*\))?$|:(?:before|after|first-letter|first-line)$/;
  var Yc = /^::?(?:before|after|first-letter)$/;
  function Kc(t, e, n = true, r) {
    return t.split(",").map((i) => i.trim()).filter(Boolean).map((i) => {
      if (i.startsWith(":where(") && i.includes("data-sd") || i.startsWith("@"))
        return i;
      let o = i.match(Xc);
      if (o && Yc.test(o[0]))
        return ":not(*)";
      let s = o ? i.slice(0, o.index).trim() : i, a = n ? Gc(s, r) : s;
      return `:where(${e} ${a})${o ? o[0] : ""}`;
    }).join(", ");
  }
  function Mi(t, e, n) {
    return t ? (t = t.replace(/:host-context\(([^)]+)\)/g, (r, i) => `:where(:where(${i.trim()}) ${e})`), t = t.replace(/:host\(([^)]+)\)/g, (r, i) => `:where(${e}:is(${i.trim()}))`), t = t.replace(/:host\b/g, `:where(${e})`), t = t.replace(/::slotted\(([^)]+)\)/g, (r, i) => `:where(${e} ${i.trim()})`), t = t.replace(/(^|})(\s*)([^@}{]+){/g, (r, i, o, s) => {
      let a = Kc(s, e, true, n);
      return `${i}${o}${a}{`;
    }), t) : "";
  }
  function Ei(t) {
    return t.shadowScopeSeq = (t.shadowScopeSeq || 0) + 1, `s${t.shadowScopeSeq}`;
  }
  function oe(t) {
    let e = "";
    for (let n of t)
      if (n.media && n.cssRules) {
        let r = false;
        try {
          r = window.matchMedia(n.conditionText || n.media.mediaText).matches;
        } catch {}
        r && (e += oe(n.cssRules));
      } else if (n.constructor?.name === "CSSSupportsRule")
        e += `@supports ${n.conditionText}{${oe(n.cssRules)}}`;
      else if (n.cssRules && n.cssRules.length && /@media/i.test(n.cssText)) {
        let r = n.cssText.slice(0, n.cssText.indexOf("{") + 1);
        e += r + (n.style ? n.style.cssText : "") + oe(n.cssRules) + "}";
      } else
        e += n.cssText + `
`;
    return e;
  }
  function _i(t) {
    let e = "";
    try {
      t.querySelectorAll("style").forEach((r) => {
        let i = null;
        try {
          i = r.sheet && r.sheet.cssRules;
        } catch {}
        e += (i ? oe(i) : r.textContent || "") + `
`;
      });
      let n = t.adoptedStyleSheets || [];
      for (let r of n)
        try {
          r && r.cssRules && (e += oe(r.cssRules));
        } catch {}
    } catch {}
    return e;
  }
  function Ri(t, e, n) {
    if (!e)
      return;
    let r = document.createElement("style");
    r.setAttribute("data-sd", n), r.textContent = e, t.insertBefore(r, t.firstChild || null);
  }
  function Fi(t, e, n = {}) {
    try {
      let r = null, i = W(t).content;
      if (i && i.includes("url(")) {
        let f = i.match(/url\(["']?([^"')]+)["']?\)/);
        f && (r = f[1]);
      }
      let o = t.closest?.("picture"), s = t.getAttribute("src") || "", a = t.getAttribute("srcset") || "", c = r || (o ? ki(t, o) : !a.trim() && s.startsWith("data:") ? s : t.currentSrc) || Ce(a, t) || t.src || "";
      if ((!c || ke(c)) && n.resolvePicturePlaceholders !== false) {
        let f = Ci(t);
        f && (c = f);
      }
      if (!c)
        return;
      e.getAttribute("src") !== c && e.setAttribute("src", c), e.removeAttribute("srcset"), e.removeAttribute("sizes"), e.loading = "eager", e.decoding = "sync";
    } catch {}
  }
  function Ti(t) {
    let e = new Set;
    if (!t)
      return e;
    let n = /var\(\s*(--[A-Za-z0-9_-]+)\b/g, r;
    for (;r = n.exec(t); )
      e.add(r[1]);
    return e;
  }
  function Qc(t, e) {
    try {
      let r = getComputedStyle(t).getPropertyValue(e).trim();
      if (r)
        return r;
    } catch {}
    try {
      let r = getComputedStyle(document.documentElement).getPropertyValue(e).trim();
      if (r)
        return r;
    } catch {}
    return "";
  }
  function $i(t, e, n) {
    let r = [];
    for (let i of e) {
      let o = Qc(t, i);
      o && r.push(`${i}: ${o};`);
    }
    return r.length ? `${n}{${r.join("")}}
` : "";
  }
  function Pi(t, e) {
    if (!t)
      return;
    let n = (r) => {
      let i = r.getAttribute("data-sd-slotted") || "";
      e ? ` ${i} `.includes(` ${e} `) || r.setAttribute("data-sd-slotted", i ? `${i} ${e}` : e) : r.setAttribute("data-sd-slotted", i);
    };
    t.nodeType === Node.ELEMENT_NODE && n(t), t.querySelectorAll?.("*").forEach(n);
  }
  async function Jc(t, e = 3) {
    let n = () => {
      try {
        return t.contentDocument || t.contentWindow?.document || null;
      } catch {
        return null;
      }
    }, r = n(), i = 0;
    for (;i < e && (!r || !r.body && !r.documentElement); )
      await new Promise((o) => setTimeout(o, 0)), r = n(), i++;
    return r && (r.body || r.documentElement) ? r : null;
  }
  function Zc(t) {
    let e = t.getBoundingClientRect(), n = 0, r = 0, i = 0, o = 0;
    try {
      let c = getComputedStyle(t);
      n = parseFloat(c.borderLeftWidth) || 0, r = parseFloat(c.borderRightWidth) || 0, i = parseFloat(c.borderTopWidth) || 0, o = parseFloat(c.borderBottomWidth) || 0;
    } catch {}
    let s = Math.max(0, Math.round(e.width - (n + r))), a = Math.max(0, Math.round(e.height - (i + o)));
    return { contentWidth: s, contentHeight: a, rect: e };
  }
  function mt(t) {
    let e = 0, n = 0;
    if (t.offsetWidth > 0 && (e = t.offsetWidth), t.offsetHeight > 0 && (n = t.offsetHeight), e === 0 || n === 0)
      try {
        let r = getComputedStyle(t);
        if (e === 0) {
          let i = parseFloat(r.width);
          !isNaN(i) && i > 0 && (e = i);
        }
        if (n === 0) {
          let i = parseFloat(r.height);
          !isNaN(i) && i > 0 && (n = i);
        }
      } catch {}
    if (e === 0 || n === 0)
      try {
        if (e === 0) {
          let r = parseFloat(t.getAttribute("width"));
          !isNaN(r) && r > 0 && (e = r);
        }
        if (n === 0) {
          let r = parseFloat(t.getAttribute("height"));
          !isNaN(r) && r > 0 && (n = r);
        }
      } catch {}
    if ((e === 0 || n === 0) && (t.naturalWidth || t.naturalHeight))
      try {
        e === 0 && t.naturalWidth > 0 && (e = t.naturalWidth), n === 0 && t.naturalHeight > 0 && (n = t.naturalHeight);
      } catch {}
    return { width: e, height: n };
  }
  function tl(t, e, n) {
    let r = t.defaultView, i = r ? r.scrollX : 0, o = r ? r.scrollY : 0, s = t.body ? t.body.scrollLeft : 0, a = t.body ? t.body.scrollTop : 0, c = t.documentElement ? t.documentElement.scrollLeft : 0, f = t.documentElement ? t.documentElement.scrollTop : 0, l = 0, u = 0, p = 0, h = 0;
    try {
      let m = r && t.body ? r.getComputedStyle(t.body) : null;
      m && (l = (parseFloat(m.marginTop) || 0) + (parseFloat(m.paddingTop) || 0), u = (parseFloat(m.marginRight) || 0) + (parseFloat(m.paddingRight) || 0), p = (parseFloat(m.marginBottom) || 0) + (parseFloat(m.paddingBottom) || 0), h = (parseFloat(m.marginLeft) || 0) + (parseFloat(m.paddingLeft) || 0));
    } catch {}
    let d = t.createElement("style");
    if (d.setAttribute("data-sd-iframe-pin", ""), J(d), d.textContent = `html {margin: 0 !important;padding: 0 !important;width: ${e}px !important;height: ${n}px !important;min-width: ${e}px !important;min-height: ${n}px !important;box-sizing: border-box !important;overflow: hidden !important;background-clip: border-box !important;}body {margin: 0 !important;padding: ${l}px ${u}px ${p}px ${h}px !important;width: ${e}px !important;height: ${n}px !important;min-width: ${e}px !important;min-height: ${n}px !important;box-sizing: border-box !important;overflow: hidden !important;background-clip: border-box !important;}`, (t.head || t.documentElement).appendChild(d), ne(t.documentElement), i || o)
      try {
        t.body && (t.body.scrollLeft = i, t.body.scrollTop = o), t.documentElement && (t.documentElement.scrollLeft || (t.documentElement.scrollLeft = i), t.documentElement.scrollTop || (t.documentElement.scrollTop = o));
      } catch {}
    return () => {
      try {
        d.remove();
      } catch {}
      try {
        r && typeof r.scrollTo == "function" && r.scrollTo(i, o), t.body && (t.body.scrollLeft = s, t.body.scrollTop = a), t.documentElement && (t.documentElement.scrollLeft = c, t.documentElement.scrollTop = f);
      } catch {}
      ne(t.documentElement);
    };
  }
  async function Hr(t, e, n) {
    let r = await Jc(t, 3);
    if (!r)
      throw new Error("iframe document not accessible/ready");
    let { contentWidth: i, contentHeight: o, rect: s } = Zc(t), a = n?.snap;
    if (!a || typeof a.toPng != "function")
      throw new Error("[snapdom] iframe capture requires the snapdom entrypoints on options.snap — capture through snapdom(el) (set automatically) or pass options.snap.");
    let c = { ...n, scale: 1, clip: null, __pinned: true }, f = tl(r, i, o), l;
    try {
      l = await a.toPng(r.documentElement, c);
    } finally {
      f();
    }
    l.style.display = "block", l.style.width = `${i}px`, l.style.height = `${o}px`;
    let u = document.createElement("div");
    return e.nodeMap.set(u, t), lt(t, u, e, n), u.style.overflow = "hidden", u.style.display = "block", u.style.width || (u.style.width = `${Math.round(s.width)}px`), u.style.height || (u.style.height = `${Math.round(s.height)}px`), u.appendChild(l), u;
  }
  function Ni(t) {
    try {
      let e = t && t.accentColor;
      if (e && e !== "auto" && e !== "none")
        return e;
      let n = t && t.color;
      if (n)
        return n;
    } catch {}
    return "#0a6ed1";
  }
  function Li(t) {
    let { width: e, height: n } = mt(t), r = t.getBoundingClientRect(), i;
    try {
      i = window.getComputedStyle(t);
    } catch {}
    let o = i ? parseFloat(i.width) : NaN, s = i ? parseFloat(i.height) : NaN, a = Number.isFinite(o) && o > 0 ? o : e || r.width || 128, c = Number.isFinite(s) && s > 0 ? s : n || r.height || 16, f = Number.parseFloat(t.min) || 0, l = Number.isFinite(Number.parseFloat(t.max)) ? Number.parseFloat(t.max) : 100, u = Number.parseFloat(t.value), p = l - f, h = p > 0 && Number.isFinite(u) ? Math.min(1, Math.max(0, (u - f) / p)) : 0.5, d = "middle";
    try {
      i && i.verticalAlign && (d = i.verticalAlign);
    } catch {}
    let m = document.createElement("div");
    m.setAttribute("data-snapdom-input-replacement", "range"), m.style.cssText = `display:inline-block;width:${a}px;height:${c}px;vertical-align:${d};flex-shrink:0;line-height:0;`;
    let g = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    g.setAttribute("width", String(a)), g.setAttribute("height", String(c)), g.setAttribute("viewBox", `0 0 ${a} ${c}`), g.style.overflow = "visible", m.appendChild(g);
    function y() {
      let b = Ni(i), w = !!t.disabled, C = Math.max(2, Math.min(4, c)), x = (c - C) / 2, S = Math.max(10, Math.min(14, Math.max(c, 10))), A = S / 2, v = A + h * Math.max(0, a - S);
      g.innerHTML = "";
      let M = (R, E, T, N) => {
        let O = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        O.setAttribute("x", String(R)), O.setAttribute("y", String(x)), O.setAttribute("width", String(Math.max(0, E))), O.setAttribute("height", String(C)), O.setAttribute("rx", String(C / 2)), O.setAttribute("fill", T), N && O.setAttribute("fill-opacity", N), g.appendChild(O);
      };
      M(0, a, "#808080", "0.4"), M(0, v, b);
      let k = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      k.setAttribute("cx", String(v)), k.setAttribute("cy", String(c / 2)), k.setAttribute("r", String(A)), k.setAttribute("fill", b), g.appendChild(k), w && g.setAttribute("opacity", "0.5"), m.style.setProperty("width", `${a}px`, "important"), m.style.setProperty("height", `${c}px`, "important"), m.style.setProperty("min-width", `${a}px`, "important"), m.style.setProperty("min-height", `${c}px`, "important");
    }
    return y(), { el: m, applyVisual: y };
  }
  function Ii(t) {
    let { width: e, height: n } = mt(t), r = t.getBoundingClientRect(), i;
    try {
      i = window.getComputedStyle(t);
    } catch {}
    let o = i ? parseFloat(i.width) : NaN, s = i ? parseFloat(i.height) : NaN, a = Math.round(e || r.width || 0), c = Math.round(n || r.height || 0), f = Number.isFinite(o) && o > 0 ? Math.round(o) : Math.max(12, a || 16), l = Number.isFinite(s) && s > 0 ? Math.round(s) : Math.max(12, c || 16), u = (t.type || "text").toLowerCase() === "checkbox", p = !!t.checked, h = !!t.indeterminate, m = Math.max(Math.min(f, l), 12), g = "middle";
    try {
      i && i.verticalAlign && (g = i.verticalAlign);
    } catch {}
    let y = document.createElement("div");
    y.setAttribute("data-snapdom-input-replacement", t.type || "checkbox"), y.style.cssText = `display:inline-block;width:${m}px;height:${m}px;vertical-align:${g};flex-shrink:0;line-height:0;`;
    let b = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    b.setAttribute("width", String(m)), b.setAttribute("height", String(m)), b.setAttribute("viewBox", `0 0 ${m} ${m}`), y.appendChild(b);
    function w() {
      let C = Ni(i), x = 2, S = x / 2, A = m - x;
      if (b.innerHTML = "", u) {
        let v = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        if (v.setAttribute("x", String(S)), v.setAttribute("y", String(S)), v.setAttribute("width", String(A)), v.setAttribute("height", String(A)), v.setAttribute("rx", "2"), v.setAttribute("ry", "2"), v.setAttribute("fill", p ? C : "none"), v.setAttribute("stroke", C), v.setAttribute("stroke-width", String(x)), b.appendChild(v), p) {
          let M = document.createElementNS("http://www.w3.org/2000/svg", "path");
          M.setAttribute("d", `M ${S + 2} ${m / 2} L ${m / 2 - 1} ${m - S - 2} L ${m - S - 2} ${S + 2}`), M.setAttribute("stroke", "white"), M.setAttribute("stroke-width", String(Math.max(1.5, x))), M.setAttribute("fill", "none"), M.setAttribute("stroke-linecap", "round"), M.setAttribute("stroke-linejoin", "round"), b.appendChild(M);
        } else if (h) {
          let M = document.createElementNS("http://www.w3.org/2000/svg", "rect"), k = Math.max(6, A - 4);
          M.setAttribute("x", String((m - k) / 2)), M.setAttribute("y", String((m - x) / 2)), M.setAttribute("width", String(k)), M.setAttribute("height", String(x)), M.setAttribute("fill", C), M.setAttribute("rx", "1"), b.appendChild(M);
        }
      } else {
        let v = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        if (v.setAttribute("cx", String(m / 2)), v.setAttribute("cy", String(m / 2)), v.setAttribute("r", String((m - x) / 2)), v.setAttribute("fill", p ? C : "none"), v.setAttribute("stroke", C), v.setAttribute("stroke-width", String(x)), b.appendChild(v), p) {
          let M = document.createElementNS("http://www.w3.org/2000/svg", "circle"), k = Math.max(2, (m - x * 2) * 0.35);
          M.setAttribute("cx", String(m / 2)), M.setAttribute("cy", String(m / 2)), M.setAttribute("r", String(k)), M.setAttribute("fill", "white"), b.appendChild(M);
        }
      }
      y.style.setProperty("width", `${m}px`, "important"), y.style.setProperty("height", `${m}px`, "important"), y.style.setProperty("min-width", `${m}px`, "important"), y.style.setProperty("min-height", `${m}px`, "important");
    }
    return w(), { el: y, applyVisual: w };
  }
  var tn = new ot(80);
  async function el(t) {
    if (P.resource?.has(t))
      return P.resource.get(t);
    if (tn.has(t))
      return tn.get(t);
    let e = (async () => {
      let n = await it(t, { as: "dataURL", silent: true });
      if (!n.ok || typeof n.data != "string")
        throw new Error(`[snapDOM] Failed to read blob URL: ${t}`);
      return P.resource?.set(t, n.data), n.data;
    })();
    tn.set(t, e);
    try {
      let n = await e;
      return tn.set(t, n), n;
    } catch (n) {
      throw tn.delete(t), n;
    }
  }
  var Ai = /\bblob:[^)"'\s]+/g;
  function kn(t) {
    return typeof t == "string" && t.startsWith("blob:");
  }
  function nl(t) {
    return (t || "").split(",").map((e) => e.trim()).filter(Boolean).map((e) => {
      let n = e.match(/^(\S+)(\s+.+)?$/);
      return n ? { url: n[1], desc: n[2] || "" } : null;
    }).filter(Boolean);
  }
  function rl(t) {
    return t.map((e) => e.desc ? `${e.url} ${e.desc.trim()}` : e.url).join(", ");
  }
  function en(t, e) {
    let n = t.querySelectorAll ? Array.from(t.querySelectorAll(e)) : [];
    return t.matches?.(e) && n.unshift(t), n;
  }
  async function Cn(t, e = null) {
    if (!t)
      return;
    let n = e, r = new Set, i = [], o = new Map, s = (m, g, y, b) => {
      r.add(y), i.push(() => {
        o.has(y) && (m.setAttribute(g, o.get(y)), b?.());
      });
    }, a = (m, g) => {
      if (!m || !m.includes("blob:"))
        return;
      let y = m.match(Ai) || [];
      if (y.length) {
        for (let b of y)
          r.add(b);
        i.push(() => {
          let b = m.replace(Ai, (w) => o.get(w) || w);
          b !== m && g(b);
        });
      }
    }, c = en(t, "img");
    for (let m of c)
      try {
        let y = m.getAttribute("src") || m.currentSrc || "";
        kn(y) && s(m, "src", y);
        let b = m.getAttribute("srcset");
        if (b && b.includes("blob:")) {
          let w = nl(b);
          for (let C of w)
            kn(C.url) && r.add(C.url);
          i.push(() => {
            let C = false;
            for (let x of w)
              o.has(x.url) && (x.url = o.get(x.url), C = true);
            C && m.setAttribute("srcset", rl(w));
          });
        }
      } catch (g) {
        D(n, "resolveBlobUrls for img failed", g);
      }
    let f = en(t, "image");
    for (let m of f)
      try {
        let g = "http://www.w3.org/1999/xlink", y = m.getAttribute("href") || m.getAttributeNS?.(g, "href");
        kn(y) && s(m, "href", y, () => m.removeAttributeNS?.(g, "href"));
      } catch (g) {
        D(n, "resolveBlobUrls for SVG image href failed", g);
      }
    let l = en(t, "[style*='blob:']");
    for (let m of l)
      try {
        let g = m.getAttribute("style");
        a(g, (y) => m.setAttribute("style", y));
      } catch (g) {
        D(n, "replaceBlobUrls in inline style failed", g);
      }
    let u = en(t, "style");
    for (let m of u)
      try {
        let g = m.textContent || "";
        a(g, (y) => {
          m.textContent = y;
        });
      } catch (g) {
        D(n, "replaceBlobUrls in style tag failed", g);
      }
    let p = ["poster"];
    for (let m of p) {
      let g = en(t, `[${m}^='blob:']`);
      for (let y of g)
        try {
          let b = y.getAttribute(m);
          kn(b) && s(y, m, b);
        } catch (b) {
          D(n, `resolveBlobUrls for ${m} failed`, b);
        }
    }
    if (!r.size)
      return;
    let h = [...r], d = 0;
    await Promise.all(Array.from({ length: Math.min(4, h.length) }, async () => {
      for (;d < h.length; ) {
        let m = h[d++];
        try {
          o.set(m, await el(m));
        } catch (g) {
          D(n, "blobUrlToDataUrl failed; keeping original URL", g);
        }
      }
    }));
    for (let m of i)
      try {
        m();
      } catch (g) {
        D(n, "resolved blob URL write failed", g);
      }
  }
  kt();
  var Wi = new Set(["rgba(0, 0, 0, 0)", "transparent"]);
  var zr = "Highlight";
  function Oi(t) {
    let n = (t.ownerDocument || document).getSelection?.();
    if (!n || n.isCollapsed || n.rangeCount === 0)
      return null;
    let r = [];
    for (let i = 0;i < n.rangeCount; i += 1) {
      let o = n.getRangeAt(i);
      if (!o.collapsed)
        try {
          o.intersectsNode(t) && r.push(o);
        } catch {}
    }
    return r.length ? { ranges: r, styles: new Map } : null;
  }
  function ol(t, e) {
    if (e.styles.has(t))
      return e.styles.get(t);
    let n;
    try {
      let r = getComputedStyle(t);
      if (r.userSelect === "none" || r.webkitUserSelect === "none" || r.getPropertyValue("-webkit-user-select") === "none")
        return e.styles.set(t, null), null;
      let i = getComputedStyle(t, "::selection"), o = [], s = i.backgroundColor, a = s && !Wi.has(s) && s !== r.backgroundColor;
      o.push(`background-color:${a ? s : zr}`), i.color && i.color !== r.color && o.push(`color:${i.color}`, `-webkit-text-fill-color:${i.color}`), i.textShadow && i.textShadow !== r.textShadow && o.push(`text-shadow:${i.textShadow}`), i.textDecorationLine && i.textDecorationLine !== "none" && i.textDecorationLine !== r.textDecorationLine && o.push(`text-decoration:${i.textDecorationLine} ${i.textDecorationStyle || "solid"} ${i.textDecorationColor || "currentcolor"}`), n = o.join(";");
    } catch {
      n = `background-color:${zr}`;
    }
    return e.styles.set(t, n), n;
  }
  function Di(t, e) {
    let n = t.data;
    if (!n)
      return null;
    let r = t.parentElement;
    if (!r)
      return null;
    let i = [];
    for (let f of e.ranges) {
      let l = false;
      try {
        l = f.intersectsNode(t);
      } catch {}
      if (!l)
        continue;
      let u = f.startContainer === t ? f.startOffset : 0, p = f.endContainer === t ? f.endOffset : n.length;
      p > u && i.push([u, p]);
    }
    if (i.length === 0)
      return null;
    let o = ol(r, e);
    if (!o)
      return null;
    i.sort((f, l) => f[0] - l[0]);
    let s = t.ownerDocument || document, a = s.createDocumentFragment(), c = 0;
    for (let [f, l] of i) {
      f > c && a.append(s.createTextNode(n.slice(c, f)));
      let u = s.createElement("span");
      u.setAttribute("data-snapdom-selection", ""), u.setAttribute("style", `all:unset;${o}`), u.textContent = n.slice(f, l), a.append(u), c = l;
    }
    return c < n.length && a.append(s.createTextNode(n.slice(c))), a;
  }
  var An = (t) => Number.parseFloat(t) || 0;
  var il = ["font-family", "font-size", "font-weight", "font-style", "font-variant", "font-stretch", "letter-spacing", "word-spacing", "text-transform", "text-indent", "text-align", "line-height", "tab-size", "direction"];
  function sl(t, e) {
    try {
      let r = getComputedStyle(t, "::selection").backgroundColor;
      if (r && !Wi.has(r) && r !== e.backgroundColor)
        return r;
    } catch {}
    return zr;
  }
  function Bi(t, e) {
    let n = t.ownerDocument || document;
    if (n.activeElement !== t)
      return;
    let r = null, i = null;
    try {
      r = t.selectionStart, i = t.selectionEnd;
    } catch {
      return;
    }
    if (r == null || i == null || r === i)
      return;
    let o = t.value || "";
    if (t.localName === "input" && t.type === "password" && (o = "•".repeat(o.length)), !o)
      return;
    let s = getComputedStyle(t), a = t.localName === "textarea", c = An(s.paddingLeft), f = An(s.paddingTop), l = t.clientWidth - c - An(s.paddingRight), u = t.clientHeight - f - An(s.paddingBottom), p = n.createElement("div");
    p.style.cssText = "position:absolute;top:0;left:-99999px;visibility:hidden;margin:0;border:0;padding:0;box-sizing:content-box;";
    for (let g of il)
      p.style.setProperty(g, s.getPropertyValue(g));
    a ? (p.style.whiteSpace = "pre-wrap", p.style.overflowWrap = "break-word", p.style.width = `${Math.max(0, l)}px`) : p.style.whiteSpace = "pre";
    let h = n.createElement("span");
    h.textContent = o.slice(r, i), p.append(n.createTextNode(o.slice(0, r)), h, n.createTextNode(o.slice(i))), n.body.appendChild(p);
    let d = [];
    try {
      let g = p.getBoundingClientRect(), y = -t.scrollLeft, b = -t.scrollTop;
      if (!a) {
        b += Math.max(0, (u - g.height) / 2);
        let w = s.direction === "rtl", C = s.textAlign;
        C === "start" ? C = w ? "right" : "left" : C === "end" && (C = w ? "left" : "right");
        let x = l - g.width;
        x > 0 && (C === "right" ? y += x : C === "center" && (y += x / 2));
      }
      for (let w of h.getClientRects())
        w.width <= 0 || w.height <= 0 || d.push({ x: c + (w.left - g.left) + y, y: f + (w.top - g.top) + b, width: w.width, height: w.height });
    } finally {
      p.remove();
    }
    if (d.length === 0)
      return;
    let m = sl(t, s);
    e.__snapdomFieldSelection = { images: d.map(() => `linear-gradient(${m},${m})`), positions: d.map((g) => `${g.x}px ${g.y}px`), sizes: d.map((g) => `${g.width}px ${g.height}px`), repeats: d.map(() => "no-repeat"), origins: d.map(() => "padding-box"), clips: d.map(() => "padding-box"), base: { image: s.backgroundImage, position: s.backgroundPosition, size: s.backgroundSize, repeat: s.backgroundRepeat, origin: s.backgroundOrigin, clip: s.backgroundClip } };
  }
  function Ui(t) {
    for (let e of t.keys()) {
      let n = e.__snapdomFieldSelection;
      if (!n)
        continue;
      delete e.__snapdomFieldSelection;
      let { images: r, positions: i, sizes: o, repeats: s, origins: a, clips: c, base: f } = n, l = e.style.backgroundImage || f.image;
      l && l !== "none" ? (r.push(l), i.push(e.style.backgroundPosition || f.position), o.push(e.style.backgroundSize || f.size), s.push(e.style.backgroundRepeat || f.repeat), a.push(e.style.backgroundOrigin || f.origin), c.push(e.style.backgroundClip || f.clip)) : (r.push("linear-gradient(transparent,transparent)"), i.push("0% 0%"), o.push("auto"), s.push("repeat"), a.push(f.origin || "padding-box"), c.push(f.clip || "border-box")), e.style.backgroundImage = r.join(","), e.style.backgroundPosition = i.join(","), e.style.backgroundSize = o.join(","), e.style.backgroundRepeat = s.join(","), e.style.backgroundOrigin = a.join(","), e.style.backgroundClip = c.join(",");
    }
  }
  wt();
  var jr = new Map;
  var Hi = new Set(["IFRAME"]);
  function Ae(t, e) {
    jr.set(String(t).toUpperCase(), e);
  }
  function Mn(t) {
    let e = W(t), n = e.display;
    if (n === "none")
      return null;
    let r = /^(block|inline-block|flow-root|flex|inline-flex|grid|inline-grid|list-item)$/.test(n), i = (h) => parseFloat(h) || 0, o = (h, d, m, g, y) => {
      if (!r || !h?.endsWith("px"))
        return null;
      let b = parseFloat(h);
      if (!Number.isFinite(b) || b < 0)
        return null;
      if (e.boxSizing === "border-box")
        return b;
      let w = g - y - m;
      return b + d + m + (w > 0 && b + d < y + w / 2 ? w : 0);
    }, [s, a, c, f] = /scroll|auto/.test(e.overflow) ? [t.offsetWidth, t.clientWidth, t.offsetHeight, t.clientHeight] : [0, 0, 0, 0], l = o(e.width, i(e.paddingLeft) + i(e.paddingRight), i(e.borderLeftWidth) + i(e.borderRightWidth), s, a), u = o(e.height, i(e.paddingTop) + i(e.paddingBottom), i(e.borderTopWidth) + i(e.borderBottomWidth), c, f);
    if (l === null || u === null) {
      let { width: h, height: d } = mt(t), m = h, g = d;
      if (l === null && !m || u === null && !g) {
        let y = t.getBoundingClientRect();
        m ||= y.width || 0, g ||= y.height || 0;
      }
      l ??= m, u ??= g;
    }
    let p = document.createElement("div");
    return p.style.cssText = `display:${n === "inline" ? "inline-block" : n};box-sizing:border-box;width:${l}px;height:${u}px;visibility:hidden;`, p;
  }
  var En = 200;
  var al = new Set(["img", "canvas", "video", "iframe", "object", "embed"]);
  function zi(t, e) {
    return t.right >= e.left - En && t.left <= e.right + En && t.bottom >= e.top - En && t.top <= e.bottom + En;
  }
  function cl(t, e) {
    if (t === e.root)
      return false;
    let n;
    try {
      n = t.getBoundingClientRect();
    } catch {
      return false;
    }
    if (n.width === 0 && n.height === 0)
      return false;
    let r = W(t);
    if (r.display === "inline" && !al.has((t.localName || "").toLowerCase()))
      return false;
    let i = e.rect, o = t.scrollWidth || 0, s = t.scrollHeight || 0, a = { left: r.direction === "rtl" ? Math.min(n.left, n.right - o) : n.left, top: n.top, right: Math.max(n.right, n.left + o), bottom: Math.max(n.bottom, n.top + s) }, c = r.writingMode || "";
    if ((c.startsWith("vertical") || c.startsWith("sideways")) && (a.top = Math.min(n.top, n.bottom - s), a.left = Math.min(a.left, n.right - o)), zi(a, i))
      return false;
    let f = (t.ownerDocument || document).createTreeWalker(t, NodeFilter.SHOW_ELEMENT);
    for (;f.nextNode(); ) {
      let l = f.currentNode.getBoundingClientRect();
      if ((l.width > 0 || l.height > 0) && zi(l, i))
        return false;
    }
    return true;
  }
  function ll(t, e, n) {
    let r = t.cloneNode(false);
    t.tagName === "IMG" && (r.removeAttribute("src"), r.removeAttribute("srcset"), r.removeAttribute("sizes")), lt(t, r, e, n);
    let { width: i, height: o } = mt(t);
    i > 0 && (r.style.width = `${i}px`, r.style.minWidth = `${i}px`, r.style.maxWidth = `${i}px`), o > 0 && (r.style.height = `${o}px`, r.style.minHeight = `${o}px`, r.style.maxHeight = `${o}px`), r.style.visibility = "hidden";
    let s = t.parentElement ? W(t.parentElement).display : "", a = W(t).position;
    if (!/flex|grid|table/.test(s) && (a === "static" || a === "relative")) {
      let c = (p) => {
        let h = W(p);
        return h.display !== "none" && h.position !== "absolute" && h.position !== "fixed";
      }, f = t.getBoundingClientRect(), l = t.previousElementSibling;
      for (;l && !c(l); )
        l = l.previousElementSibling;
      if (l) {
        let p = f.top - l.getBoundingClientRect().bottom;
        p >= 0 && (r.style.marginTop = `${p}px`);
      }
      let u = t.nextElementSibling;
      for (;u && !c(u); )
        u = u.nextElementSibling;
      if (u) {
        let p = u.getBoundingClientRect().top - f.bottom;
        p >= 0 && (r.style.marginBottom = `${p}px`);
      }
    }
    return r.style.boxSizing = "border-box", r;
  }
  async function ie(t, e, n) {
    if (!t)
      throw new Error("Invalid node");
    let r = new Set, i = null, o = null;
    if (t.nodeType === Node.ELEMENT_NODE) {
      let l = (t.localName || t.tagName || "").toLowerCase(), u = Ut(t);
      if (u && (t.id === "snapdom-sandbox" || t.hasAttribute("data-snapdom-sandbox")) || t !== n.element && u || Cr.has(l))
        return null;
      if (l === "foreignobject" && t.parentElement?.closest?.("foreignObject"))
        return D(e, "Nested <foreignObject> skipped (SVG spec limitation — not rendered by browsers)"), null;
      if (l === "source" && t.parentElement?.localName === "picture")
        return null;
    }
    if (t.nodeType === Node.TEXT_NODE) {
      if (e.selection) {
        let l = Di(t, e.selection);
        if (l)
          return l;
      }
      return t.cloneNode(true);
    }
    if (t.nodeType !== Node.ELEMENT_NODE)
      return t.cloneNode(true);
    if (t.getAttribute("data-capture") === "exclude") {
      if (n.excludeMode === "hide")
        return Mn(t);
      if (n.excludeMode === "remove")
        return null;
    }
    if (n.exclude && Array.isArray(n.exclude))
      for (let l of n.exclude)
        try {
          if (t.matches?.(l)) {
            if (n.excludeMode === "hide")
              return Mn(t);
            if (n.excludeMode === "remove")
              return null;
          }
        } catch (u) {
          console.warn(`Invalid selector in exclude option: ${l}`, u);
        }
    if (n.excludePredicates)
      for (let l of n.excludePredicates)
        try {
          if (l(t))
            return n.excludeMode === "remove" ? null : Mn(t);
        } catch (u) {
          console.warn("Error in exclude predicate:", u);
        }
    if (typeof n.filter == "function")
      try {
        if (!n.filter(t)) {
          if (n.filterMode === "hide")
            return Mn(t);
          if (n.filterMode === "remove")
            return null;
        }
      } catch (l) {
        console.warn("Error in filter function:", l);
      }
    if (e.clip && cl(t, e.clip))
      return ll(t, e, n);
    if (n.__resolveNodeHooks)
      for (let l of n.__resolveNodeHooks) {
        let u;
        try {
          u = await l(t, n);
        } catch (p) {
          D(e, "resolveNode plugin hook failed", p);
        }
        if (u === null)
          return null;
        if (u?.nodeType)
          return u.nodeType === Node.ELEMENT_NODE && (e.nodeMap.set(u, t), lt(t, u, e, n)), u;
      }
    {
      let l = Hi.has(t.tagName) && jr.get(t.tagName);
      if (l) {
        let u = await l(t, e, n);
        if (u !== undefined)
          return u;
      }
    }
    if (t.getAttribute("data-capture") === "placeholder") {
      let l = t.cloneNode(false);
      e.nodeMap.set(l, t), lt(t, l, e, n);
      let u = document.createElement("div");
      return u.textContent = t.getAttribute("data-placeholder-text") || "", u.style.cssText = "color:#666;font-size:12px;text-align:center;line-height:1.4;padding:0.5em;box-sizing:border-box;", l.appendChild(u), l;
    }
    {
      let l = !Hi.has(t.tagName) && jr.get(t.tagName);
      if (l) {
        let u = await l(t, e, n);
        if (u !== undefined)
          return u;
      }
    }
    let s;
    try {
      if (s = t.cloneNode(false), vi(t, s), e.nodeMap.set(s, t), t.tagName === "IMG") {
        Fi(t, s, n);
        try {
          let l = window.getComputedStyle(t), u = parseFloat(l.width), p = parseFloat(l.height);
          if (!(u > 0) || !(p > 0)) {
            let m = mt(t), g = (b) => parseFloat(l.getPropertyValue(b)) || 0, y = l.getPropertyValue("box-sizing") === "border-box";
            u > 0 || (u = m.width - (y ? 0 : g("padding-left") + g("padding-right") + g("border-left-width") + g("border-right-width"))), p > 0 || (p = m.height - (y ? 0 : g("padding-top") + g("padding-bottom") + g("border-top-width") + g("border-bottom-width")));
          }
          let h = Math.round((u || 0) * 1000) / 1000, d = Math.round((p || 0) * 1000) / 1000;
          h && (s.dataset.snapdomWidth = String(h)), d && (s.dataset.snapdomHeight = String(d));
        } catch (l) {
          D(e, "getUnscaledDimensions for IMG failed", l);
        }
        try {
          let l = t.getAttribute("style") || "", u = window.getComputedStyle(t), p = (w) => {
            let C = l.match(new RegExp(`${w}\\s*:\\s*([^;]+)`, "i")), x = C ? C[1].trim() : u.getPropertyValue(w);
            return /%|auto/i.test(String(x || ""));
          }, h = parseFloat(s.dataset.snapdomWidth || "0") || 0, d = parseFloat(s.dataset.snapdomHeight || "0") || 0, m = p("width") || !(h > 0), g = p("height") || !(d > 0);
          m && h > 0 && (s.style.width = `${h}px`), g && d > 0 && (s.style.height = `${d}px`);
          let y = u.getPropertyValue("object-fit"), b = u.getPropertyValue("object-position");
          y && y !== "fill" ? (s.style.objectFit = y, b && (s.style.objectPosition = b)) : (h > 0 && (s.style.minWidth = `${h}px`), d > 0 && (s.style.minHeight = `${d}px`));
        } catch (l) {
          D(e, "IMG dimension freeze failed", l);
        }
      }
    } catch (l) {
      throw console.error("[Snapdom] Failed to clone node:", t, l), l;
    }
    let a = null;
    if (rt(t, "textarea")) {
      let { width: l, height: u } = mt(t), p = l || t.getBoundingClientRect().width || 0, h = u || t.getBoundingClientRect().height || 0;
      p && (s.style.width = `${p}px`), h && (s.style.height = `${h}px`);
    }
    if (rt(t, "input")) {
      let l = (t.type || "text").toLowerCase();
      if ((l === "checkbox" || l === "radio") && (zt() || t.indeterminate)) {
        let { el: p, applyVisual: h } = Ii(t);
        e.nodeMap.set(p, t), a = h, s = p;
      } else if (l === "range" && (zt() || Y())) {
        let { el: p, applyVisual: h } = Li(t);
        e.nodeMap.set(p, t), a = h, s = p;
      } else if (l === "color" && Y()) {
        let p = s, h = t.value || "#000000";
        a = () => {
          p.style.setProperty("background-color", h, "important"), p.style.setProperty("color", "transparent", "important"), p.style.setProperty("-webkit-text-fill-color", "transparent", "important"), p.style.setProperty("appearance", "none", "important"), p.style.setProperty("-webkit-appearance", "none", "important");
        }, p.removeAttribute("value");
      } else if ((l === "date" || l === "time" || l === "datetime-local") && (zt() || Y())) {
        s.setAttribute("type", "text");
        let p = t.value;
        l === "date" && t.valueAsDate && (p = t.valueAsDate.toLocaleDateString(undefined, { timeZone: "UTC" })), s.value = p, s.setAttribute("value", p);
      } else {
        let p = Ve(t) ? yr(t.value) : t.value;
        s.value = p, s.setAttribute("value", p), t.checked !== undefined && (s.checked = t.checked, t.checked ? s.setAttribute("checked", "") : s.removeAttribute("checked"), t.indeterminate && (s.indeterminate = t.indeterminate));
      }
    }
    if ((rt(t, "input") || rt(t, "textarea")) && !t.value && t.placeholder)
      try {
        let l = window.getComputedStyle(t, "::placeholder"), u = l && l.color;
        if (u && u !== "rgba(0, 0, 0, 0)") {
          let p = "snapdom-ph-" + (Math.random() * 1e6 | 0);
          s.classList.add(p);
          let h = document.createElement("style");
          h.textContent = `.${p}::placeholder{color:${u}!important;opacity:${l.opacity || "1"}!important;-webkit-text-fill-color:${u}!important;}`, s.prepend(h);
        }
      } catch {}
    if (rt(t, "select") && (i = new Set(Array.from(t.options).filter((l) => l.selected))), rt(t, "textarea") && (o = t.value), rt(t, "input") || rt(t, "textarea") || rt(t, "select")) {
      t.disabled && s.setAttribute("disabled", ""), t.required && s.setAttribute("required", ""), t.readOnly && s.setAttribute("readonly", "");
      let l = t;
      l.min !== undefined && l.min !== "" && s.setAttribute("min", l.min), l.max !== undefined && l.max !== "" && s.setAttribute("max", l.max), l.pattern !== undefined && l.pattern !== "" && s.setAttribute("pattern", l.pattern);
      let u = t.getAttribute("aria-invalid");
      u !== null && s.setAttribute("aria-invalid", u);
    }
    if (vn(t) || lt(t, s, e, n), a && a(), n.captureSelection && (rt(t, "input") || rt(t, "textarea")))
      try {
        Bi(t, s);
      } catch (l) {
        D(e, "inlineTextFieldSelection failed", l);
      }
    if (Bt(t) && !vn(t)) {
      let l = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "marker", "marker-start", "marker-mid", "marker-end", "visibility", "display", "color"];
      try {
        let u = window.getComputedStyle(t);
        for (let p of l) {
          let h = u.getPropertyValue(p);
          h && s.style.setProperty(p, h);
        }
      } catch {}
    }
    if (t.shadowRoot) {
      Or(t.shadowRoot);
      try {
        let b = t.shadowRoot.querySelectorAll("slot");
        for (let w of b) {
          let C = w.assignedNodes?.() || [];
          for (let x of C)
            r.add(x);
        }
      } catch {}
      let l = Ei(e), u = `[data-sd="${l}"]`;
      e.shadowScopes ||= new WeakMap, e.shadowScopes.set(t.shadowRoot, l);
      try {
        s.setAttribute("data-sd", l);
      } catch {}
      let p = _i(t.shadowRoot);
      !e.__shadowPseudo && /::?(?:before|after|first-l|marker)|counter/.test(p) && (e.__shadowPseudo = true);
      let h = Mi(p, u, l), d = Ti(p), m = $i(t, d, u);
      Ri(s, m + h, l);
      let g = document.createDocumentFragment(), y = await Promise.all(Array.from(t.shadowRoot.childNodes).map((b) => b.nodeType === Node.ELEMENT_NODE && b.tagName === "STYLE" ? null : ie(b, e, n).catch(() => null)));
      g.append(...y.filter((b) => !!b)), s.appendChild(g);
    }
    if (t.tagName === "SLOT") {
      let l = e.shadowScopes?.get(t.getRootNode()), u = t.assignedNodes?.() || [], p = u.length ? t.assignedNodes?.({ flatten: true }) || u : [], h = p.length ? p : Array.from(t.childNodes), d = document.createDocumentFragment(), m = await Promise.all(h.map((g) => ie(g, e, n).then((y) => (y && u.length && Pi(y, l), y || null)).catch(() => null)));
      return d.append(...m.filter((g) => !!g)), d;
    }
    let c = (l) => r.has(l) || t.shadowRoot && !l.assignedSlot, f = await Promise.all(Array.from(t.childNodes).map((l) => c(l) ? null : ie(l, e, n).catch(() => null)));
    if (s.append(...f.filter((l) => !!l)), i && rt(s, "select")) {
      let l = false;
      for (let u of s.options) {
        let p = i.has(e.nodeMap.get(u));
        u.selected = p, p ? u.setAttribute("selected", "") : u.removeAttribute("selected"), l ||= p;
      }
      if (!l && !s.multiple) {
        let u = s.ownerDocument.createElement("option");
        u.hidden = true, u.style.setProperty("display", "none", "important"), u.setAttribute("selected", ""), u.value = "", s.appendChild(u);
      }
    }
    return o !== null && rt(s, "textarea") && (s.textContent = o), s;
  }
  async function fl(t, e, n) {
    let r = false;
    try {
      r = !!(t.contentDocument || t.contentWindow?.document);
    } catch (i) {
      D(e, "iframe same-origin probe failed", i);
    }
    if (r)
      try {
        return await Hr(t, e, n);
      } catch (i) {
        console.warn("[SnapDOM] iframe rasterization failed, fallback:", i);
      }
    if (r || console.warn("[snapdom] cross-origin <iframe> skipped (its document cannot be read). Captured as a placeholder that keeps the frame's box; pass { placeholders: false } for an invisible spacer.", t), n.placeholders) {
      let { width: i, height: o } = mt(t), s = document.createElement("div");
      return s.style.cssText = `width:${i}px;height:${o}px;background-image:repeating-linear-gradient(45deg,#ddd,#ddd 5px,#f9f9f9 5px,#f9f9f9 10px);display:flex;align-items:center;justify-content:center;font-size:12px;color:#555;border:1px solid #aaa;`, lt(t, s, e, n), s;
    } else {
      let { width: i, height: o } = mt(t), s = document.createElement("div");
      return s.style.cssText = `display:inline-block;width:${i}px;height:${o}px;visibility:hidden;`, lt(t, s, e, n), s;
    }
  }
  function nn(t) {
    try {
      let e = Math.max(1, Math.min(32, t.width)), n = Math.max(1, Math.min(32, t.height)), r = document.createElement("canvas");
      r.width = e, r.height = n;
      let i = r.getContext("2d", { willReadFrequently: true });
      if (!i)
        return false;
      i.drawImage(t, 0, 0, e, n);
      let o = i.getImageData(0, 0, e, n).data;
      for (let s = 3;s < o.length; s += 4)
        if (o[s] !== 0)
          return false;
      return true;
    } catch {
      return false;
    }
  }
  var ul = 0.95;
  function dl(t, e, n) {
    try {
      let r = t.getImageData(0, 0, e, n).data;
      for (let i = 3;i < r.length; i += 4)
        if (r[i] !== 255)
          return false;
      return true;
    } catch {
      return false;
    }
  }
  async function pl(t, e, n) {
    let r = "";
    try {
      let a = nn(t);
      a && (await pt(), a = nn(t));
      let c = null;
      if (!a) {
        c = t.getContext("2d", { willReadFrequently: true });
        try {
          c && c.getImageData(0, 0, 1, 1);
        } catch {}
        Y() && await pt();
      }
      if (r = t.toDataURL("image/png"), !r || r === "data:,") {
        try {
          c && c.getImageData(0, 0, 1, 1);
        } catch {}
        if (await pt(), r = t.toDataURL("image/png"), !r || r === "data:,") {
          let f = document.createElement("canvas");
          f.width = t.width, f.height = t.height;
          let l = f.getContext("2d");
          l && (l.drawImage(t, 0, 0), r = f.toDataURL("image/png"));
        }
      }
    } catch (a) {
      D(e, "Canvas toDataURL failed, using empty/fallback", a);
    }
    n && n.debug && r && nn(t) && D(e, "canvas is empty at capture time — capture it after its first frame is drawn", t);
    let i = document.createElement("img");
    try {
      i.decoding = "sync", i.loading = "eager";
    } catch (a) {
      D(e, "img decoding/loading hints failed", a);
    }
    r && (i.src = r), i.width = t.width, i.height = t.height;
    let { width: o, height: s } = mt(t);
    return o > 0 && (i.style.width = `${o}px`), s > 0 && (i.style.height = `${s}px`), e.nodeMap.set(i, t), lt(t, i, e, n), i;
  }
  async function hl(t, e, n) {
    let r = "", i = t.poster && t.paused && !t.currentTime && !t.played.length, o = document.createElement("img");
    try {
      o.decoding = "sync", o.loading = "eager";
    } catch {}
    if (!i)
      try {
        let c = document.createElement("canvas");
        c.width = t.videoWidth || t.offsetWidth || 320, c.height = t.videoHeight || t.offsetHeight || 240;
        let f = c.getContext("2d");
        f && (f.drawImage(t, 0, 0, c.width, c.height), r = c.toDataURL(dl(f, c.width, c.height) ? "image/jpeg" : "image/png", ul), (!r || r === "data:,") && (r = ""));
      } catch (c) {
        D(e, "Video frame capture failed, using poster fallback", c);
      }
    r ? o.src = r : t.poster && (o.src = t.poster), o.width = t.videoWidth || t.offsetWidth || 0, o.height = t.videoHeight || t.offsetHeight || 0;
    let { width: s, height: a } = mt(t);
    return s > 0 && (o.style.width = `${s}px`), a > 0 && (o.style.height = `${a}px`), o.style.objectFit = "contain", e.nodeMap.set(o, t), lt(t, o, e, n), o;
  }
  async function ml(t, e, n) {
    if (!t.controls)
      return;
    let { width: r, height: i } = mt(t), o = Math.round(r || t.offsetWidth || 300), s = Math.round(i || t.offsetHeight || 54), a = s / 2, c = Math.max(4, s * 0.16), f = s * 0.34, l = o - s * 0.34, u = f + c + s * 0.55, p = Math.max(0, l - s * 0.7 - u), h = Math.max(9, Math.round(s * 0.24)), d = `<svg xmlns="http://www.w3.org/2000/svg" width="${o}" height="${s}" viewBox="0 0 ${o} ${s}"><rect width="${o}" height="${s}" rx="${Math.min(s / 2, 10)}" fill="#f1f3f4"/><path d="M ${f} ${a - c} L ${f + c} ${a} L ${f} ${a + c} Z" fill="#5f6368"/><rect x="${u}" y="${a - 1.5}" width="${p}" height="3" rx="1.5" fill="#bdc1c6"/><circle cx="${u}" cy="${a}" r="${Math.max(3, s * 0.09)}" fill="#5f6368"/><text x="${l}" y="${a}" fill="#5f6368" font-family="sans-serif" font-size="${h}" text-anchor="end" dominant-baseline="central">0:00</text></svg>`, m = document.createElement("img");
    try {
      m.decoding = "sync", m.loading = "eager";
    } catch {}
    return m.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d)}`, m.width = o, m.height = s, m.style.width = `${o}px`, m.style.height = `${s}px`, e.nodeMap.set(m, t), lt(t, m, e, n), m;
  }
  async function ji(t, e, n) {
    let r = t.getAttribute("data") || t.getAttribute("src") || "", i = (t.getAttribute("type") || "").toLowerCase(), o = /^image\//.test(i) || /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(\?|#|$)/i.test(r);
    if (r && o) {
      let a = document.createElement("img");
      try {
        a.decoding = "sync", a.loading = "eager";
      } catch {}
      a.src = r;
      let { width: c, height: f } = mt(t);
      return c > 0 && (a.style.width = `${c}px`), f > 0 && (a.style.height = `${f}px`), e.nodeMap.set(a, t), lt(t, a, e, n), a;
    }
    let s = null;
    try {
      s = t.contentDocument;
    } catch {}
    if (s)
      try {
        let a = await Hr(t, e, n);
        if (a)
          return a;
      } catch {}
    r && console.warn(`[snapdom] <${t.localName}> content could not be captured (${i || "unknown type"}): rendering its fallback children`);
  }
  Ae("IFRAME", fl);
  Ae("CANVAS", pl);
  Ae("VIDEO", hl);
  Ae("AUDIO", ml);
  Ae("OBJECT", ji);
  Ae("EMBED", ji);
  ht();
  bt();
  ye();
  dt();
  wt();
  var gl = [/font\s*awesome/i, /material\s*icons/i, /ionicons/i, /glyphicons/i, /feather/i, /bootstrap\s*icons/i, /remix\s*icons/i, /heroicons/i, /layui/i, /lucide/i];
  var Me = Object.assign({ materialIconsFilled: "https://fonts.gstatic.com/s/materialicons/v48/flUhRq6tzZclQEJ-Vdg-IuiaDsNcIhQ8tQ.woff2", materialIconsOutlined: "https://fonts.gstatic.com/s/materialiconsoutlined/v110/gok-H7zzDkdnRel8-DQ6KAXJ69wP1tGnf4ZGhUcel5euIg.woff2", materialIconsRound: "https://fonts.gstatic.com/s/materialiconsround/v109/LDItaoyNOAY6Uewc665JcIzCKsKc_M9flwmPq_HTTw.woff2", materialIconsSharp: "https://fonts.gstatic.com/s/materialiconssharp/v110/oPWQ_lt5nv4pWNJpghLP75WiFR4kLh3kvmvRImcycg.woff2" }, typeof window < "u" && window.__SNAPDOM_ICON_FONTS__ || {});
  function yl(t) {
    return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function Vi(t) {
    let e = Array.isArray(t) ? t : t ? [t] : [], n = [];
    for (let r of e)
      r instanceof RegExp ? n.push(r) : typeof r == "string" ? n.push(new RegExp(yl(r), "i")) : console.warn("[snapdom] Ignored invalid iconFont value:", r);
    return n;
  }
  function At(t, e) {
    let n = typeof t == "string" ? t : "";
    for (let r of gl)
      if (r.test(n))
        return true;
    if (e) {
      for (let r of e)
        if (r instanceof RegExp && r.test(n))
          return true;
    }
    return !!(/icon/i.test(n) || /glyph/i.test(n) || /symbols/i.test(n) || /feather/i.test(n) || /fontawesome/i.test(n));
  }
  function Vr(t, e) {
    if (typeof t != "string" || !t)
      return false;
    let n;
    try {
      n = new URL(t, typeof location < "u" ? location.href : undefined);
    } catch {
      return At(t, e);
    }
    let r = n.searchParams.getAll("family").flatMap((i) => i.split("|")).map((i) => i.split(":")[0].trim()).filter(Boolean);
    return r.length ? r.every((i) => At(i, e)) : At(t, e);
  }
  function bl(t = "") {
    let e = String(t).toLowerCase();
    return /\bmaterial\s*icons\b/.test(e) || /\bmaterial\s*symbols\b/.test(e);
  }
  var _n = new Map;
  function wl(t = "") {
    let e = Object.create(null), n = String(t || ""), r = /['"]?\s*([A-Za-z]{3,4})\s*['"]?\s*([+-]?\d+(?:\.\d+)?)\s*/g, i;
    for (;i = r.exec(n); )
      e[i[1].toUpperCase()] = Number(i[2]);
    return e;
  }
  async function Sl(t, e, n) {
    let r = String(t || ""), i = r.toLowerCase(), o = String(e || "").toLowerCase();
    if (/\bmaterial\s*icons\b/.test(i) && !/\bsymbols\b/.test(i))
      return { familyForMeasure: r, familyForCanvas: r };
    if (!/\bmaterial\s*symbols\b/.test(i))
      return { familyForMeasure: r, familyForCanvas: r };
    let a = n && (n.FILL ?? n.fill), c = "outlined";
    /\brounded\b/.test(o) || /\bround\b/.test(o) ? c = "rounded" : /\bsharp\b/.test(o) ? c = "sharp" : /\boutlined\b/.test(o) && (c = "outlined");
    let f = a === 1, l = null;
    if (f && (c === "outlined" && Me.materialIconsFilled ? l = { url: Me.materialIconsFilled, alias: "snapdom-mi-filled" } : c === "rounded" && Me.materialIconsRound ? l = { url: Me.materialIconsRound, alias: "snapdom-mi-round" } : c === "sharp" && Me.materialIconsSharp && (l = { url: Me.materialIconsSharp, alias: "snapdom-mi-sharp" })), !l)
      return { familyForMeasure: r, familyForCanvas: r };
    if (!_n.has(l.alias))
      try {
        let p = new FontFace(l.alias, `url(${l.url})`, { style: "normal", weight: "400" });
        await p.load(), document.fonts.add(p), _n.set(l.alias, true);
      } catch {
        return _n.set(l.alias, false), { familyForMeasure: r, familyForCanvas: r };
      }
    if (_n.get(l.alias) === false)
      return { familyForMeasure: r, familyForCanvas: r };
    let u = `"${l.alias}"`;
    return { familyForMeasure: u, familyForCanvas: u };
  }
  async function xl(t = "Material Icons", e = 24) {
    try {
      await Promise.all([document.fonts.load(`400 ${e}px "${String(t).replace(/["']/g, "")}"`), document.fonts.ready]);
    } catch {}
  }
  function vl(t) {
    let e = t.getPropertyValue("-webkit-text-fill-color")?.trim() || "", n = /^transparent$/i.test(e) || /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(e);
    if (e && !n && e.toLowerCase() !== "currentcolor")
      return e;
    let r = t.color?.trim();
    return r && r !== "inherit" ? r : "#000";
  }
  async function kl(t, { family: e = "Material Icons", weight: n = "normal", fontSize: r = 32, color: i = "#000", variation: o = "", className: s = "" } = {}) {
    let a = String(e || "").replace(/^['"]+|['"]+$/g, ""), c = window.devicePixelRatio || 1, f = wl(o), { familyForMeasure: l, familyForCanvas: u } = await Sl(a, s, f);
    await xl(u.replace(/^["']+|["']+$/g, ""), r);
    let p = document.createElement("span");
    J(p), p.textContent = t, p.style.position = "absolute", p.style.visibility = "hidden", p.style.left = "-99999px", p.style.whiteSpace = "nowrap", p.style.fontFamily = l, p.style.fontWeight = String(n || "normal"), p.style.fontSize = `${r}px`, p.style.lineHeight = "1", p.style.margin = "0", p.style.padding = "0", p.style.fontFeatureSettings = "'liga' 1", p.style.fontVariantLigatures = "normal", p.style.color = i, document.body.appendChild(p);
    let h = p.getBoundingClientRect(), d = Math.max(1, Math.ceil(h.width)), m = Math.max(1, Math.ceil(h.height));
    document.body.removeChild(p);
    let g = document.createElement("canvas");
    g.width = d * c, g.height = m * c;
    let y = g.getContext("2d");
    y.scale(c, c), y.font = `${n ? `${n} ` : ""}${r}px ${u}`, y.textAlign = "left", y.textBaseline = "top", y.fillStyle = i;
    try {
      y.fontKerning = "normal";
    } catch {}
    return y.fillText(t, 0, 0), { dataUrl: g.toDataURL(), width: d, height: m };
  }
  async function Rn(t, e, n = new Map) {
    if (t?.nodeType !== 1)
      return 0;
    let r = '.material-icons, [class*="material-symbols"]', i = Array.from(t.querySelectorAll(r)).filter((a) => a && a.textContent && a.textContent.trim());
    if (t.matches?.(r) && t.textContent && t.textContent.trim() && i.unshift(t), i.length === 0)
      return 0;
    let o = e?.nodeType === 1 ? Array.from(e.querySelectorAll(r)).filter((a) => a && a.textContent && a.textContent.trim()) : [];
    e?.nodeType === 1 && e.matches?.(r) && e.textContent && e.textContent.trim() && o.unshift(e);
    let s = 0;
    for (let a = 0;a < i.length; a++) {
      let c = i[a], f = n && n.get(c) || o[a] || null;
      try {
        let l = getComputedStyle(f || c), u = l.fontFamily || "Material Icons";
        if (!bl(u))
          continue;
        let p = (f || c).textContent.trim();
        if (!p)
          continue;
        let h = parseInt(l.fontSize, 10) || 24, d = l.fontWeight && l.fontWeight !== "normal" ? l.fontWeight : "normal", m = vl(l), g = l.fontVariationSettings && l.fontVariationSettings !== "normal" ? l.fontVariationSettings : "", y = (f || c).className || "", { dataUrl: b, width: w, height: C } = await kl(p, { family: u, weight: d, fontSize: h, color: m, variation: g, className: y });
        c.textContent = "";
        let x = c.ownerDocument.createElement("img");
        x.src = b, x.alt = p, x.style.height = `${h}px`, x.style.width = `${Math.max(1, Math.round(w / C * h))}px`, x.style.objectFit = "contain", x.style.verticalAlign = getComputedStyle(c).verticalAlign || "baseline", c.appendChild(x), s++;
      } catch {}
    }
    return s;
  }
  de();
  kt();
  wt();
  async function Yi(t, e, n, r = 32, i = "#000", o = "normal") {
    e = e.replace(/^['"]+|['"]+$/g, "");
    let s = window.devicePixelRatio || 1;
    try {
      await document.fonts.ready;
    } catch {}
    let a = document.createElement("span");
    J(a), a.textContent = t, a.style.position = "absolute", a.style.visibility = "hidden", a.style.fontFamily = `"${e}"`, a.style.fontWeight = n || "normal", a.style.fontStyle = o || "normal", a.style.fontSize = `${r}px`, a.style.lineHeight = "1", a.style.whiteSpace = "nowrap", a.style.padding = "0", a.style.margin = "0", document.body.appendChild(a);
    let c = a.getBoundingClientRect(), f = Math.ceil(c.width), l = Math.ceil(c.height);
    document.body.removeChild(a);
    let u = document.createElement("canvas");
    u.width = Math.max(1, f * s), u.height = Math.max(1, l * s);
    let p = u.getContext("2d");
    return p.scale(s, s), p.font = `${o || "normal"} ${n || "normal"} ${r}px "${e}"`, p.textAlign = "left", p.textBaseline = "top", p.fillStyle = i, p.fillText(t, 0, 0), { dataUrl: u.toDataURL(), width: f, height: l };
  }
  var Ki = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "emoji", "math", "fangsong", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded"]);
  var Cl = ["katex", "mathjax", "mathml"];
  function Xr(t) {
    if (!t)
      return "";
    for (let e of t.split(",")) {
      let n = e.trim().replace(/^['"]+|['"]+$/g, "");
      if (n && !Ki.has(n.toLowerCase()))
        return n;
    }
    return "";
  }
  function Al(t) {
    if (!t)
      return [];
    let e = [];
    for (let n of t.split(",")) {
      let r = n.trim().replace(/^['"]+|['"]+$/g, "");
      r && (Ki.has(r.toLowerCase()) || e.push(r));
    }
    return e;
  }
  function Fn(t) {
    let e = String(t ?? "400").trim().toLowerCase();
    if (e === "normal")
      return 400;
    if (e === "bold")
      return 700;
    let n = parseInt(e, 10);
    return Number.isFinite(n) ? Math.min(900, Math.max(100, n)) : 400;
  }
  function Tn(t) {
    let e = String(t ?? "normal").trim().toLowerCase();
    return e.startsWith("italic") ? "italic" : e.startsWith("oblique") ? "oblique" : "normal";
  }
  function Ml(t) {
    let e = String(t ?? "100%").match(/(\d+(?:\.\d+)?)\s*%/);
    return e ? Math.max(50, Math.min(200, parseFloat(e[1]))) : 100;
  }
  function El(t) {
    let e = String(t || "400").trim(), n = e.match(/^(\d{2,3})\s+(\d{2,3})$/);
    if (n) {
      let i = Fn(n[1]), o = Fn(n[2]);
      return { min: Math.min(i, o), max: Math.max(i, o) };
    }
    let r = Fn(e);
    return { min: r, max: r };
  }
  function _l(t) {
    let e = String(t || "normal").trim().toLowerCase();
    return e === "italic" ? { kind: "italic" } : e.startsWith("oblique") ? { kind: "oblique" } : { kind: "normal" };
  }
  function Rl(t) {
    let e = String(t || "100%").trim(), n = e.match(/(\d+(?:\.\d+)?)\s*%\s+(\d+(?:\.\d+)?)\s*%/);
    if (n) {
      let o = parseFloat(n[1]), s = parseFloat(n[2]);
      return { min: Math.min(o, s), max: Math.max(o, s) };
    }
    let r = e.match(/(\d+(?:\.\d+)?)\s*%/), i = r ? parseFloat(r[1]) : 100;
    return { min: i, max: i };
  }
  function Fl(t) {
    return !t || typeof t != "string" ? "" : t.replace(/\s+(variable|vf|v[0-9]+)$/i, "").trim().toLowerCase().replace(/\s+/g, "-");
  }
  function Tl(t, e, n = []) {
    if (!t)
      return false;
    try {
      let r = new URL(t, location.href);
      if (r.origin === location.origin)
        return true;
      let o = r.host.toLowerCase();
      if (["fonts.googleapis.com", "fonts.gstatic.com", "use.typekit.net", "p.typekit.net", "kit.fontawesome.com", "use.fontawesome.com", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh"].some((c) => o.endsWith(c)) || n.some((c) => o === c.toLowerCase() || o.endsWith("." + c.toLowerCase())))
        return true;
      let a = (r.pathname + r.search).toLowerCase();
      if (/\bfont(s)?\b/.test(a) || /\.woff2?(\b|$)/.test(a) || Cl.some((c) => a.includes(c)))
        return true;
      for (let c of e) {
        let f = c.toLowerCase().replace(/\s+/g, "+"), l = c.toLowerCase().replace(/\s+/g, "-"), u = Fl(c);
        if (a.includes(f) || a.includes(l) || u && a.includes(u))
          return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  function $l(t) {
    let e = new Set;
    for (let n of t || []) {
      let r = String(n).split("__")[0]?.trim();
      r && e.add(r);
    }
    return e;
  }
  function qi(t, e) {
    return t && t.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (n, r, i) => {
      let o = (i || "").trim();
      if (!o || /^data:|^blob:|^https?:|^file:|^about:/i.test(o))
        return n;
      let s = o;
      try {
        s = new URL(o, e || location.href).href;
      } catch {}
      return `url("${s}")`;
    });
  }
  var Qi = /@import\s+(?:url\(\s*(['"]?)([^)"']+)\1\s*\)|(['"])([^"']+)\3)([^;]*);/g;
  var $n = 4;
  async function Pl(t, e, n) {
    if (!t)
      return t;
    let r = new Set;
    function i(a, c) {
      try {
        return new URL(a, c || location.href).href;
      } catch {
        return a;
      }
    }
    async function o(a, c, f = 0) {
      if (f > $n)
        return console.warn(`[snapDOM] @import depth exceeded (${$n}) at ${c}`), a;
      let l = "", u = 0, p, h = new RegExp(Qi.source, "g");
      for (;p = h.exec(a); ) {
        l += a.slice(u, p.index), u = h.lastIndex;
        let d = (p[2] || p[4] || "").trim(), m = i(d, c);
        if (r.has(m)) {
          console.warn(`[snapDOM] Skipping circular @import: ${m}`);
          continue;
        }
        r.add(m);
        let g = "";
        try {
          let y = await it(m, { as: "text", useProxy: n, silent: true });
          y.ok && typeof y.data == "string" && (g = y.data);
        } catch {}
        g ? (g = qi(g, m), g = await o(g, m, f + 1), l += `
/* inlined: ${m} */
${g}
`) : l += p[0];
      }
      return l += a.slice(u), l;
    }
    let s = qi(t, e || location.href);
    return s = await o(s, e || location.href, 0), s;
  }
  var Ji = /url\((["']?)([^"')]+)\1\)/g;
  var Nl = /@font-face[^{}]*\{[^}]*\}/g;
  function xt(t, e, n = "") {
    return (t.match(new RegExp(`${e}\\s*:\\s*([^;}]+)[;}]`, "i"))?.[1] || n).trim();
  }
  function Zi(t) {
    if (!t)
      return [];
    let e = [], n = t.split(",").map((r) => r.trim()).filter(Boolean);
    for (let r of n) {
      let i = r.match(/^U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f?]+))?$/);
      if (!i)
        continue;
      let o = i[1], s = i[2], a = (c) => {
        if (!c.includes("?"))
          return parseInt(c, 16);
        let f = parseInt(c.replace(/\?/g, "0"), 16), l = parseInt(c.replace(/\?/g, "F"), 16);
        return [f, l];
      };
      if (s) {
        let c = a(o), f = a(s), l = Array.isArray(c) ? c[0] : c, u = Array.isArray(f) ? f[1] : f;
        e.push([Math.min(l, u), Math.max(l, u)]);
      } else {
        let c = a(o);
        Array.isArray(c) ? e.push([c[0], c[1]]) : e.push([c, c]);
      }
    }
    return e;
  }
  function ts(t, e) {
    if (!e.length || !t || t.size === 0)
      return true;
    for (let n of t)
      for (let [r, i] of e)
        if (n >= r && n <= i)
          return true;
    return false;
  }
  function Yr(t, e) {
    let n = [];
    if (!t)
      return n;
    for (let r of t.matchAll(Ji)) {
      let i = (r[2] || "").trim();
      if (!(!i || i.startsWith("data:"))) {
        if (!/^https?:/i.test(i))
          try {
            i = new URL(i, e || location.href).href;
          } catch {}
        n.push(i);
      }
    }
    return n;
  }
  async function qr(t, e, n = "", r) {
    let i = t;
    for (let o of t.matchAll(Ji)) {
      let s = Kt(o[0]);
      if (!s)
        continue;
      let a = s;
      if (!a.startsWith("http") && !a.startsWith("data:"))
        try {
          a = new URL(a, e || location.href).href;
        } catch {}
      if (!At(a, r)) {
        if (P.resource?.has(a)) {
          i = i.replace(o[0], `url(${P.resource.get(a)})`);
          continue;
        }
        try {
          let c = await it(a, { as: "dataURL", useProxy: n, silent: true });
          if (c.ok && typeof c.data == "string") {
            let f = c.data;
            P.resource?.set(a, f), i = i.replace(o[0], `url(${f})`);
          }
        } catch {
          console.warn("[snapDOM] Failed to fetch font resource:", a);
        }
      }
    }
    return i;
  }
  function Ll(t) {
    if (!t.length)
      return null;
    let e = (a, c) => t.some(([f, l]) => !(l < a || f > c)), n = e(0, 255) || e(305, 305), r = e(256, 591) || e(7680, 7935), i = e(880, 1023), o = e(1024, 1279);
    return e(7840, 7929) || e(258, 259) || e(416, 417) || e(431, 432) ? "vietnamese" : o ? "cyrillic" : i ? "greek" : r ? "latin-ext" : n ? "latin" : null;
  }
  function Gi(t = {}) {
    let e = new Set((t.families || []).map((i) => String(i).toLowerCase())), n = new Set((t.domains || []).map((i) => String(i).toLowerCase())), r = new Set((t.subsets || []).map((i) => String(i).toLowerCase()));
    return (i, o) => {
      if (e.size && e.has(i.family.toLowerCase()))
        return true;
      if (n.size)
        for (let s of i.srcUrls)
          try {
            if (n.has(new URL(s).host.toLowerCase()))
              return true;
          } catch {}
      if (r.size) {
        let s = Ll(o);
        if (s && r.has(s))
          return true;
      }
      return false;
    };
  }
  function Il(t) {
    if (!t)
      return t;
    let e = /@font-face[^{}]*\{[^}]*\}/gi, n = new Set, r = [];
    for (let o of t.match(e) || []) {
      let s = xt(o, "font-family"), a = Xr(s), c = xt(o, "font-weight", "400"), f = xt(o, "font-style", "normal"), l = xt(o, "font-stretch", "100%"), u = xt(o, "unicode-range"), p = xt(o, "src"), h = Yr(p, location.href), d = h.length ? h.map((g) => String(g).toLowerCase()).sort().join("|") : p.toLowerCase(), m = [String(a || "").toLowerCase(), c, f, l, u.toLowerCase(), d].join("|");
      n.has(m) || (n.add(m), r.push(o));
    }
    if (r.length === 0)
      return t;
    let i = 0;
    return t.replace(e, () => r[i++] || "");
  }
  var Xi = new WeakMap;
  var Wl = 0;
  function Ol(t) {
    let e = Xi.get(t);
    return e === undefined && (e = Wl++, Xi.set(t, e)), e;
  }
  function Dl(t, e, n, r, i, o, s, a, c) {
    let f = Array.from(t || []).sort().join("|"), l = 0, u = 0;
    for (let b of s || []) {
      let w = Math.imul(b, 2654435761);
      w ^= w >>> 15, w = Math.imul(w, 2246822507), w ^= w >>> 13, l = l + w | 0, u++;
    }
    let p = e ? JSON.stringify({ families: (e.families || []).map((b) => String(b).toLowerCase()).sort(), domains: (e.domains || []).map((b) => String(b).toLowerCase()).sort(), subsets: (e.subsets || []).map((b) => String(b).toLowerCase()).sort() }) : "", h = (n || []).map((b) => `${(b.family || "").toLowerCase()}::${b.weight || "normal"}::${b.style || "normal"}::${b.stretchPct ?? 100}::${b.src || ""}`).sort().join("|"), d = r || "", m = (i || []).map((b) => String(b).toLowerCase()).sort().join("|"), g = Ol(o || document), y = (a || []).map((b) => String(b)).sort().join("|");
    return `fonts-embed-css::req=${f}::ex=${p}::lf=${h}::px=${d}::fd=${m}::doc=${g}::cp=${l}::n=${u}::ic=${y}::env=${c}`;
  }
  async function Gr(t, e, n, r) {
    let i = r.doc?.defaultView || window;
    if (t.disabled || t.media?.mediaText && !i.matchMedia(t.media.mediaText).matches)
      return;
    let o;
    try {
      o = t.cssRules || [];
    } catch {
      return;
    }
    let s = (a, c) => {
      try {
        return new URL(a, c || location.href).href;
      } catch {
        return a;
      }
    };
    for (let a of o) {
      if (a.type === CSSRule.IMPORT_RULE && a.styleSheet) {
        let c = a.href ? s(a.href, e) : e;
        if (r.depth >= $n) {
          console.warn(`[snapDOM] CSSOM import depth exceeded (${$n}) at ${c}`);
          continue;
        }
        if (c && r.visitedSheets.has(c)) {
          console.warn(`[snapDOM] Skipping circular CSSOM import: ${c}`);
          continue;
        }
        c && r.visitedSheets.add(c);
        let f = { ...r, depth: (r.depth || 0) + 1 };
        await Gr(a.styleSheet, c, n, f);
        continue;
      }
      if (a.cssRules?.length) {
        if (a.type === CSSRule.MEDIA_RULE && !i.matchMedia(a.conditionText).matches || a.type === CSSRule.SUPPORTS_RULE && !i.CSS.supports(a.conditionText))
          continue;
        await Gr(a, e, n, r);
        continue;
      }
      if (a.type === CSSRule.FONT_FACE_RULE) {
        let c = (a.style.getPropertyValue("font-family") || "").trim(), f = Xr(c);
        if (!f || At(f, r.iconMatchers))
          continue;
        let l = (a.style.getPropertyValue("font-weight") || "").trim(), u = (a.style.getPropertyValue("font-style") || "").trim(), p = (a.style.getPropertyValue("font-stretch") || "").trim(), h = (a.style.getPropertyValue("font-variation-settings") || "").trim(), d = (a.style.getPropertyValue("src") || "").trim(), m = (a.style.getPropertyValue("unicode-range") || "").trim(), g = l || "400", y = u || "normal", b = p || "100%", w = (u ? `font-style:${u};` : "") + (l ? `font-weight:${l};` : "") + (p ? `font-stretch:${p};` : "") + (h ? `font-variation-settings:${h};` : "") + (m ? `unicode-range:${m};` : ""), C = r.faceMatchesRequired(f, y, g, b);
        if (!C && !r.requiredIndex.has(f.toLowerCase()))
          continue;
        let x = Zi(m);
        if (!ts(r.usedCodepoints, x))
          continue;
        let S = { family: f, weightSpec: g, styleSpec: y, stretchSpec: b, unicodeRange: m, srcRaw: d, srcUrls: Yr(d, e || location.href), href: e || location.href };
        if (r.simpleExcluder && r.simpleExcluder(S, x))
          continue;
        if (!C) {
          r.provisionalFaces.push({ family: f.toLowerCase(), block: `@font-face{font-family:${f};src:${d};${w}}`, srcRaw: d, baseHref: e || location.href });
          continue;
        }
        r.coveredFamilies.add(f.toLowerCase());
        let A = `"${String(f).replace(/^\s*["']|["']\s*$/g, "").replace(/(["\\])/g, "\\$1")}"`;
        if (/url\(/i.test(d)) {
          let v = await qr(d, e || location.href, r.useProxy, r.iconMatchers);
          await n(`@font-face{font-family:${A};src:${v};${w}}`);
        } else
          await n(`@font-face{font-family:${A};src:${d};${w}}`);
      }
    }
  }
  async function es({ required: t, usedCodepoints: e, exclude: n = undefined, localFonts: r = [], useProxy: i = "", fontStylesheetDomains: o = [], iconMatchers: s = [], doc: a = document } = {}) {
    t instanceof Set || (t = new Set), e instanceof Set || (e = new Set);
    let c = new Map;
    for (let S of t) {
      let [A, v, M, k] = String(S).split("__");
      if (!A)
        continue;
      let R = A.toLowerCase(), E = c.get(R) || [];
      E.push({ w: parseInt(v, 10), s: M, st: parseInt(k, 10) }), c.set(R, E);
    }
    function f(S, A, v, M) {
      let k = String(S).toLowerCase();
      if (!c.has(k))
        return false;
      let R = c.get(k), E = El(v), T = _l(A), N = Rl(M), O = E.min !== E.max, H = E.min, _ = ($) => T.kind === "normal" && $ === "normal" || T.kind !== "normal" && ($ === "italic" || $ === "oblique"), L = false;
      for (let $ of R) {
        let F = O ? $.w >= E.min && $.w <= E.max : $.w === H, V = _(Tn($.s)), z = $.st >= N.min && $.st <= N.max;
        if (F && V && z) {
          L = true;
          break;
        }
      }
      if (L)
        return true;
      if (!O)
        for (let $ of R) {
          let F = _(Tn($.s)), V = $.st >= N.min && $.st <= N.max;
          if (Math.abs(H - $.w) <= 300 && F && V)
            return true;
        }
      if (!O && T.kind === "normal" && R.some((F) => Tn(F.s) !== "normal"))
        for (let F of R) {
          let V = Math.abs(H - F.w) <= 300, z = F.st >= N.min && F.st <= N.max;
          if (V && z)
            return true;
        }
      return false;
    }
    let l = Gi(n);
    we(a), Rt();
    let u = Dl(t, n, r, i, o, a, e, s, we(a));
    if (P.resource?.has(u))
      return P.resource.get(u);
    let p = $l(t), h = [], d = Qi;
    for (let S of a.querySelectorAll("style")) {
      let A = S.textContent || "";
      for (let v of A.matchAll(d)) {
        let M = (v[2] || v[4] || "").trim();
        if (!M || Vr(M, s))
          continue;
        a.querySelector(`link[rel="stylesheet"][href="${M}"]`) || h.push(M);
      }
    }
    let m = [];
    h.length && await Promise.all(h.map((S) => new Promise((A) => {
      if (a.querySelector(`link[rel="stylesheet"][href="${S}"]`))
        return A(null);
      let v = a.createElement("link");
      v.rel = "stylesheet", v.href = S, J(v), v.setAttribute("data-snapdom", "injected-import");
      let M = setTimeout(() => A(null), 3000), k = (R) => {
        clearTimeout(M), A(R);
      };
      v.onload = () => k(v), v.onerror = () => k(null), a.head.appendChild(v), m.push(v);
    })));
    let g = "", y = new Set, b = [], w = Array.from(a.querySelectorAll('link[rel="stylesheet"]')).filter((S) => !!S.href);
    for (let S of m)
      try {
        S.remove();
      } catch {}
    for (let S of w)
      try {
        if (Vr(S.href, s))
          continue;
        let A = "", v = false;
        try {
          v = new URL(S.href, location.href).origin === location.origin;
        } catch {}
        if (!v) {
          let k = Array.isArray(o) ? o : [];
          if (!Tl(S.href, p, k))
            continue;
        }
        if (v) {
          let k = Array.from(a.styleSheets).find((R) => R.href === S.href);
          if (k)
            try {
              let R = k.cssRules || [];
              A = Array.from(R).map((E) => E.cssText).join("");
            } catch {}
        }
        if (!A) {
          let k = await it(S.href, { as: "text", useProxy: i });
          k?.ok && typeof k.data == "string" && (A = k.data);
        }
        A = await Pl(A, S.href, i);
        let M = "";
        for (let k of A.match(Nl) || []) {
          let R = xt(k, "font-family"), E = Xr(R);
          if (!E || At(E, s))
            continue;
          let T = xt(k, "font-weight", "400"), N = xt(k, "font-style", "normal"), O = xt(k, "font-stretch", "100%"), H = xt(k, "unicode-range"), _ = xt(k, "src"), L = Yr(_, S.href), $ = f(E, N, T, O);
          if (!$ && !c.has(E.toLowerCase()))
            continue;
          let F = Zi(H);
          if (!ts(e, F))
            continue;
          let V = { family: E, weightSpec: T, styleSpec: N, stretchSpec: O, unicodeRange: H, srcRaw: _, srcUrls: L, href: S.href };
          if (n && l(V, F))
            continue;
          if (!$) {
            b.push({ family: E.toLowerCase(), block: k, srcRaw: _, baseHref: S.href });
            continue;
          }
          y.add(E.toLowerCase());
          let z = /url\(/i.test(_) ? await qr(k, S.href, i, s) : k;
          M += z;
        }
        M.trim() && (g += M);
      } catch {
        console.warn("[snapDOM] Failed to process stylesheet:", S.href);
      }
    let C = { doc: a, requiredIndex: c, usedCodepoints: e, faceMatchesRequired: f, coveredFamilies: y, provisionalFaces: b, simpleExcluder: n ? Gi(n) : null, useProxy: i, iconMatchers: s, visitedSheets: new Set, depth: 0 }, x = new Set([...a.styleSheets, ...a.adoptedStyleSheets || []]);
    for (let S of x)
      if (!(S.href && w.some((A) => A.href === S.href)))
        try {
          let A = S.href || a.baseURI || location.origin + "/";
          A && C.visitedSheets.add(A), await Gr(S, A, async (v) => {
            g += v;
          }, C);
        } catch {}
    for (let S of b)
      y.has(S.family) || (g += /url\(/i.test(S.srcRaw) ? await qr(S.block, S.baseHref, i, s) : S.block);
    try {
      for (let S of a.fonts || []) {
        if (!S || !S.family || S.status !== "loaded" || !S._snapdomSrc)
          continue;
        let A = String(S.family).replace(/^['"]+|['"]+$/g, "");
        if (At(A, s) || !c.has(A.toLowerCase()) || n?.families && n.families.some((M) => String(M).toLowerCase() === A.toLowerCase()))
          continue;
        let v = S._snapdomSrc;
        if (!String(v).startsWith("data:"))
          if (P.resource?.has(S._snapdomSrc))
            v = P.resource.get(S._snapdomSrc);
          else
            try {
              let M = await it(S._snapdomSrc, { as: "dataURL", useProxy: i, silent: true });
              if (M.ok && typeof M.data == "string")
                v = M.data, P.resource?.set(S._snapdomSrc, v);
              else
                continue;
            } catch {
              console.warn("[snapDOM] Failed to fetch dynamic font src:", S._snapdomSrc);
              continue;
            }
        g += `@font-face{font-family:'${A}';src:url(${v});font-style:${S.style || "normal"};font-weight:${S.weight || "normal"};}`;
      }
    } catch {}
    for (let S of r) {
      if (!S || typeof S != "object")
        continue;
      let A = String(S.family || "").replace(/^['"]+|['"]+$/g, "");
      if (!A || At(A, s) || !c.has(A.toLowerCase()) || n?.families && n.families.some((T) => String(T).toLowerCase() === A.toLowerCase()))
        continue;
      let v = S.weight != null ? String(S.weight) : "normal", M = S.style != null ? String(S.style) : "normal", k = S.stretchPct != null ? `${S.stretchPct}%` : "100%", R = String(S.src || ""), E = R;
      if (!E.startsWith("data:"))
        if (P.resource?.has(R))
          E = P.resource.get(R);
        else
          try {
            let T = await it(R, { as: "dataURL", useProxy: i, silent: true });
            if (T.ok && typeof T.data == "string")
              E = T.data, P.resource?.set(R, E);
            else
              continue;
          } catch {
            console.warn("[snapDOM] Failed to fetch localFonts src:", R);
            continue;
          }
      g += `@font-face{font-family:'${A}';src:url(${E});font-style:${M};font-weight:${v};font-stretch:${k};}`;
    }
    return g && (g = Il(g), P.resource?.set(u, g)), g;
  }
  function Pn(t, e) {
    let n = new Set, r = new Set;
    if (!t)
      return { required: n, usedCodepoints: r };
    let i = (l) => {
      if (l)
        for (let u of l)
          r.add(u.codePointAt(0));
    }, o = (l) => {
      let u = Al(l.fontFamily);
      if (u.length)
        for (let p of u)
          n.add(`${p}__${Fn(l.fontWeight)}__${Tn(l.fontStyle)}__${Ml(l.fontStretch)}`);
    }, s = ve(t), a = t.getRootNode(), c = (l) => {
      o(W(l));
      let u = l.getRootNode() === a ? s : ve(l);
      for (let p of ["::before", "::after"]) {
        let h = p === "::before" ? u.before : u.after;
        if (h !== null) {
          if (h === "")
            continue;
          try {
            if (!l.matches(h))
              continue;
          } catch {}
        }
        let d = W(l, p), m = d && d.content;
        if (!(!m || m === "none" || m === "normal"))
          if (o(d), /^["']/.test(m))
            i(m.slice(1, -1));
          else {
            let g = m.match(/\\[0-9A-Fa-f]{1,6}/g);
            if (g)
              for (let y of g)
                try {
                  r.add(parseInt(y.slice(1), 16));
                } catch {}
          }
      }
    }, f = [t];
    for (let l = 0;l < f.length; l++) {
      let u = f[l];
      u.nodeType === Node.ELEMENT_NODE && c(u), u.shadowRoot && f.push(u.shadowRoot);
      let p = (t.ownerDocument || document).createTreeWalker(u, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
      for (;p.nextNode(); ) {
        let h = p.currentNode;
        if (h.nodeType === Node.TEXT_NODE) {
          if (e && h.parentElement && !e(h.parentElement))
            continue;
          i(h.nodeValue || "");
        } else {
          if (e && !e(h))
            continue;
          c(h), h.shadowRoot && f.push(h.shadowRoot);
        }
      }
    }
    return { required: n, usedCodepoints: r };
  }
  async function Nn(t, e = 2, n = document) {
    try {
      await n.fonts.ready;
    } catch {}
    let r = Array.from(t || []).filter(Boolean);
    if (r.length === 0)
      return;
    let i = () => {
      let o = n.createElement("div");
      J(o), o.style.cssText = "position:absolute!important;left:-9999px!important;top:0!important;opacity:0!important;pointer-events:none!important;contain:layout size style;";
      for (let s of r) {
        let a = n.createElement("span");
        a.textContent = "AaBbGg1234ÁÉÍÓÚçñ—∞", a.style.fontFamily = `"${s}"`, a.style.fontWeight = "700", a.style.fontStyle = "italic", a.style.fontSize = "32px", a.style.lineHeight = "1", a.style.whiteSpace = "nowrap", a.style.margin = "0", a.style.padding = "0", o.appendChild(a);
      }
      n.body.appendChild(o), o.offsetWidth, n.body.removeChild(o);
    };
    for (let o = 0;o < Math.max(1, e); o++)
      i(), await pt(), await pt();
  }
  bt();
  function is(t) {
    return /\bcounter\s*\(|\bcounters\s*\(/.test(t || "");
  }
  function ns(t, e = false) {
    let n = "", r = Math.max(1, t);
    for (;r > 0; )
      r--, n = String.fromCharCode(97 + r % 26) + n, r = Math.floor(r / 26);
    return e ? n.toUpperCase() : n;
  }
  function rs(t, e = true) {
    let n = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]], r = Math.max(1, Math.min(3999, t)), i = "";
    for (let [o, s] of n)
      for (;r >= o; )
        i += s, r -= o;
    return e ? i : i.toLowerCase();
  }
  function os(t, e) {
    switch ((e || "decimal").toLowerCase()) {
      case "decimal":
        return String(t);
      case "decimal-leading-zero": {
        let n = Math.abs(t);
        return (t < 0 ? "-" : "") + (n < 10 ? "0" : "") + String(n);
      }
      case "lower-alpha":
      case "lower-latin":
        return ns(t, false);
      case "upper-alpha":
      case "upper-latin":
        return ns(t, true);
      case "lower-roman":
        return rs(t, false);
      case "upper-roman":
        return rs(t, true);
      default:
        return String(t);
    }
  }
  function rn(t, e) {
    let n = (t || "").trim().split(/[\s,]+/).filter(Boolean), r = [];
    for (let i = 0;i < n.length; i++) {
      let o = n[i];
      if (o === "none")
        continue;
      let s = n[i + 1], a = s !== undefined && Number.isFinite(Number(s));
      r.push([o, a ? Number(s) : e]), a && i++;
    }
    return r;
  }
  function ss(t) {
    let e = new WeakMap, n = br(t) ? t.documentElement : t, r = (f) => f && f.tagName === "LI", i = new WeakMap, o = (f) => {
      let l = new Map;
      for (let [u, p] of f)
        l.set(u, p.slice());
      return l;
    }, s = (f, l, u) => {
      let p = o(f), h;
      try {
        h = getComputedStyle(u);
      } catch {
        h = u.style;
      }
      let d;
      try {
        d = h?.counterReset;
      } catch {}
      if (d && d !== "none")
        for (let [y, b] of rn(d, 0)) {
          let w = l.get(y);
          if (w && w.length) {
            let C = w.slice();
            C.push(b), p.set(y, C);
          } else
            p.set(y, [b]);
        }
      let m;
      try {
        m = h?.counterSet;
      } catch {}
      if (m && m !== "none")
        for (let [y, b] of rn(m, 0)) {
          let w = p.get(y) || [];
          w.length === 0 && w.push(0), w[w.length - 1] = b, p.set(y, w);
        }
      let g;
      try {
        g = h?.counterIncrement;
      } catch {}
      if (g && g !== "none")
        for (let [y, b] of rn(g, 1)) {
          let w = p.get(y) || [];
          w.length === 0 && w.push(0), w[w.length - 1] += b, p.set(y, w);
        }
      try {
        if (h?.display === "list-item" && r(u)) {
          let y = u.parentElement, b = y && i.get(y), w = y?.tagName === "OL" ? parseInt(y.getAttribute("start"), 10) : NaN, C = b === undefined ? Number.isFinite(w) ? w : 1 : b + 1, x = y?.tagName === "OL" ? parseInt(u.getAttribute("value"), 10) : NaN;
          Number.isFinite(x) && (C = x), y && i.set(y, C);
          let S = p.get("list-item") || [];
          S.length === 0 && S.push(0), S[S.length - 1] = C, p.set("list-item", S);
        }
      } catch {}
      return p;
    }, a = (f, l, u) => {
      let p = s(u, l, f);
      e.set(f, p);
      let h = p;
      for (let m of f.children)
        h = a(m, p, h);
      let d = new Map;
      for (let [m, g] of u) {
        let y = g.length, b = h.get(m);
        d.set(m, b && b.length ? b.slice(0, y) : g.slice());
      }
      for (let [m, g] of h)
        !d.has(m) && g.length && !l.has(m) && d.set(m, g.slice(0, 1));
      return d;
    }, c = new Map;
    return a(n, c, c), { get(f, l) {
      let u = e.get(f)?.get(l);
      return u && u.length ? u[u.length - 1] : 0;
    }, getStack(f, l) {
      let u = e.get(f)?.get(l);
      return u ? u.slice() : [];
    } };
  }
  function as(t, e, n) {
    if (!t || t === "none")
      return t;
    try {
      let r = /\b(counter|counters)\s*\(([^)]+)\)/g;
      return t.replace(r, (i, o, s) => {
        let a = String(s).split(",").map((c) => c.trim());
        if (o === "counter") {
          let c = a[0]?.replace(/^["']|["']$/g, ""), f = (a[1] || "decimal").toLowerCase(), l = n.get(e, c);
          return os(l, f);
        } else {
          let c = a[0]?.replace(/^["']|["']$/g, ""), f = a[1]?.replace(/^["']|["']$/g, "") ?? "", l = (a[2] || "decimal").toLowerCase(), u = n.getStack(e, c);
          return u.length ? u.map((h) => os(h, l)).join(f) : "";
        }
      });
    } catch {
      return "- ";
    }
  }
  de();
  var Ee = new WeakMap;
  var cs = 1000;
  function Bl(t, e) {
    let n = ds(t);
    return e ? (e.__pseudoPreflightFp !== n && (Rt(), e.__pseudoPreflight = ls(t, n), e.__pseudoPreflightFp = n), !!e.__pseudoPreflight) : (Rt(), ls(t, n));
  }
  function Ln(t) {
    try {
      return t && t.cssRules ? t.cssRules : null;
    } catch {
      return null;
    }
  }
  function ds(t) {
    let e = t.querySelectorAll('style,link[rel~="stylesheet"]'), n = `n:${e.length}|`, r = 0;
    for (let s = 0;s < e.length; s++) {
      let a = e[s];
      if (a.tagName === "STYLE") {
        let c = a.textContent ? a.textContent.length : 0;
        n += `S${c}|`;
        let f = a.sheet, l = f ? Ln(f) : null;
        l && (r += l.length);
      } else {
        let c = a.getAttribute("href") || "", f = a.getAttribute("media") || "all";
        n += `L${c}|m:${f}|`;
        let l = a.sheet, u = l ? Ln(l) : null;
        u && (r += u.length);
      }
    }
    let i = t.adoptedStyleSheets, o = 0;
    if (Array.isArray(i))
      for (let s of i) {
        let a = Ln(s);
        a && (o += a.length);
      }
    return n += `ass:${Array.isArray(i) ? i.length : 0}/${o}|tr:${r}`, n;
  }
  function Kr(t, e, n) {
    let r = Ln(t);
    if (!r)
      return false;
    for (let i = 0;i < r.length; i++) {
      if (n.budget <= 0)
        return false;
      let o = r[i], s = o && o.cssText ? o.cssText : "";
      n.budget--;
      for (let a of e)
        if (s.includes(a))
          return true;
      if (o && o.styleSheet && Kr(o.styleSheet, e, n))
        return true;
      if (o && o.cssRules && o.cssRules.length)
        for (let a = 0;a < o.cssRules.length && n.budget > 0; a++) {
          let c = o.cssRules[a], f = c && c.cssText ? c.cssText : "";
          n.budget--;
          for (let l of e)
            if (f.includes(l))
              return true;
        }
      if (n.budget <= 0)
        return false;
    }
    return false;
  }
  function ls(t = document, e = ds(t)) {
    let n = Ee.get(t);
    if (n && n.fingerprint === e)
      return n.result;
    let r = (a) => (a.match(/\|ass:[^|]*/) || [""])[0];
    n && r(e) !== r(n.fingerprint) && Se();
    let i = ["::before", "::after", "::first-letter", "::marker", "::first-line", ":before", ":after", ":first-letter", ":first-line", "counter(", "counters(", "counter-increment", "counter-reset"], o = t.querySelectorAll("style");
    for (let a = 0;a < o.length; a++) {
      let c = o[a].textContent || "";
      for (let f of i)
        if (c.includes(f))
          return Ee.set(t, { fingerprint: e, result: true }), true;
    }
    let s = t.adoptedStyleSheets;
    if (Array.isArray(s) && s.length) {
      let a = { budget: cs };
      try {
        for (let c of s)
          if (Kr(c, i, a))
            return Ee.set(t, { fingerprint: e, result: true }), true;
      } catch {}
    }
    {
      let a = t.querySelectorAll('style,link[rel~="stylesheet"]'), c = { budget: cs };
      for (let f = 0;f < a.length && c.budget > 0; f++) {
        let l = a[f], u = null;
        if (l.tagName, u = l.sheet || null, u && Kr(u, i, c))
          return Ee.set(t, { fingerprint: e, result: true }), true;
      }
    }
    return t.querySelector('[style*="counter("], [style*="counters("]') ? (Ee.set(t, { fingerprint: e, result: true }), true) : (Ee.set(t, { fingerprint: e, result: false }), false);
  }
  function fs(t) {
    for (let e of ["Top", "Right", "Bottom", "Left"]) {
      let n = parseFloat(t[`border${e}Width`]) || 0, r = t[`border${e}Style`];
      if (n > 0 && r && r !== "none" && r !== "hidden")
        return true;
    }
    return false;
  }
  function Ul(t, e) {
    let n = null, r = () => {
      if (!n)
        try {
          n = ss(t);
        } catch (i) {
          D(e, "buildCounterContext failed", i), n = { get: () => 0, getStack: () => [] };
        }
      return n;
    };
    return { get(i, o) {
      return r().get(i, o);
    }, getStack(i, o) {
      return r().getStack(i, o);
    } };
  }
  function Hl(t) {
    let e = false;
    for (let n = 0;n < t.length; n++) {
      let r = t[n];
      if (r === '"')
        e = !e;
      else if (r === "/" && !e)
        return t.slice(0, n).trim();
    }
    return t;
  }
  function zl(t) {
    return t.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([\s\S]))/g, (e, n, r) => {
      if (n) {
        let i = parseInt(n, 16);
        return i === 0 || i > 1114111 ? "�" : String.fromCodePoint(i);
      }
      return r === `
` ? "" : r;
    });
  }
  function jl(t) {
    if (!t)
      return "";
    let e = [], n = /"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'/g, r = 0, i;
    for (;i = n.exec(t); ) {
      let s = t.slice(r, i.index).trim();
      s && e.push(s), e.push(zl(i[1] !== undefined ? i[1] : i[2])), r = n.lastIndex;
    }
    let o = t.slice(r).trim();
    return o && e.push(o), e.join("");
  }
  function Qr(t, e, n) {
    let r = t.parentElement, i = r && n ? n.get(r) : null;
    return i ? { get(o, s) {
      let a = e.get(o, s), c = i.get(s);
      return typeof c == "number" ? Math.max(a, c) : a;
    }, getStack(o, s) {
      let a = e.getStack(o, s);
      if (!a.length)
        return a;
      let c = i.get(s);
      if (typeof c == "number") {
        let f = a.slice();
        return f[f.length - 1] = Math.max(f[f.length - 1], c), f;
      }
      return a;
    } } : e;
  }
  function Jr(t, e, n) {
    let r = new Map, i = (f, l) => rn(f, l).map(([u, p]) => ({ name: u, num: p })), o = i(e?.counterReset, 0), s = i(e?.counterSet, 0), a = i(e?.counterIncrement, 1);
    function c(f) {
      if (r.has(f))
        return r.get(f).slice();
      let l = n.getStack(t, f);
      l = l.length ? l.slice() : [];
      let u = o.find((d) => d.name === f);
      if (u) {
        let d = Number.isFinite(u.num) ? u.num : 0;
        l = l.length ? [...l, d] : [d];
      }
      let p = s.find((d) => d.name === f);
      if (p) {
        let d = Number.isFinite(p.num) ? p.num : 0;
        l.length === 0 && (l = [0]), l[l.length - 1] = d;
      }
      let h = a.find((d) => d.name === f);
      if (h) {
        let d = Number.isFinite(h.num) ? h.num : 1;
        l.length === 0 && (l = [0]), l[l.length - 1] += d;
      }
      return r.set(f, l.slice()), l;
    }
    return { get(f, l) {
      let u = c(l);
      return u.length ? u[u.length - 1] : 0;
    }, getStack(f, l) {
      return c(l);
    }, __incs: a };
  }
  var Vl = ["color", "-webkit-text-fill-color", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "line-height"];
  var ql = ["color", "-webkit-text-fill-color", "font-family", "font-size", "font-weight", "font-style", "font-variant", "letter-spacing", "word-spacing", "text-transform", "text-decoration-line", "text-decoration-color", "text-decoration-style", "line-height", "background-color", "vertical-align"];
  function us(t, e, n, r, i, o) {
    try {
      if (r === null) {
        if (t.getRootNode() !== (t.ownerDocument || document))
          return;
        let u = W(t).display || "";
        if (i === "::marker" ? !u.includes("list-item") : !(u === "block" || u === "flow-root" || u === "list-item" || u === "inline-block" || u === "table-cell" || u === "table-caption"))
          return;
      } else if (!t.matches(r))
        return;
      if (i === "::marker" && !(W(t).display || "").includes("list-item"))
        return;
      let s = W(t, i), a = W(t);
      if (!s)
        return;
      let c = "";
      for (let u of o) {
        let p = s.getPropertyValue(u);
        p && p !== a.getPropertyValue(u) && !(u === "background-color" && p === "rgba(0, 0, 0, 0)") && !(u === "vertical-align" && p === "baseline") && (c += `${u}:${p};`);
      }
      if (i === "::marker") {
        let u = s.getPropertyValue("content");
        u && u !== "normal" && u !== "none" && (c += `content:${u};`);
      }
      if (!c)
        return;
      let l = `data-sd-p${n.__pseudoRuleSeq = (n.__pseudoRuleSeq || 0) + 1}`;
      e.setAttribute(l, ""), n.__pseudoCSS = (n.__pseudoCSS || "") + `[${l}]${i}{${c}}`;
    } catch {}
  }
  function Gl(t, e) {
    if (!/\b(?:no-)?(?:open|close)-quote\b/.test(t))
      return t;
    let n = "“", r = "”";
    try {
      let i = W(e).quotes;
      if (i === "none")
        n = "", r = "";
      else if (i && i !== "auto") {
        let o = i.match(/"[^"]*"|'[^']*'/g);
        o && o.length >= 2 && (n = o[0].slice(1, -1), r = o[1].slice(1, -1));
      }
    } catch {}
    return n = n.replace(/"/g, ""), r = r.replace(/"/g, ""), t.replace(/"[^"]*"|\b(no-open-quote|no-close-quote|open-quote|close-quote)\b/g, (i, o) => o ? o === "open-quote" ? `"${n}"` : o === "close-quote" ? `"${r}"` : '""' : i);
  }
  function Xl(t, e, n, r) {
    let i;
    try {
      i = W(t, e);
    } catch {}
    let o = i?.content;
    if (!o || o === "none" || o === "normal")
      return { text: "", incs: [] };
    o = Hl(o), o = Gl(o, t);
    let s = Qr(t, n, r), a = Jr(t, i, s), c = is(o) ? as(o, t, a) : o;
    return { text: jl(c), incs: a.__incs || [] };
  }
  function Yl(t, e) {
    if (e.__shadowPseudo)
      return false;
    let n = ve(t), r = [];
    for (let o of ["before", "after", "firstLetter", "marker", "firstLine"]) {
      let s = n[o];
      if (s === null)
        return false;
      s && r.push(s);
    }
    if (!r.length)
      return true;
    let i = r.join(",");
    try {
      return !t.matches(i) && t.querySelector(i) === null;
    } catch {
      return false;
    }
  }
  async function _e(t, e, n, r, i = false) {
    if (t?.nodeType !== 1 || e?.nodeType !== 1 || t.tagName === "TEXTAREA")
      return;
    let o = t.ownerDocument || document;
    if (!i && !Bl(o, n) && !n.__shadowPseudo || !i && Yl(t, n))
      return;
    n.__siblingCounters || (n.__siblingCounters = new WeakMap), n.__counterCtx || (n.__counterCtx = Ul(t.ownerDocument || document, n));
    let s = n.__counterCtx, a = ve(t);
    a.marker !== "" && us(t, e, n, a.marker, "::marker", Vl), a.firstLine !== "" && us(t, e, n, a.firstLine, "::first-line", ql);
    for (let f of ["::before", "::after", "::first-letter"]) {
      let l = a[f === "::before" ? "before" : f === "::after" ? "after" : "firstLetter"];
      if (l !== null) {
        if (l === "")
          continue;
        try {
          if (!t.matches(l))
            continue;
        } catch {}
      }
      try {
        let u = W(t, f);
        if (!u || u.content === "none" && u.backgroundImage === "none" && (u.backgroundColor === "transparent" || u.backgroundColor === "rgba(0, 0, 0, 0)") && !fs(u) && (!u.transform || u.transform === "none") && u.display === "inline")
          continue;
        if (u.display === "none" || f !== "::first-letter" && (u.content === "none" || u.content === "normal")) {
          f === "::before" && (e.dataset.snapdomHasBefore = "1"), f === "::after" && (e.dataset.snapdomHasAfter = "1");
          continue;
        }
        if (f === "::first-letter") {
          let U = W(t), G = (U?.display || "").toLowerCase();
          if (G.includes("flex") || G.includes("grid"))
            continue;
          let j = (Wt) => u[Wt] !== U[Wt] && (parseFloat(u[Wt]) || 0) !== 0;
          if (!(u.color !== U.color || u.fontSize !== U.fontSize || u.fontWeight !== U.fontWeight || u.fontFamily !== U.fontFamily || u.fontStyle !== U.fontStyle || u.textTransform !== U.textTransform || u.float !== U.float && u.float !== "none" || j("paddingTop") || j("paddingRight") || j("paddingBottom") || j("paddingLeft") || j("marginTop") || j("marginRight") || j("marginBottom") || j("marginLeft")))
            continue;
          let Et = Array.from(e.childNodes).find((Wt) => Wt.nodeType === Node.TEXT_NODE && Wt.textContent?.trim().length > 0);
          if (!Et)
            continue;
          let yt = Et.textContent, fe = /^\s*/.exec(yt)[0], dn = yt.slice(fe.length), Ue = dn.match(/^([^\p{L}\p{N}\s]*[\p{L}\p{N}](?:['’])?)/u)?.[0], fr = dn.slice(Ue?.length || 0);
          if (!Ue || /[\uD800-\uDFFF]/.test(Ue))
            continue;
          let It = document.createElement("span");
          It.textContent = Ue, It.dataset.snapdomPseudo = "::first-letter";
          let ur = ge(u, yn(t)), dr = me(ur, "span");
          n.styleMap.set(It, dr);
          let pn = document.createTextNode(fr);
          e.replaceChild(pn, Et), e.insertBefore(It, pn), fe && e.insertBefore(document.createTextNode(fe), It);
          continue;
        }
        let d = u.content ?? "", m = d === "" || d === "none" || d === "normal", { text: g, incs: y } = Xl(t, f, s, n.__siblingCounters), b = u.backgroundImage, w = u.backgroundColor, C = u.fontFamily, x = parseInt(u.fontSize) || 32, S = parseInt(u.fontWeight) || false, A = u.fontStyle || "normal", v = u.color || "#000", M = u.transform, k = At(C, r?.__iconMatchers), R = !m && g !== "", E = b && b !== "none", T = w && w !== "transparent" && w !== "rgba(0, 0, 0, 0)", N = fs(u), O = M && M !== "none", H = d !== "none" && d !== "normal", _ = /^inline-/.test(u.display || ""), L = H && ((parseFloat(u.width) || 0) > 0 || (parseFloat(u.height) || 0) > 0 || _), $ = H && u.boxShadow && u.boxShadow !== "none", F = H && u.outlineStyle && u.outlineStyle !== "none" && (parseFloat(u.outlineWidth) || 0) > 0;
        if (!(R || E || T || N || O || L || $ || F)) {
          if (y && y.length && t.parentElement) {
            let U = n.__siblingCounters.get(t.parentElement) || new Map;
            for (let { name: G } of y) {
              if (!G)
                continue;
              let j = Qr(t, s, n.__siblingCounters), Et = Jr(t, W(t, f), j).get(t, G);
              U.set(G, Et);
            }
            n.__siblingCounters.set(t.parentElement, U);
          }
          continue;
        }
        let z = g.startsWith("url(") || /^-?(?:webkit-)?image-set\(/i.test(g), q = false;
        if (R && !k && g.length > 1 && !z) {
          let U = W(t), G = parseFloat(U.fontSize) || 16, j = parseFloat(U.lineHeight);
          Number.isFinite(j) || (j = G * 1.5), t.getBoundingClientRect().height < j * 1.6 && (e.style.whiteSpace = "nowrap", q = true);
        }
        let B = document.createElement("span");
        B.dataset.snapdomPseudo = f, B.style.pointerEvents = "none", q && (B.style.whiteSpace = "nowrap");
        let Z = bi(t, f, u, n, r), Mt = (W(t).display || "").toLowerCase(), Lt = Mt.includes("flex") || Mt.includes("grid");
        if (Lt) {
          let U = Z["min-width"];
          (!U || U === "auto" || U === "0px") && (Z["min-width"] = "0px");
        }
        let gt = me(Z, "span", R, Lt);
        if (n.styleMap.set(B, gt), k && g && g.length === 1) {
          let { dataUrl: U, width: G, height: j } = await Yi(g, C, S, x, v, A), ut = document.createElement("img");
          ut.src = U, ut.style = `height:${x}px;width:${G / j * x}px;object-fit:contain;`, B.appendChild(ut), e.dataset.snapdomHasIcon = "true";
        } else if (g && z) {
          let U = je(g, typeof devicePixelRatio < "u" && devicePixelRatio || 1) ?? Kt(g);
          if (U?.trim())
            try {
              let G = await it(Dt(U), { as: "dataURL", useProxy: r.useProxy });
              if (G?.ok && typeof G.data == "string") {
                let j = document.createElement("img");
                j.src = G.data, j.style = `width:${x}px;height:auto;object-fit:contain;`, B.appendChild(j);
              }
            } catch (G) {
              console.error(`[snapdom] Error in pseudo ${f} for`, t, G);
            }
        } else
          !k && R && (B.textContent = g);
        B.style.backgroundImage = "none", "maskImage" in B.style && (B.style.maskImage = "none"), "webkitMaskImage" in B.style && (B.style.webkitMaskImage = "none");
        try {
          B.style.backgroundRepeat = u.backgroundRepeat, B.style.backgroundSize = u.backgroundSize, u.backgroundPositionX && u.backgroundPositionY ? (B.style.backgroundPositionX = u.backgroundPositionX, B.style.backgroundPositionY = u.backgroundPositionY) : B.style.backgroundPosition = u.backgroundPosition, B.style.backgroundOrigin = u.backgroundOrigin, B.style.backgroundClip = u.backgroundClip, B.style.backgroundAttachment = u.backgroundAttachment, B.style.backgroundBlendMode = u.backgroundBlendMode;
        } catch {}
        if (E)
          try {
            let U = Ht(b), G = await Promise.all(U.map((j) => pe(j, r)));
            B.style.backgroundImage = G.join(", ");
          } catch (U) {
            console.warn(`[snapdom] Failed to inline background-image for ${f}`, U);
          }
        T && (B.style.backgroundColor = w);
        let st = u.maskImage || u.webkitMaskImage;
        if (st && st !== "none")
          try {
            let G = (await Promise.all(Ht(st).map((j) => pe(j, r)))).join(", ");
            B.style.maskImage = G, B.style.webkitMaskImage = G;
            for (let j of ["maskSize", "maskRepeat", "maskPosition", "maskMode", "maskComposite", "maskOrigin", "maskClip"])
              u[j] && (B.style[j] = u[j]);
          } catch (U) {
            console.warn(`[snapdom] Failed to inline mask-image for ${f}`, U);
          }
        let $t = B.childNodes.length > 0 || B.textContent?.trim() !== "" || E || T || N || O || L || $ || F;
        if (y && y.length && t.parentElement) {
          let U = n.__siblingCounters.get(t.parentElement) || new Map, G = Qr(t, s, n.__siblingCounters), j = Jr(t, W(t, f), G);
          for (let { name: ut } of y) {
            if (!ut)
              continue;
            let Et = j.get(t, ut);
            U.set(ut, Et);
          }
          n.__siblingCounters.set(t.parentElement, U);
        }
        if (!$t)
          continue;
        f === "::before" ? (e.dataset.snapdomHasBefore = "1", e.insertBefore(B, e.firstChild)) : (e.dataset.snapdomHasAfter = "1", e.appendChild(B));
      } catch (u) {
        console.warn(`[snapdom] Failed to capture ${f} for`, t, u);
      }
    }
    let c = Array.from(e.children).filter((f) => !f.dataset.snapdomPseudo);
    if (n.nodeMap)
      for (let f of c) {
        let l = n.nodeMap.get(f);
        l?.nodeType === 1 && await _e(l, f, n, r, true);
      }
    else {
      let f = Array.from(t.children);
      for (let l = 0;l < Math.min(f.length, c.length); l++)
        await _e(f[l], c[l], n, r, true);
    }
  }
  bt();
  function ps(t, e, n) {
    if (!t || t?.nodeType !== 1)
      return;
    let r = t.ownerDocument || document, i = e || r, o = Bt(t) && t.localName === "svg" ? [t] : Array.from(t.querySelectorAll("svg")), s = /url\(\s*["']?\s*#([^)"']+)/g, a = ["fill", "stroke", "filter", "clip-path", "mask", "marker", "marker-start", "marker-mid", "marker-end"], c = (S) => window.CSS && CSS.escape ? CSS.escape(S) : S.replace(/[^a-zA-Z0-9_-]/g, "\\$&"), f = "http://www.w3.org/1999/xlink", l = (S) => {
      if (!S || !S.getAttribute)
        return null;
      let A = S.getAttribute("href") || S.getAttribute("xlink:href") || (typeof S.getAttributeNS == "function" ? S.getAttributeNS(f, "href") : null);
      if (A)
        return A;
      let v = S.attributes;
      if (!v)
        return null;
      for (let M = 0;M < v.length; M++) {
        let k = v[M];
        if (!k || !k.name)
          continue;
        if (k.name === "href")
          return k.value;
        let R = k.name.indexOf(":");
        if (R !== -1 && k.name.slice(R + 1) === "href")
          return k.value;
      }
      return null;
    }, u = new Set(Array.from(t.querySelectorAll("[id]")).map((S) => S.id)), p = new Set, h = false, d = (S, A = null) => {
      if (!S)
        return;
      s.lastIndex = 0;
      let v;
      for (;v = s.exec(S); ) {
        h = true;
        let M = (v[1] || "").trim();
        M && (u.has(M) || (p.add(M), A && !A.has(M) && A.add(M)));
      }
    }, m = (S) => {
      let A = S.querySelectorAll("use");
      for (let k of A) {
        let R = l(k);
        if (!R || !R.startsWith("#"))
          continue;
        h = true;
        let E = R.slice(1).trim();
        E && !u.has(E) && p.add(E);
      }
      let v = '*[style*="url("],*[fill^="url("], *[stroke^="url("],*[filter^="url("],*[clip-path^="url("],*[mask^="url("],*[marker^="url("],*[marker-start^="url("],*[marker-mid^="url("],*[marker-end^="url("]';
      d(S.getAttribute("style") || "");
      for (let k of a)
        d(S.getAttribute(k));
      let M = S.querySelectorAll(v);
      for (let k of M) {
        d(k.getAttribute("style") || "");
        for (let R of a)
          d(k.getAttribute(R));
      }
    }, g = (S) => {
      if (!S || S.nodeType !== 1 || !S.querySelectorAll)
        return;
      let A = "filter[id],clipPath[id],mask[id],linearGradient[id],radialGradient[id],pattern[id]", v = false;
      try {
        v = !!(i.querySelector && i.querySelector(A));
      } catch {
        return;
      }
      if (!v)
        return;
      let M = ["filter", "clipPath", "mask", "maskImage", "webkitMaskImage"], k = (R) => {
        if (Bt(R))
          return;
        let E;
        try {
          E = getComputedStyle(R);
        } catch {
          return;
        }
        for (let T of M) {
          let N = E[T];
          N && N.includes("url(") && d(N);
        }
      };
      k(S);
      for (let R of S.querySelectorAll("*"))
        k(R);
    };
    for (let S of o)
      m(S);
    if (g(n), !h)
      return;
    let y = t.querySelector("svg.inline-defs-container");
    y || (y = r.createElementNS("http://www.w3.org/2000/svg", "svg"), y.classList.add("inline-defs-container"), y.setAttribute("aria-hidden", "true"), y.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden"), t.insertBefore(y, t.firstChild || null));
    let b = y.querySelector("defs") || null, w = (S) => {
      if (!S || u.has(S))
        return null;
      let A = c(S), v = (M) => {
        let k = i.querySelector(M);
        return k && !t.contains(k) ? k : null;
      };
      return v(`svg defs > *#${A}`) || v(`svg > symbol#${A}`) || v(`*#${A}`);
    };
    if (!p.size)
      return;
    let C = new Set(p), x = new Set;
    for (;C.size; ) {
      let S = C.values().next().value;
      if (C.delete(S), !S || u.has(S) || x.has(S))
        continue;
      let A = w(S);
      if (!A) {
        x.add(S);
        continue;
      }
      b || (b = r.createElementNS("http://www.w3.org/2000/svg", "defs"), y.appendChild(b));
      let v = A.cloneNode(true);
      v.id || v.setAttribute("id", S), b.appendChild(v), x.add(S), u.add(S);
      let M = [v, ...v.querySelectorAll("*")];
      for (let k of M) {
        let R = l(k);
        if (R && R.startsWith("#")) {
          let T = R.slice(1).trim();
          T && !u.has(T) && !x.has(T) && C.add(T);
        }
        let E = k.getAttribute?.("style") || "";
        E && d(E, C);
        for (let T of a) {
          let N = k.getAttribute?.(T);
          N && d(N, C);
        }
      }
    }
  }
  bt();
  var Zr = new WeakMap;
  var to = new WeakMap;
  function In(t, e, n) {
    let r = n.get(t), i = t.style;
    if (!r) {
      let s = i.cssText, a = t.hasAttribute("style");
      r = { users: 0, saved: e.map(([f, l]) => {
        let u = { property: f, value: i.getPropertyValue(f), priority: i.getPropertyPriority(f) };
        return i.setProperty(f, l, "important"), u.forcedValue = i.getPropertyValue(f), u;
      }), originalCSS: s, forcedCSS: i.cssText, hadStyle: a }, n.set(t, r);
    }
    r.users++;
    let o = false;
    return () => {
      if (!o && (o = true, !--r.users)) {
        if (n.delete(t), i.cssText === r.forcedCSS)
          i.cssText = r.originalCSS;
        else
          for (let s of r.saved)
            i.getPropertyValue(s.property) !== s.forcedValue || i.getPropertyPriority(s.property) !== "important" || (s.value ? i.setProperty(s.property, s.value, s.priority) : i.removeProperty(s.property));
        !r.hadStyle && !i.length && (t.getAttribute("style"), t.removeAttribute("style"));
      }
    };
  }
  function hs(t) {
    if (Zr.has(t))
      return In(t, [], Zr);
    let e = getComputedStyle(t), n = e.outlineStyle, r = e.outlineWidth, i = n !== "none" && parseFloat(r) > 0, o = parseFloat(e.borderTopWidth) === 0 && parseFloat(e.borderRightWidth) === 0 && parseFloat(e.borderBottomWidth) === 0 && parseFloat(e.borderLeftWidth) === 0;
    if (i && o) {
      let s = [];
      for (let a of ["top", "right", "bottom", "left"])
        s.push([`border-${a}-width`, r], [`border-${a}-style`, "solid"], [`border-${a}-color`, "transparent"]);
      return In(t, s, Zr);
    }
    return () => {};
  }
  function Wn(t, e = null) {
    let n = [], r = (i) => {
      if (!vt(i))
        return;
      if (to.has(i)) {
        n.push(In(i, [], to));
        return;
      }
      let o = getComputedStyle(i);
      (o.contentVisibility || o.getPropertyValue("content-visibility") || "") === "auto" && n.push(In(i, [["content-visibility", "visible"]], to));
    };
    try {
      if (e) {
        let o = (s) => {
          let a;
          try {
            a = s.getBoundingClientRect();
          } catch {
            return;
          }
          if (!((a.width > 0 || a.height > 0) && (a.right < e.left - 200 || a.left > e.right + 200 || a.bottom < e.top - 200 || a.top > e.bottom + 200))) {
            r(s);
            for (let c = s.firstElementChild;c; c = c.nextElementSibling)
              o(c);
          }
        };
        o(t);
      } else {
        for (let i of t.querySelectorAll("*"))
          r(i);
        r(t);
      }
    } catch {}
    return () => {
      for (let i of n)
        try {
          i();
        } catch {}
    };
  }
  ht();
  dt();
  wt();
  ye();
  wt();
  function no(t) {
    return gs(t.boxShadow);
  }
  function ro(t) {
    return gs(t.textShadow);
  }
  function gs(t) {
    if (!t || t === "none")
      return { top: 0, right: 0, bottom: 0, left: 0 };
    let e = [], n = "", r = 0;
    for (let c = 0;c < t.length; c++) {
      let f = t[c];
      f === "(" ? r++ : f === ")" && (r = Math.max(0, r - 1)), f === "," && r === 0 ? (e.push(n), n = "") : n += f;
    }
    n.trim() && e.push(n);
    let i = 0, o = 0, s = 0, a = 0;
    for (let c of e) {
      if (/\binset\b/i.test(c))
        continue;
      let f = c.match(/-?\d+(\.\d+)?px/g)?.map((g) => parseFloat(g)) || [];
      if (f.length < 2)
        continue;
      let [l, u, p = 0, h = 0] = f, d = Math.abs(l) + p + h, m = Math.abs(u) + p + h;
      o = Math.max(o, d + Math.max(l, 0)), a = Math.max(a, d + Math.max(-l, 0)), s = Math.max(s, m + Math.max(u, 0)), i = Math.max(i, m + Math.max(-u, 0));
    }
    return { top: Math.ceil(i), right: Math.ceil(o), bottom: Math.ceil(s), left: Math.ceil(a) };
  }
  function oo(t) {
    let e = t.filter && t.filter !== "none" ? t.filter : t.webkitFilter || "", n = /blur\(\s*([0-9.]+)px\s*\)/gi, r = 0, i;
    for (;i = n.exec(e); )
      r += parseFloat(i[1]) || 0;
    let o = Math.ceil(r * 2);
    return { top: o, right: o, bottom: o, left: o };
  }
  function io(t) {
    if ((t.outlineStyle || "none") === "none")
      return { top: 0, right: 0, bottom: 0, left: 0 };
    let e = Math.ceil(parseFloat(t.outlineWidth || "0") || 0), n = parseFloat(t.outlineOffset || "0") || 0, r = e + Math.max(0, Math.ceil(n));
    return { top: r, right: r, bottom: r, left: r };
  }
  function so(t) {
    let e = `${t.filter || ""} ${t.webkitFilter || ""}`.trim();
    if (!e || e === "none")
      return { bleed: { top: 0, right: 0, bottom: 0, left: 0 }, has: false };
    let n = e.match(/drop-shadow\((?:[^()]|\([^()]*\))*\)/gi) || [], r = 0, i = 0, o = 0, s = 0, a = false;
    for (let c of n) {
      a = true;
      let f = c.match(/-?\d+(?:\.\d+)?px/gi)?.map((m) => parseFloat(m)) || [], [l = 0, u = 0, p = 0] = f, h = Math.abs(l) + p, d = Math.abs(u) + p;
      i = Math.max(i, h + Math.max(l, 0)), s = Math.max(s, h + Math.max(-l, 0)), o = Math.max(o, d + Math.max(u, 0)), r = Math.max(r, d + Math.max(-u, 0));
    }
    return { bleed: { top: I(r), right: I(i), bottom: I(o), left: I(s) }, has: a };
  }
  function Kl(t) {
    let e = no(t), n = ro(t), r = oo(t), i = io(t), o = so(t);
    return { top: Math.max(e.top, n.top) + r.top + i.top + o.bleed.top, right: Math.max(e.right, n.right) + r.right + i.right + o.bleed.right, bottom: Math.max(e.bottom, n.bottom) + r.bottom + i.bottom + o.bleed.bottom, left: Math.max(e.left, n.left) + r.left + i.left + o.bleed.left };
  }
  function Ql(t) {
    return t.boxShadow && t.boxShadow !== "none" || t.textShadow && t.textShadow !== "none" || (t.outlineStyle || "none") !== "none" || t.filter && t.filter !== "none" ? true : !!t.webkitFilter && t.webkitFilter !== "none";
  }
  function ms(t) {
    let e = t.overflowX || t.overflow || "visible", n = t.overflowY || t.overflow || "visible", r = !!t.contain && /\b(paint|content|strict)\b/.test(t.contain) || !!t.clipPath && t.clipPath !== "none";
    return { x: r || e !== "visible", y: r || n !== "visible" };
  }
  function ys(t, e, n, r = 1, i = 1) {
    let o = 0, s = 0, a = 0, c = 0, f = ms(n.get(t) || W(t));
    if (f.x && f.y)
      return { top: 0, right: 0, bottom: 0, left: 0 };
    let l = t.getBoundingClientRect();
    for (let u of e.values()) {
      if (u === t || u.nodeType !== 1 || u.ownerDocument !== t.ownerDocument)
        continue;
      let p = n.get(u);
      if (!p || !Ql(p))
        continue;
      let h = Kl(p);
      if (!(h.top || h.right || h.bottom || h.left))
        continue;
      let d = u.getBoundingClientRect(), m = { left: d.left - h.left / r, top: d.top - h.top / i, right: d.right + h.right / r, bottom: d.bottom + h.bottom / i };
      for (let g = u.parentElement;g; g = g.parentElement) {
        let y = ms(n.get(g) || W(g));
        if (y.x || y.y) {
          let b = g.getBoundingClientRect();
          y.x && (m.left = Math.max(m.left, b.left), m.right = Math.min(m.right, b.right)), y.y && (m.top = Math.max(m.top, b.top), m.bottom = Math.min(m.bottom, b.bottom));
        }
        if (g === t)
          break;
      }
      f.x || (c = Math.max(c, (l.left - m.left) * r), s = Math.max(s, (m.right - l.right) * r)), f.y || (o = Math.max(o, (l.top - m.top) * i), a = Math.max(a, (m.bottom - l.bottom) * i));
    }
    return { top: Math.max(0, Math.ceil(o)), right: Math.max(0, Math.ceil(s)), bottom: Math.max(0, Math.ceil(a)), left: Math.max(0, Math.ceil(c)) };
  }
  function bs(t, e) {
    if (!t || !e || !e.style)
      return null;
    let n = getComputedStyle(t);
    try {
      e.style.transformOrigin = "0 0";
    } catch {}
    try {
      "translate" in e.style && (e.style.translate = "none"), "rotate" in e.style && (e.style.rotate = "none");
    } catch {}
    let r = n.transform || "none";
    if (!r || r === "none") {
      let c = null;
      try {
        c = se(t).scale;
      } catch {}
      try {
        e.style.transform = "none";
      } catch {}
      if (!c)
        return { a: 1, b: 0, c: 0, d: 1 };
      let f = qt({ scale: c });
      return { a: f.a, b: f.b, c: f.c, d: f.d };
    }
    function i(c, f, l, u) {
      let p = Math.sqrt(c * c + f * f) || 0, h = 0, d = 0;
      if (p > 0) {
        let m = c / p, g = f / p;
        h = m * l + g * u;
        let y = l - m * h, b = u - g * h;
        d = Math.sqrt(y * y + b * b) || 0, d > 0 ? h = h / d : h = 0;
      }
      return { a: p, b: 0, c: h * d, d };
    }
    let o = (c) => {
      let f = se(t).scale;
      if (!f)
        return c;
      let l = qt({ scale: f, baseTransform: `matrix(${c.a},${c.b},${c.c},${c.d},0,0)` });
      return { a: l.a, b: l.b, c: l.c, d: l.d };
    }, s = r.match(/^matrix\(\s*([^)]+)\)$/i);
    if (s) {
      let c = s[1].split(",").map((f) => parseFloat(f.trim()));
      if (c.length === 6 && c.every(Number.isFinite)) {
        let [f, l, u, p] = c, h = i(f, l, u, p);
        try {
          e.style.transform = `matrix(${h.a}, ${h.b}, ${h.c}, ${h.d}, 0, 0)`;
        } catch {}
        return o(h);
      }
    }
    let a = r.match(/^matrix3d\(\s*([^)]+)\)$/i);
    if (a) {
      let c = a[1].split(",").map((f) => parseFloat(f.trim()));
      if (c.length === 16 && c.every(Number.isFinite)) {
        let f = c[0], l = c[1], u = c[4], p = c[5], h = i(f, l, u, p);
        try {
          e.style.transform = `matrix(${h.a}, ${h.b}, ${h.c}, ${h.d}, 0, 0)`;
        } catch {}
        return o(h);
      }
    }
    try {
      let c = new DOMMatrix(r), f = i(c.a, c.b, c.c, c.d);
      try {
        e.style.transform = `matrix(${f.a}, ${f.b}, ${f.c}, ${f.d}, 0, 0)`;
      } catch {}
      return o(f);
    } catch {
      return null;
    }
  }
  function Re(t, e, n, r, i) {
    let { a: o, b: s, c: a, d: c } = n, f = n.e || 0, l = n.f || 0;
    function u(y, b) {
      let w = y - r, C = b - i, x = o * w + a * C, S = s * w + c * C;
      return x += r + f, S += i + l, [x, S];
    }
    let p = [u(0, 0), u(t, 0), u(0, e), u(t, e)], h = 1 / 0, d = 1 / 0, m = -1 / 0, g = -1 / 0;
    for (let [y, b] of p)
      y < h && (h = y), b < d && (d = b), y > m && (m = y), b > g && (g = b);
    return { minX: h, minY: d, maxX: m, maxY: g, width: m - h, height: g - d };
  }
  function on(t, e, n) {
    let r = (t.transformOrigin || "0 0").trim().split(/\s+/), [i, o] = [r[0] || "0", r[1] || "0"], s = (a, c) => {
      let f = a.toLowerCase();
      return f === "left" || f === "top" ? 0 : f === "center" ? c / 2 : f === "right" || f === "bottom" ? c : f.endsWith("px") ? parseFloat(f) || 0 : f.endsWith("%") ? (parseFloat(f) || 0) * c / 100 : /^-?\d+(\.\d+)?$/.test(f) && parseFloat(f) || 0;
    };
    return { ox: s(i, e), oy: s(o, n) };
  }
  function se(t) {
    let e = { rotate: "0deg", scale: null, translate: null }, n = null;
    try {
      n = typeof t.computedStyleMap == "function" ? t.computedStyleMap() : null;
    } catch {}
    if (n) {
      let i = (c) => {
        try {
          return typeof n.has == "function" && !n.has(c) || typeof n.get != "function" ? null : n.get(c);
        } catch {
          return null;
        }
      }, o = i("rotate");
      if (o)
        if (o.angle) {
          let c = o.angle;
          e.rotate = c.unit === "rad" ? c.value * 180 / Math.PI + "deg" : c.value + c.unit, o.is2D === false && o.x && o.y && o.z && (e.rotate = `${o.x.value} ${o.y.value} ${o.z.value} ${e.rotate}`);
        } else
          o.unit ? e.rotate = o.unit === "rad" ? o.value * 180 / Math.PI + "deg" : o.value + o.unit : e.rotate = String(o);
      else {
        let c = getComputedStyle(t);
        e.rotate = c.rotate && c.rotate !== "none" ? c.rotate : "0deg";
      }
      let s = i("scale");
      if (s) {
        let c = (f) => f && f.value != null ? `${f.value}${f.unit === "percent" ? "%" : ""}` : null;
        "x" in s && s.x?.value != null ? e.scale = [c(s.x), c(s.y) ?? c(s.x), ...s.is2D === false ? [c(s.z) ?? "1"] : []].join(" ") : Array.isArray(s) ? e.scale = s.map(c).join(" ") : e.scale = String(s);
      } else {
        let c = getComputedStyle(t);
        e.scale = c.scale && c.scale !== "none" ? c.scale : null;
      }
      let a = i("translate");
      if (a) {
        let c = (f) => f && f.value != null ? `${f.value}${f.unit === "percent" ? "%" : f.unit || "px"}` : null;
        "x" in a && a.x?.value != null ? e.translate = [c(a.x), c(a.y) ?? "0px", ...a.is2D === false ? [c(a.z) ?? "0px"] : []].join(" ") : Array.isArray(a) ? e.translate = a.map(c).join(" ") : e.translate = String(a);
      } else {
        let c = getComputedStyle(t);
        e.translate = c.translate && c.translate !== "none" ? c.translate : null;
      }
      return (!e.rotate || e.rotate === "none") && (e.rotate = "0deg"), (!e.scale || e.scale === "none") && (e.scale = null), (!e.translate || e.translate === "none") && (e.translate = null), e;
    }
    let r = getComputedStyle(t);
    return e.rotate = r.rotate && r.rotate !== "none" ? r.rotate : "0deg", e.scale = r.scale && r.scale !== "none" ? r.scale : null, e.translate = r.translate && r.translate !== "none" ? r.translate : null, e;
  }
  var eo = null;
  function Jl() {
    if (eo?.isConnected)
      return eo;
    let t = document.createElement("div");
    return t.id = "snapdom-measure-slot", t.setAttribute("aria-hidden", "true"), J(t), Object.assign(t.style, { position: "absolute", left: "-99999px", top: "0px", width: "0px", height: "0px", overflow: "hidden", opacity: "0", pointerEvents: "none", contain: "size layout style" }), document.documentElement.appendChild(t), eo = t, t;
  }
  function qt(t) {
    let e = (o) => {
      let s = [], a = 0, c = 0, f = String(o).trim();
      for (let l = 0;l < f.length; l++)
        f[l] === "(" ? a++ : f[l] === ")" ? a-- : /\s/.test(f[l]) && !a && (l > c && s.push(f.slice(c, l)), c = l + 1);
      return c < f.length && s.push(f.slice(c)), s;
    }, n = (o) => o && o !== "none", r = [];
    if (n(t.translate)) {
      let o = e(t.translate);
      for (let s = 0;s < 2 && s < o.length; s++) {
        let a = s === 0 ? t.width : t.height;
        /^[+-]?(?:\d*\.)?\d+%$/.test(o[s]) && Number.isFinite(a) && (o[s] = `${parseFloat(o[s]) * a / 100}px`);
      }
      r.push(o.length > 2 ? `translate3d(${o.join(",")})` : `translate(${o.join(",")})`);
    }
    if (n(t.rotate) && t.rotate !== "0deg") {
      let o = e(t.rotate);
      o.length === 4 ? r.push(`rotate3d(${o.join(",")})`) : o.length === 2 && /^[xyz]$/i.test(o[0]) ? r.push(`rotate${o[0].toUpperCase()}(${o[1]})`) : r.push(`rotate(${o.join(" ")})`);
    }
    if (n(t.scale)) {
      let o = e(t.scale).map((s) => /%$/.test(s) ? String(parseFloat(s) / 100) : s);
      r.push(o.length > 2 ? `scale3d(${o.join(",")})` : `scale(${o.join(",")})`);
    }
    if (n(t.baseTransform) && r.push(t.baseTransform), !r.length)
      return new DOMMatrix;
    let i = r.join(" ");
    try {
      if (i.includes("%"))
        throw new Error("Transform needs a reference box");
      return new DOMMatrix(i);
    } catch {
      let o = Jl(), s = document.createElement("div");
      if (s.style.cssText = "all:initial!important;display:block!important;transform-origin:0 0!important", s.style.setProperty("width", `${Number.isFinite(t.width) ? t.width : 0}px`, "important"), s.style.setProperty("height", `${Number.isFinite(t.height) ? t.height : 0}px`, "important"), s.style.setProperty("transform", i, "important"), !s.style.transform)
        throw new Error("Invalid transform composition");
      o.appendChild(s);
      try {
        return Zl(s);
      } finally {
        s.remove();
      }
    }
  }
  function ws(t) {
    let e = W(t), n = e.transform || "none";
    if (n !== "none" && !/^matrix\(\s*1\s*,\s*0\s*,\s*0\s*,\s*1\s*,\s*0\s*,\s*0\s*\)$/i.test(n))
      return true;
    let i = e.rotate && e.rotate !== "none" && e.rotate !== "0deg", o = e.scale && e.scale !== "none" && e.scale !== "1", s = e.translate && e.translate !== "none" && e.translate !== "0px 0px";
    return !!(i || o || s);
  }
  function Zl(t) {
    let e = getComputedStyle(t).transform;
    if (!e || e === "none")
      return new DOMMatrix;
    try {
      return new DOMMatrix(e);
    } catch {
      return new WebKitCSSMatrix(e);
    }
  }
  var ks = new WeakSet;
  function On(t, e) {
    if (!e)
      return null;
    let n = t.ownerDocument || document, r = n.defaultView || window, i, o, s, a;
    if (e === "viewport")
      i = 0, o = 0, s = n.documentElement?.clientWidth || r.innerWidth, a = n.documentElement?.clientHeight || r.innerHeight;
    else if (typeof e == "object")
      i = (Number(e.x) || 0) - (r.scrollX || 0), o = (Number(e.y) || 0) - (r.scrollY || 0), s = Number(e.width), a = Number(e.height);
    else
      return null;
    return s > 0 && a > 0 ? { left: i, top: o, width: s, height: a, right: i + s, bottom: o + a } : null;
  }
  function ao(t) {
    if (t.parentElement)
      return t.parentElement;
    let e = t.getRootNode && t.getRootNode();
    return ue(e) ? e.host : null;
  }
  function tf(t, e) {
    for (let n = e;n; n = ao(n))
      if (n === t)
        return true;
    return false;
  }
  function ef(t, e) {
    for (let n = ao(t);n && n !== e && n?.nodeType === 1; n = ao(n)) {
      let r = W(n);
      if (r.position !== "static" || r.transform && r.transform !== "none" || r.filter && r.filter !== "none" || r.backdropFilter && r.backdropFilter !== "none" || r.perspective && r.perspective !== "none" || /transform|perspective|filter/.test(r.willChange || "") || /layout|paint|strict|content/.test(r.contain || ""))
        return n;
    }
    return null;
  }
  function lo(t, e) {
    try {
      return qt({ baseTransform: t, rotate: e?.rotate, scale: e?.scale });
    } catch {
      return null;
    }
  }
  function Cs(t, e, n, r, i) {
    let o = t.getBoundingClientRect();
    vt(e) && W(t).position === "static" && (e.style.position = "relative");
    let s = [];
    for (let [a, c] of n) {
      if (!vt(a) || c?.nodeType !== 1 || c === t || !tf(t, c))
        continue;
      let f = r.get(c) || W(c), l = f.position;
      if (l !== "fixed" && l !== "sticky" && l !== "-webkit-sticky" || a.style.position === "absolute")
        continue;
      let u = c.getBoundingClientRect();
      if (!(u.width > 0 && u.height > 0))
        continue;
      ks.add(a);
      let p = f.transform && f.transform !== "none" ? f.transform : "", h = se(c), d = !!(p || h.rotate !== "0deg" || h.scale || h.translate), m = d ? lo(p, h) : null, g = !m || !m.is2D || m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1, y = u.width, b = u.height;
      g || (y = c.offsetWidth || u.width, b = c.offsetHeight || u.height);
      let w = c.getRootNode && ue(c.getRootNode()), C = o, x = t.clientLeft || 0, S = t.clientTop || 0;
      if (w) {
        let R = ef(c, t);
        R && (C = R.getBoundingClientRect(), x = R.clientLeft || 0, S = R.clientTop || 0);
      }
      let A = u.left - C.left - x, v = u.top - C.top - S;
      if (d)
        if (a.style.translate = "none", a.style.rotate = "none", a.style.scale = "none", g)
          a.style.transform = "none";
        else {
          a.style.transform = `matrix(${m.a},${m.b},${m.c},${m.d},0,0)`;
          let { ox: R, oy: E } = on(f, y, b), T = Re(y, b, { a: m.a, b: m.b, c: m.c, d: m.d, e: 0, f: 0 }, R, E);
          A -= T.minX, v -= T.minY;
        }
      if (l !== "fixed") {
        let R = a.cloneNode(false);
        R.setAttribute("data-snap-ph", "1"), R.style.position = "static", R.style.visibility = "hidden", R.style.width = `${y}px`, R.style.height = `${b}px`, R.style.boxSizing = "border-box", a.parentElement?.insertBefore(R, a);
      }
      let M = y + 2, k = b;
      i && (Math.abs(v - i.y) < 0.5 && (v -= 1, k += 1), Math.abs(A - i.x) < 0.5 && (A -= 1, M += 1)), a.style.position = "absolute", a.style.left = `${A}px`, a.style.top = `${v}px`, a.style.right = "auto", a.style.bottom = "auto", a.style.margin = "0", a.style.width = `${M}px`, a.style.height = `${k}px`, a.style.boxSizing = "border-box", w || s.push(a);
    }
    for (let a of s)
      e.appendChild(a);
  }
  function As(t, e, n = {}) {
    if (!t || !e || !e.style)
      return;
    let r = getComputedStyle(t);
    try {
      e.style.boxShadow = "none";
    } catch (s) {
      D(n, "stripRootShadows boxShadow", s);
    }
    try {
      e.style.textShadow = "none";
    } catch (s) {
      D(n, "stripRootShadows textShadow", s);
    }
    try {
      e.style.outline = "none";
    } catch (s) {
      D(n, "stripRootShadows outline", s);
    }
    let o = (r.filter || "").replace(/\bdrop-shadow\((?:[^()]|\([^()]*\))*\)\s*/gi, "").trim().replace(/\s+/g, " ");
    try {
      e.style.filter = o.length ? o : "none";
    } catch (s) {
      D(n, "stripRootShadows filter", s);
    }
  }
  function Ms(t, e) {
    if (!t || !e || !e.style)
      return;
    let n = 1;
    try {
      n = parseFloat(getComputedStyle(t).zoom);
    } catch {
      return;
    }
    if (!(!e.style.getPropertyValue("zoom") && (!Number.isFinite(n) || n === 1)))
      try {
        e.style.setProperty("zoom", "1", "important");
      } catch {}
  }
  function Ss(t) {
    let e = t.display || "";
    if (e.includes("flex") || e.includes("grid") || e.startsWith("table") || e === "inline-block" || e === "flow-root" || t.position === "absolute" || t.position === "fixed" || t.float && t.float !== "none")
      return true;
    let n = t.overflowX || t.overflow || "visible", r = t.overflowY || t.overflow || "visible";
    return !!(n !== "visible" || r !== "visible" || t.contain && /\b(layout|content|paint|strict)\b/.test(t.contain));
  }
  function nf(t, e) {
    let n = Array.from(t.childNodes), r = e === "top" ? n : n.reverse();
    for (let i of r) {
      if (i.nodeType === Node.TEXT_NODE) {
        if (/\S/.test(i.textContent || ""))
          return null;
        continue;
      }
      if (i.nodeType !== Node.ELEMENT_NODE)
        continue;
      let o = getComputedStyle(i), s = String(o.display || "");
      if (!(s === "none" || s === "contents") && !(o.position === "absolute" || o.position === "fixed"))
        return o.float && o.float !== "none" || s.startsWith("inline") ? null : i;
    }
    return null;
  }
  function Es(t, e, n) {
    if (!t || !e || !e.style)
      return;
    let r = getComputedStyle(t);
    if (!Ss(r))
      for (let i of ["top", "bottom"]) {
        let o = i === "top" ? "Top" : "Bottom";
        if ((parseFloat(r[`border${o}Width`]) || 0) > 0 || (parseFloat(r[`padding${o}`]) || 0) > 0)
          continue;
        let s = t, a = e;
        for (;s && a; ) {
          let c = nf(s, i);
          if (!c)
            break;
          let f = n ? Array.from(a.children).find((p) => n.get(p) === c) || null : a.children[Array.from(s.children).indexOf(c)] || null, l = getComputedStyle(c), u = parseFloat(l[`margin${o}`]) || 0;
          if (f && f.style && u > 0 && (f.style[`margin${o}`] = "0px"), Ss(l) || (parseFloat(l[`border${o}Width`]) || 0) > 0 || (parseFloat(l[`padding${o}`]) || 0) > 0)
            break;
          s = c, a = f;
        }
      }
  }
  var rf = new Set(["xml", "xlink"]);
  function of(t, e) {
    if (t.startsWith("*") || t.includes("@"))
      return true;
    if (t.includes(":")) {
      let n = t.split(":", 1)[0];
      if (!rf.has(n))
        return true;
    }
    return e ? t.startsWith("x-") || t.startsWith("v-") || t.startsWith(":") || t.startsWith("on:") || t.startsWith("bind:") || t.startsWith("let:") || t.startsWith("class:") : false;
  }
  var sf = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF\uFFFE\uFFFF]/g;
  var xs = (t) => t.replace(sf, (e) => e.length === 2 ? e : "");
  var af = /^data:[^,]{0,120};base64,/;
  function Dn(t, e = {}) {
    if (!t)
      return;
    let { stripFrameworkDirectives: n = true } = e, r = (a) => {
      for (let c of Array.from(a.attributes)) {
        if (of(c.name, n)) {
          a.removeAttribute(c.name);
          continue;
        }
        if (af.test(c.value))
          continue;
        let f = xs(c.value);
        if (f !== c.value)
          try {
            a.setAttribute(c.name, f);
          } catch {}
      }
    };
    t.nodeType === Node.ELEMENT_NODE && r(t);
    let i = [], o = document.createTreeWalker(t, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT), s;
    for (;s = o.nextNode(); )
      if (s.nodeType === Node.ELEMENT_NODE)
        r(s);
      else if (s.nodeType === Node.COMMENT_NODE)
        i.push(s);
      else {
        let a = xs(s.data);
        a !== s.data && (s.data = a);
      }
    for (let a of i)
      a.remove();
  }
  function cf(t) {
    try {
      let e = t.getAttribute?.("style") || "";
      return /\b(height|width|block-size|inline-size)\s*:/.test(e);
    } catch {
      return false;
    }
  }
  var lf = new Set(["img", "canvas", "video", "iframe", "object", "embed"]);
  function ff(t) {
    return Bt(t) || lf.has(t?.localName);
  }
  function uf(t, e) {
    if (t?.nodeType !== 1 || cf(t) || ff(t))
      return false;
    let n = e.position;
    if (n === "absolute" || n === "fixed" || n === "sticky")
      return false;
    let r = e.display || "";
    return !(r.includes("flex") || r.includes("grid") || r.startsWith("table") || e.transform && e.transform !== "none");
  }
  function _s(t, e, n = new Map, r = null) {
    function i(o, s) {
      if (o?.nodeType !== 1 || s?.nodeType !== 1)
        return;
      let a = o.childElementCount > s.childElementCount, c = n.get(o) || getComputedStyle(o);
      if (n.has(o) || n.set(o, c), a && uf(o, c)) {
        s.style.height || (s.style.height = "auto"), s.style.width || (s.style.width = "auto"), s.style.removeProperty("block-size"), s.style.removeProperty("inline-size"), s.style.minHeight || (s.style.minHeight = "0"), s.style.minWidth || (s.style.minWidth = "0"), s.style.maxHeight || (s.style.maxHeight = "none"), s.style.maxWidth || (s.style.maxWidth = "none");
        let l = c.overflowY || c.overflowBlock || "visible", u = c.overflowX || c.overflowInline || "visible";
        (l !== "visible" || u !== "visible") && (s.style.overflow = "visible");
      }
      let f = Array.from(s.children);
      if (r)
        for (let l of f) {
          let u = r.get(l);
          u && u.nodeType === 1 && i(u, l);
        }
      else {
        let l = Array.from(o.children);
        for (let u = 0;u < Math.min(l.length, f.length); u++)
          i(l[u], f[u]);
      }
    }
    i(t, e);
  }
  function df(t) {
    let e = getComputedStyle(t);
    return !(e.display === "none" || e.position === "absolute" || e.position === "fixed");
  }
  function pf(t, e) {
    if (t?.nodeType !== 1)
      return false;
    if (t.getAttribute("data-capture") === "exclude")
      return e?.excludeMode === "remove";
    if (Array.isArray(e?.exclude))
      for (let n of e.exclude)
        try {
          if (t.matches(n))
            return e.excludeMode === "remove";
        } catch (r) {
          D(e, "exclude selector match failed", r);
        }
    if (Array.isArray(e?.excludePredicates))
      for (let n of e.excludePredicates)
        try {
          if (n(t))
            return e.excludeMode === "remove";
        } catch (r) {
          D(e, "exclude predicate failed", r);
        }
    if (typeof e?.filter == "function" && e.filterMode === "remove")
      try {
        if (!e.filter(t))
          return true;
      } catch (n) {
        D(e, "filter function failed", n);
      }
    return false;
  }
  function fo(t, e) {
    let n = getComputedStyle(t), r = t.getBoundingClientRect(), i = 1 / 0, o = -1 / 0, s = false, a = Array.from(t.children);
    for (let h of a) {
      if (pf(h, e) || !df(h))
        continue;
      let d = h.getBoundingClientRect(), m = d.top - r.top, g = d.bottom - r.top;
      g <= m || (m < i && (i = m), g > o && (o = g), s = true);
    }
    let c = s ? Math.max(0, o - i) : 0, f = parseFloat(n.borderTopWidth) || 0, l = parseFloat(n.borderBottomWidth) || 0, u = parseFloat(n.paddingTop) || 0, p = parseFloat(n.paddingBottom) || 0;
    return f + l + u + p + c;
  }
  var I = (t, e = 3) => Number.isFinite(t) ? Math.round(t * 10 ** e) / 10 ** e : t;
  var Fe = 0.75;
  function Rs(t, e, n, r, i, o) {
    let s = t.ownerDocument || document, a = t.getBoundingClientRect(), c = i > 0 && a.width > 0 ? a.width / i : 1, f = o > 0 && a.height > 0 ? a.height / o : 1;
    if (Math.abs(c - f) > 0.02)
      return 0;
    let l = s.createElement("div");
    J(l), l.style.cssText = "position:absolute!important;left:-9999px!important;top:0!important;width:" + i + "px!important;overflow:visible!important;visibility:hidden!important;";
    let u = l.attachShadow({ mode: "open" }), p = s.createElement("style");
    p.textContent = n, u.appendChild(p);
    let h = e.cloneNode(true);
    u.appendChild(h), s.body.appendChild(l);
    let d = 0, m = (g, y, b) => {
      let w = W(g), C = w.boxSizing === "border-box", x = (S, A, ...v) => {
        let M = parseFloat(S);
        if (!Number.isFinite(M))
          return A;
        let k = M + (C ? 0 : v.reduce((R, E) => R + (parseFloat(E) || 0), 0));
        return Math.abs(k - A) <= 0.51 ? k : A;
      };
      return { width: x(w.width, y, w.paddingLeft, w.paddingRight, w.borderLeftWidth, w.borderRightWidth), height: x(w.height, b, w.paddingTop, w.paddingBottom, w.borderTopWidth, w.borderBottomWidth) };
    };
    try {
      let g = h.getBoundingClientRect(), y = h.offsetWidth || i, b = h.offsetHeight || o, w = y > 0 && g.width > 0 ? g.width / y : 1, C = b > 0 && g.height > 0 ? g.height / b : 1, x = (S, A, v = false) => {
        let M = S.children, k = A.children, R = Math.min(M.length, k.length);
        for (let E = 0;E < R; E++) {
          let T = M[E], N = k[E], O = r.get(T), H = v || ks.has(T);
          if (O?.nodeType === 1 && vt(T) && T.style && O.isConnected) {
            let _ = O.getBoundingClientRect();
            if (_.width > 0 && _.height > 0) {
              let L = N.getBoundingClientRect(), $ = _.width / c, F = _.height / f, V = L.width, z = L.height, q = O.offsetWidth || $, B = O.offsetHeight || F, Z = N.offsetWidth || V, Mt = N.offsetHeight || z, Lt = Math.abs($ - q) > Fe || Math.abs(F - B) > Fe || Math.abs(V - Z) > Fe || Math.abs(z - Mt) > Fe;
              if (H) {
                let at = m(N, Z, Mt);
                $ = V > 0 ? $ * w * at.width / V : $, F = z > 0 ? F * C * at.height / z : F, V = at.width, z = at.height;
              } else if (Lt) {
                let at = m(O, q, B), $t = m(N, Z, Mt);
                $ = at.width, F = at.height, V = $t.width, z = $t.height;
              }
              let gt = V - $, st = z - F;
              (Math.abs(gt) > Fe || Math.abs(st) > Fe) && (T.style.boxSizing = "border-box", T.style.width = `${I($)}px`, T.style.height = `${I(F)}px`, d++);
            }
          }
          x(T, N, H);
        }
      };
      x(e, h);
    } finally {
      l.remove();
    }
    return d;
  }
  var hf = /::-webkit-scrollbar(-[a-z]+)?\b/i;
  function co(t, e = new Set) {
    let n = "";
    if (!t)
      return n;
    for (let r = 0;r < t.length; r++) {
      let i = t[r];
      try {
        if (i.type === CSSRule.IMPORT_RULE && i.styleSheet) {
          n += co(i.styleSheet.cssRules, e);
          continue;
        }
        if (i.type === CSSRule.MEDIA_RULE && i.cssRules) {
          let o = co(i.cssRules, e);
          o && (n += `@media ${i.conditionText}{${o}}`);
          continue;
        }
        if (i.type === CSSRule.STYLE_RULE) {
          let o = i.selectorText || "";
          if (hf.test(o)) {
            let s = i.cssText;
            s && !e.has(s) && (e.add(s), n += s);
          }
        }
      } catch {}
    }
    return n;
  }
  var vs = new WeakMap;
  function mf(t) {
    let e = "";
    for (let n of t.styleSheets) {
      let r = -1;
      try {
        r = n.cssRules ? n.cssRules.length : -1;
      } catch {}
      e += (n.href || "inline") + ":" + r + "|";
    }
    return e;
  }
  function gf(t) {
    if (!t || !t.styleSheets)
      return "";
    let e = mf(t), n = vs.get(t);
    if (n && n.fp === e)
      return n.css;
    let r = new Set, i = "";
    for (let o of Array.from(t.styleSheets))
      try {
        let s = o.cssRules;
        s && (i += co(s, r));
      } catch {}
    return vs.set(t, { fp: e, css: i }), i;
  }
  function Fs(t, e) {
    let n = Er(t.clone).sort(), r = n.join(","), i;
    P.baseStyle.has(r) ? i = P.baseStyle.get(r) : (i = _r(n, Ze(t.element)), P.baseStyle.set(r, i));
    let o = gf(t.element?.ownerDocument || document);
    return t.fontsCSS = e, t.baseCSS = i, t.scrollbarCSS = o, { baseCSS: i, scrollbarCSS: o, fontsCSS: e };
  }
  kt();
  var Bn = new Set;
  async function Ts(t, e = {}) {
    Rt(), xn(t.ownerDocument || document);
    let n = e.__session || { styleMap: new Map, styleCache: new WeakMap, nodeMap: new Map }, r = { styleMap: n.styleMap, styleCache: n.styleCache, nodeMap: n.nodeMap, options: e }, i = null, o = null;
    if (e.clip && (o = On(t, e.clip), o && (r.clip = { rect: o, root: t })), e.captureSelection)
      try {
        r.selection = Oi(t);
      } catch (d) {
        D(r, "prepareSelectionContext failed", d);
      }
    let s, a = "", c = "";
    if (Bn.size) {
      let d = (m, g) => {
        for (let y = g;y; y = y.assignedSlot || y.parentElement || y.getRootNode()?.host)
          if (y === m)
            return true;
        return false;
      };
      for (;; ) {
        let m = [...Bn].filter(({ root: g }) => d(g, t) || d(t, g)).map(({ promise: g }) => g.catch(() => {}));
        if (!m.length)
          break;
        await Promise.all(m);
      }
    }
    if (!r.clip && t.isConnected && t.ownerDocument?.visibilityState !== "hidden")
      try {
        let d = t.getBoundingClientRect(), m = t.ownerDocument?.defaultView || window, g = d.right <= 0 || d.bottom <= 0 || d.left >= m.innerWidth || d.top >= m.innerHeight, y = [];
        if (g && (() => {
          let w = [];
          t.shadowRoot && w.push(t.shadowRoot);
          for (let C of t.querySelectorAll("*"))
            C.shadowRoot && w.push(C.shadowRoot);
          for (;w.length; ) {
            let C = w.pop(), x = C.host?.localName === "calcite-icon";
            for (let S of C.querySelectorAll("*")) {
              if (S.shadowRoot && w.push(S.shadowRoot), !x || S.localName !== "svg")
                continue;
              let A = S.querySelectorAll("path");
              if (!A.length || [...A].some((M) => M.getAttribute("d")?.trim()))
                continue;
              let v = S.getBoundingClientRect();
              v.width && v.height && y.push(S);
            }
          }
        })(), y.length) {
          let w = (async () => {
            let x = t.style, S = t.hasAttribute("style"), A = new Map, v = (M, k) => {
              A.has(M) || A.set(M, { value: x.getPropertyValue(M), priority: x.getPropertyPriority(M) }), x.setProperty(M, k, "important");
              let R = A.get(M);
              R.forcedValue = x.getPropertyValue(M), R.forcedPriority = x.getPropertyPriority(M);
            };
            try {
              v("left", "0"), v("top", "0"), v("right", "auto"), v("bottom", "auto"), v("margin-top", "0"), v("margin-right", "0"), v("margin-bottom", "0"), v("margin-left", "0"), v("transform", "none"), v("translate", "none"), v("opacity", "0"), v("pointer-events", "none");
              let M = t.getBoundingClientRect();
              if (M.right <= 0 || M.bottom <= 0 || M.left >= m.innerWidth || M.top >= m.innerHeight) {
                let E = t.parentElement?.getBoundingClientRect(), T = E && E.right > 0 && E.left < m.innerWidth ? Math.max(0, E.left) : 0, N = E && E.bottom > 0 && E.top < m.innerHeight ? Math.max(0, E.top) : 0;
                v("position", "fixed"), v("left", `${T}px`), v("top", `${N}px`);
              }
              await pt(100);
              let k = Date.now() + 1500, R = () => y.some((E) => {
                if ([...E.querySelectorAll("path")].some((N) => N.getAttribute("d")?.trim()))
                  return false;
                let T = E.getBoundingClientRect();
                return T.width && T.height && T.right > 0 && T.bottom > 0 && T.left < m.innerWidth && T.top < m.innerHeight;
              });
              for (;Date.now() < k && R(); )
                await new Promise((E) => setTimeout(E, 25));
              await pt(100);
            } finally {
              for (let [M, k] of A)
                x.getPropertyValue(M) !== k.forcedValue || x.getPropertyPriority(M) !== k.forcedPriority || (k.value ? x.setProperty(M, k.value, k.priority) : x.removeProperty(M));
              !S && !x.length && t.removeAttribute("style"), await pt(100);
            }
          })(), C = { root: t, promise: w };
          Bn.add(C);
          try {
            await w;
          } finally {
            Bn.delete(C);
          }
        }
      } catch {}
    let f = hs(t), l = Wn(t, o);
    if (o) {
      let d = t.getBoundingClientRect(), m = t.offsetWidth || d.width, g = t.offsetHeight || d.height, y = d.width && Math.abs(m - d.width) >= 1 ? m / d.width : 1, b = d.height && Math.abs(g - d.height) >= 1 ? g / d.height : 1;
      i = { x: (o.left - d.left) * y, y: (o.top - d.top) * b, width: o.width * y, height: o.height * b };
    }
    try {
      s = await ie(t, r, e);
    } catch (d) {
      throw console.warn("deepClone failed:", d), d;
    } finally {
      l(), f();
    }
    try {
      ps(s, undefined, t);
    } catch (d) {
      console.warn("inlineExternal defs or symbol failed:", d);
    }
    try {
      await _e(t, s, r, e);
    } catch (d) {
      console.warn("inlinePseudoElements failed:", d);
    }
    await Cn(s, r);
    for (let [d, m] of r.nodeMap.entries())
      if (m?.tagName === "STYLE" && d?.tagName === "STYLE" && !d.hasAttribute("data-sd"))
        try {
          let g = m.sheet && m.sheet.cssRules;
          g && /@media/i.test(d.textContent || "") && (d.textContent = oe(g));
        } catch {}
    try {
      let d = s.querySelectorAll("style[data-sd]");
      for (let m of d)
        c += m.textContent || "", m.remove();
    } catch (d) {
      D(r, "Failed to extract shadow CSS from style[data-sd]", d);
    }
    let u = Ge(r.styleMap);
    a = Array.from(u.entries()).map(([d, m]) => `.${m}{${d}}`).join("");
    let h = c + "[data-snapdom-has-after]::after,[data-snapdom-has-before]::before{content:none!important;display:none!important}" + (r.__pseudoCSS || "");
    a = h + a;
    for (let [d, m] of r.styleMap.entries())
      uo(d, m, u);
    try {
      yf(t, s, r.nodeMap);
    } catch (d) {
      D(r, "top-layer lift failed", d);
    }
    if ((r.clip || t.scrollTop || t.scrollLeft) && s?.nodeType === 1)
      try {
        let d = r.clip && i ? { x: i.x, y: i.y } : { x: 0, y: 0 };
        Cs(t, s, r.nodeMap, r.styleCache, d);
      } catch (d) {
        D(r, "freezeViewportPositioned failed", d);
      }
    for (let [d, m] of r.nodeMap.entries())
      r.clip && m === t || po(d, m);
    if (t === r.nodeMap.get(s)) {
      let d = r.styleCache.get(t) || W(t);
      r.styleCache.set(t, d);
      let m = mr(d.transform);
      s.style.margin = "0", s.style.top = "auto", s.style.left = "auto", s.style.right = "auto", s.style.bottom = "auto", s.style.animation = "none", s.style.transition = "none", s.style.willChange = "auto", s.style.float = "none", s.style.clear = "none", s.style.transform = m || "", s.style.translate = "none";
    }
    for (let [d, m] of r.nodeMap.entries())
      m.tagName === "PRE" && (d.style.marginTop = "0", d.style.marginBlockStart = "0");
    return { clone: s, classCSS: a, classPrefixCSS: h, styleCache: r.styleCache, nodeMap: r.nodeMap, reconcileRisk: r.reconcileRisk || 0, clipWindow: i };
  }
  function yf(t, e, n) {
    let r = [];
    for (let s of [":modal", ":popover-open"])
      try {
        r.push(...t.querySelectorAll(s));
      } catch {}
    if (!r.length)
      return;
    let i = new Map;
    for (let [s, a] of n.entries())
      i.set(a, s);
    let o = 2147480000;
    for (let s of r) {
      let a = i.get(s);
      if (!(!a || a === e || a.parentNode == null)) {
        try {
          let c = getComputedStyle(s, "::backdrop"), f = c.backgroundColor, l = c.backgroundImage;
          if (f && f !== "rgba(0, 0, 0, 0)" && f !== "transparent" || l && l !== "none") {
            let p = document.createElement("div");
            p.setAttribute("data-sd-backdrop", ""), p.style.cssText = `position:fixed;inset:0;z-index:${o};background-color:${f};` + (l && l !== "none" && l.includes("data:") ? `background-image:${l};` : ""), e.appendChild(p);
          }
        } catch {}
        o += 1, a.style.zIndex = String(o), e.appendChild(a), o += 1;
      }
    }
  }
  function uo(t, e, n) {
    if (t.tagName === "STYLE")
      return;
    if (t.getRootNode && ue(t.getRootNode())) {
      t.setAttribute("style", e.replace(/;/g, "; "));
      return;
    }
    let r = n.get(e);
    r && t.classList.add(r);
    let i = t.style?.backgroundImage, o = t.dataset?.snapdomHasIcon;
    i && i !== "none" && (t.style.backgroundImage = i), o && (t.style.verticalAlign = "middle", t.style.display = "inline");
  }
  function po(t, e) {
    let { scrollLeft: n, scrollTop: r } = e;
    if (!(n || r) || t?.nodeType !== 1 || t.namespaceURI !== "http://www.w3.org/1999/xhtml")
      return;
    t.style.overflow = "hidden", t.style.scrollbarWidth = "none", t.style.msOverflowStyle = "none";
    try {
      let s = t.querySelectorAll("*");
      for (let a of s) {
        if (a.nodeType !== 1 || a.namespaceURI !== "http://www.w3.org/1999/xhtml")
          continue;
        let c = a.style.position;
        if (c === "fixed" || c === "absolute") {
          let f = parseFloat(a.style.top) || 0, l = parseFloat(a.style.left) || 0;
          a.style.top = `${f + r}px`, a.style.left = `${l + n}px`, c === "fixed" && (a.style.position = "absolute");
        }
      }
    } catch {}
    let o = document.createElement("div");
    for (o.style.all = "unset", o.style.transform = `translate(${-n}px, ${-r}px)`, o.style.willChange = "transform", o.style.display = "inline-block", o.style.width = "100%";t.firstChild; )
      o.appendChild(t.firstChild);
    t.appendChild(o);
  }
  de();
  Qt();
  dt();
  var $s = "http://www.w3.org/1999/xlink";
  function bf(t) {
    return t.getAttribute("href") || t.getAttribute("xlink:href") || (typeof t.getAttributeNS == "function" ? t.getAttributeNS($s, "href") : null);
  }
  function wf(t) {
    let e = parseFloat(t.dataset?.snapdomWidth || "") || 0, n = parseFloat(t.dataset?.snapdomHeight || "") || 0, r = parseInt(t.getAttribute("width") || "", 10) || 0, i = parseInt(t.getAttribute("height") || "", 10) || 0, o = parseFloat(t.style?.width || "") || 0, s = parseFloat(t.style?.height || "") || 0, a = e || o || r || t.width || t.naturalWidth || 100, c = n || s || i || t.height || t.naturalHeight || 100;
    return { width: a, height: c };
  }
  async function Un(t, e = {}) {
    let n = Array.from(t.querySelectorAll("img"));
    t.tagName === "IMG" && n.unshift(t);
    let r = async (a) => {
      if (!a.getAttribute("src")) {
        let d = a.currentSrc || a.src || Ce(a.getAttribute("srcset"), a) || "";
        d && a.setAttribute("src", d);
      }
      if (a.removeAttribute("srcset"), a.removeAttribute("sizes"), (a.getAttribute("src") || "").startsWith("data:")) {
        a.width || (a.width = a.naturalWidth || 100), a.height || (a.height = a.naturalHeight || 100);
        return;
      }
      let c = a.src || "";
      if (!c)
        return;
      let f = P.image?.get(c);
      if (f) {
        a.src = f, a.width || (a.width = a.naturalWidth || 100), a.height || (a.height = a.naturalHeight || 100);
        return;
      }
      let l = await it(c, { as: "dataURL", useProxy: e.useProxy });
      if (l.ok && typeof l.data == "string" && l.data.startsWith("data:")) {
        P.image?.set(c, l.data), a.src = l.data, l.blob && (a.__snapdomBlob = l.blob), a.width || (a.width = a.naturalWidth || 100), a.height || (a.height = a.naturalHeight || 100);
        return;
      }
      let { width: u, height: p } = wf(a), { fallbackURL: h } = e || {};
      if (h)
        try {
          let d = typeof h == "function" ? await h({ width: u, height: p, src: c, element: a }) : h;
          if (d) {
            let m = await it(d, { as: "dataURL", useProxy: e.useProxy });
            if (m?.ok && typeof m.data == "string") {
              a.src = m.data, a.width || (a.width = u), a.height || (a.height = p);
              return;
            }
          }
        } catch {}
      if (e.placeholders !== false) {
        St(e.__session, "image-fallback", `image failed to inline, using placeholder: ${c}`);
        let d = document.createElement("div");
        d.style.cssText = [`width:${u}px`, `height:${p}px`, "background:#ccc", "display:inline-block", "text-align:center", `line-height:${p}px`, "color:#666", "font-size:12px", "overflow:hidden"].join(";"), d.textContent = "img", a.replaceWith(d);
      } else {
        let d = document.createElement("div");
        d.style.cssText = `display:inline-block;width:${u}px;height:${p}px;visibility:hidden;`, a.replaceWith(d);
      }
    }, i = 6;
    for (let a = 0;a < n.length; a += i) {
      let c = n.slice(a, a + i).map(r);
      await Promise.allSettled(c);
    }
    let o = Array.from(t.querySelectorAll("image"));
    t.localName === "image" && o.unshift(t);
    let s = async (a) => {
      let c = bf(a);
      if (!c || c.startsWith("data:") || c.startsWith("blob:"))
        return;
      let f = await it(c, { as: "dataURL", useProxy: e.useProxy });
      f.ok && typeof f.data == "string" && f.data.startsWith("data:") && (a.setAttribute("href", f.data), a.removeAttribute("xlink:href"), typeof a.removeAttributeNS == "function" && a.removeAttributeNS($s, "href"));
    };
    for (let a = 0;a < o.length; a += i) {
      let c = o.slice(a, a + i).map(s);
      await Promise.allSettled(c);
    }
  }
  kt();
  ht();
  var Sf = ["background-image", "mask", "mask-image", "-webkit-mask", "-webkit-mask-image", "mask-source", "mask-box-image-source", "mask-border-source", "-webkit-mask-box-image-source", "border-image", "border-image-source"];
  var xf = ["mask-position", "mask-size", "mask-repeat", "mask-mode", "mask-composite", "-webkit-mask-position", "-webkit-mask-size", "-webkit-mask-repeat", "-webkit-mask-composite", "mask-origin", "mask-clip", "-webkit-mask-origin", "-webkit-mask-clip", "-webkit-mask-position-x", "-webkit-mask-position-y"];
  var vf = ["background-position", "background-position-x", "background-position-y", "background-size", "background-repeat", "background-origin", "background-clip", "background-attachment", "background-blend-mode"];
  var kf = ["border-image-slice", "border-image-width", "border-image-outset", "border-image-repeat"];
  async function Cf(t, e, n, r) {
    let i = n.get(t) || W(t);
    n.has(t) || n.set(t, i);
    let o = hi(t), s = o ? (d) => (d in o) ? o[d] : "" : (d) => i.getPropertyValue(d), a = s("border-image"), c = s("border-image-source"), f = a && a !== "none" || c && c !== "none", l = i.getPropertyValue("background-image"), u = s("background-color"), p = l && l !== "none" || u && u !== "rgba(0, 0, 0, 0)" && u !== "transparent" || /url\s*\(|gradient\s*\(/i.test(i.getPropertyValue("background") || ""), h = zt() && (s("background-clip") || s("-webkit-background-clip") || "").includes("text");
    if (p && !h)
      for (let d of vf) {
        let m = s(d);
        m && e.style.setProperty(d, m);
      }
    for (let d of Sf) {
      if (h && d === "background-image")
        continue;
      let m = i.getPropertyValue(d);
      if (d === "background-image" && (!m || m === "none")) {
        let b = i.getPropertyValue("background");
        b && /url\s*\(/.test(b) && (m = Ht(b).filter((w) => /url\s*\(/.test(w)).join(", ") || m);
      }
      if (!m || m === "none")
        continue;
      let g = Ht(m), y = await Promise.all(g.map((b) => pe(b, r)));
      y.some((b) => b && b !== "none" && !/^url\(undefined/.test(b)) && e.style.setProperty(d, y.join(", "));
    }
    for (let d of xf) {
      let m = s(d);
      !m || m === "initial" || e.style.setProperty(d, m);
    }
    if (f)
      for (let d of kf) {
        let m = s(d);
        !m || m === "initial" || e.style.setProperty(d, m);
      }
    if (p && /fixed/.test(s("background-attachment") || ""))
      try {
        await Mf(t, e, i);
      } catch {}
  }
  function Af(t, e, n, r, i) {
    let o = (t || "auto").trim();
    if (o === "cover" || o === "contain") {
      if (!e || !n)
        return { w: r, h: i };
      let p = o === "cover" ? Math.max(r / e, i / n) : Math.min(r / e, i / n);
      return { w: e * p, h: n * p };
    }
    let s = o.split(/\s+/), a = (p, h) => {
      if (p === "auto" || p === undefined)
        return null;
      if (p.endsWith("px"))
        return parseFloat(p);
      if (p.endsWith("%"))
        return h * parseFloat(p) / 100;
    }, c = a(s[0], r), f = a(s[1], i);
    if (c === undefined || f === undefined)
      return null;
    let l = c, u = f;
    return l == null && u == null ? (l = e || r, u = n || i) : l == null ? l = e && n ? u * (e / n) : r : u == null && (u = e && n ? l * (n / e) : i), !l || !u ? null : { w: l, h: u };
  }
  async function Mf(t, e, n) {
    let r = (n.getPropertyValue("background-attachment") || "").split(",").map((d) => d.trim()), i = Xe();
    if (!i)
      for (let d = t.parentElement;d && !i; d = d.parentElement) {
        let m = W(d);
        (m.transform && m.transform !== "none" || m.filter && m.filter !== "none") && (i = true);
      }
    if (i) {
      e.style.setProperty("background-attachment", r.map(() => "scroll").join(", "));
      return;
    }
    let o = t.getBoundingClientRect(), s = t.ownerDocument?.defaultView || window, a = s.innerWidth, c = s.innerHeight, f = Ht(e.style.backgroundImage || n.getPropertyValue("background-image") || ""), l = (e.style.backgroundSize || n.getPropertyValue("background-size") || "auto").split(",").map((d) => d.trim()), u = (e.style.backgroundPosition || n.getPropertyValue("background-position") || "0% 0%").split(",").map((d) => d.trim()), p = [], h = [];
    for (let d = 0;d < f.length; d++) {
      let m = r[d % r.length] || "scroll", g = l[d % l.length], y = u[d % u.length];
      if (m !== "fixed") {
        p.push(g), h.push(y);
        continue;
      }
      let b = 0, w = 0, C = f[d] && f[d].match(/url\(["']?([^"')]+)["']?\)/);
      if (C)
        try {
          let k = new Image;
          k.src = C[1], await k.decode(), b = k.naturalWidth, w = k.naturalHeight;
        } catch {
          p.push(g), h.push(y);
          continue;
        }
      let x = Af(g, b, w, a, c);
      if (!x) {
        p.push(g), h.push(y);
        continue;
      }
      let S = y.split(/\s+/), A = (k, R, E) => {
        if (!k)
          return 0;
        if (k.endsWith("px"))
          return parseFloat(k);
        if (k.endsWith("%"))
          return (R - E) * parseFloat(k) / 100;
      }, v = A(S[0] || "0%", a, x.w), M = A(S[1] || S[0] || "0%", c, x.h);
      if (v === undefined || M === undefined) {
        p.push(g), h.push(y);
        continue;
      }
      p.push(`${Hn(x.w)}px ${Hn(x.h)}px`), h.push(`${Hn(v - o.left)}px ${Hn(M - o.top)}px`);
    }
    e.style.setProperty("background-size", p.join(", ")), e.style.setProperty("background-position", h.join(", ")), e.style.setProperty("background-attachment", r.map(() => "scroll").join(", "));
  }
  var Hn = (t) => Math.round(t * 100) / 100;
  async function zn(t, e, n, r = {}, i = new Map) {
    if (!e)
      return;
    let o = [];
    t && Dr(t) && o.push([t, e]);
    let s = [e];
    for (;s.length; ) {
      let c = s.pop();
      if (c.children)
        for (let f of c.children) {
          if (f.tagName === "STYLE")
            continue;
          let l = i.get(f);
          l && Dr(l) && o.push([l, f]), s.push(f);
        }
    }
    let a = 6;
    for (let c = 0;c < o.length; c += a)
      await Promise.allSettled(o.slice(c, c + a).map(([f, l]) => Cf(f, l, n, r)));
  }
  ht();
  function Ns(t, e, n = new Map) {
    let r = [], i = document.createTreeWalker(e, NodeFilter.SHOW_ELEMENT);
    for (let a = i.currentNode;a; a = i.nextNode()) {
      let c = n.get(a);
      if (c?.nodeType !== 1)
        continue;
      let f = W(c), l = f.getPropertyValue("backdrop-filter") || f.getPropertyValue("-webkit-backdrop-filter");
      l && l !== "none" && a !== e && r.push({ cloneEl: a, orig: c, bf: l, path: Ff(e, a) });
    }
    if (!r.length)
      return;
    let o = t.getBoundingClientRect(), s = r.map((a, c) => {
      let f = e.cloneNode(true);
      Rf(f, e, a.orig.getBoundingClientRect(), n), Tf(Ps(f, a.path));
      for (let l = 0;l < c; l++) {
        let u = Ps(f, r[l].path);
        u && (u.style.setProperty("backdrop-filter", "none", "important"), u.style.setProperty("-webkit-backdrop-filter", "none", "important"));
      }
      return { ...a, copy: f };
    });
    for (let { cloneEl: a, orig: c, bf: f, copy: l } of s)
      Ef.has(a.tagName) || _f(a, c, f, l, o);
  }
  var Ef = new Set(["IMG", "INPUT", "TEXTAREA", "SELECT", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "EMBED", "OBJECT", "PROGRESS", "METER", "HR", "BR"]);
  function _f(t, e, n, r, i) {
    let o = e.getBoundingClientRect();
    if (!o.width || !o.height)
      return;
    let s = W(e), a = e.offsetWidth ? o.width / e.offsetWidth : 1, c = Math.abs(a - 1) > 0.001 ? 1 / a : 1;
    r.style.position = "absolute", r.style.left = `${(i.left - o.left) * c}px`, r.style.top = `${(i.top - o.top) * c}px`, r.style.width = `${i.width}px`, r.style.height = `${i.height}px`, r.style.margin = "0", r.style.filter = n, c !== 1 && (r.style.transform = `scale(${c})`, r.style.transformOrigin = "top left");
    let f = document.createElement("div");
    f.style.cssText = "position:absolute;inset:0;overflow:hidden;border-radius:inherit;z-index:-2", f.appendChild(r);
    let l = document.createElement("div");
    l.style.cssText = "position:absolute;inset:0;border-radius:inherit;z-index:-1", l.style.backgroundColor = s.backgroundColor, l.style.backgroundImage = t.style.backgroundImage || s.backgroundImage;
    for (let u of ["background-size", "background-position", "background-repeat", "background-origin", "background-clip"])
      l.style.setProperty(u, s.getPropertyValue(u));
    t.style.setProperty("background-color", "transparent", "important"), t.style.setProperty("background-image", "none", "important"), t.style.setProperty("backdrop-filter", "none", "important"), t.style.setProperty("-webkit-backdrop-filter", "none", "important"), s.position === "static" && (t.style.position = "relative"), t.style.isolation = "isolate", t.prepend(l), t.prepend(f);
  }
  var jn = 128;
  function Rf(t, e, n, r) {
    let i = [[t, e]];
    for (;i.length; ) {
      let [o, s] = i.pop(), a = r.get(s);
      if (a?.nodeType === 1) {
        let l = a.getBoundingClientRect();
        (l.left > n.right + jn || l.right < n.left - jn || l.top > n.bottom + jn || l.bottom < n.top - jn) && (o.tagName === "IMG" && o.setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA="), o.style && (o.style.backgroundImage = "none"));
      }
      let c = o.children, f = s.children;
      for (let l = 0;l < c.length; l++)
        i.push([c[l], f[l]]);
    }
  }
  function Ff(t, e) {
    let n = [];
    for (let r = e;r !== t; r = r.parentElement) {
      if (!r?.parentElement)
        return null;
      n.push([...r.parentElement.children].indexOf(r));
    }
    return n.reverse();
  }
  function Ps(t, e) {
    if (!e)
      return null;
    let n = t;
    for (let r of e)
      if (n = n.children[r], !n)
        return null;
    return n;
  }
  function Tf(t) {
    if (t)
      for (let e = t;e && e.parentNode; ) {
        let n = e.parentNode;
        for (;e.nextSibling; )
          e.nextSibling.remove();
        e === t && e.remove(), e = n;
      }
  }
  ht();
  dt();
  dt();
  function Ls(t) {
    return jo(t), { styleMap: new Map, styleCache: new WeakMap, nodeMap: new Map, warnings: [] };
  }
  Qt();
  function qn(t, e) {
    if (!t)
      return () => {};
    let n = [], r = 200;
    function i(o) {
      if (e) {
        let f = o.getBoundingClientRect();
        if (f.width > 0 || f.height > 0) {
          let l = Math.max(f.right, f.left + (o.scrollWidth || 0)), u = Math.max(f.bottom, f.top + (o.scrollHeight || 0));
          if (l < e.left - r || f.left > e.right + r || u < e.top - r || f.top > e.bottom + r)
            return;
        }
      }
      let s = getComputedStyle(o), a = $f(o, s);
      a && n.push(a);
      let c = Pf(o, s);
      c && n.push(c);
      for (let f of o.children || [])
        i(f);
    }
    return i(t), () => n.forEach((o) => o());
  }
  function $f(t, e) {
    if (!t)
      return () => {};
    e = e || getComputedStyle(t);
    let n = Nf(e);
    if (n <= 0)
      return () => {};
    if (!Os(t))
      return () => {};
    let r = Ws(t), i = r.text, o = If(e);
    r.write("X");
    let s = t.scrollHeight - o;
    r.restore();
    let a = s > 0 ? s : Lf(e), c = Math.round(a * n + o);
    if (t.scrollHeight <= c + 0.5)
      return () => {};
    let f = 0, l = i.length, u = -1;
    for (;f <= l; ) {
      let h = f + l >> 1;
      r.write(i.slice(0, Vn(i, h)) + "…"), t.scrollHeight <= c + 0.5 ? (u = h, f = h + 1) : l = h - 1;
    }
    let p = (u >= 0 ? i.slice(0, Vn(i, u)) : "") + "…";
    return r.write(p), Is(t, p, r);
  }
  function Pf(t, e) {
    if (!t)
      return () => {};
    if (e = e || getComputedStyle(t), e.textOverflow !== "ellipsis")
      return () => {};
    if (e.whiteSpace !== "nowrap" && e.whiteSpace !== "pre")
      return () => {};
    if (e.overflowX !== "hidden" && e.overflowX !== "clip")
      return () => {};
    if (!Os(t))
      return () => {};
    if (t.scrollWidth <= t.clientWidth + 0.5)
      return () => {};
    let n = Ws(t), r = n.text, i = 0, o = r.length, s = -1;
    for (;i <= o; ) {
      let c = i + o >> 1;
      n.write(r.slice(0, Vn(r, c)) + "…"), t.scrollWidth <= t.clientWidth + 0.5 ? (s = c, i = c + 1) : o = c - 1;
    }
    let a = (s >= 0 ? r.slice(0, Vn(r, s)) : "") + "…";
    return n.write(a), Is(t, a, n);
  }
  function Is(t, e, n) {
    return () => {
      t.textContent === e && n.restore();
    };
  }
  function Ws(t) {
    let e = [];
    for (let r = t.firstChild;r; r = r.nextSibling)
      r.nodeType === Node.TEXT_NODE && e.push(r);
    let n = e.map((r) => r.data);
    return { text: n.join(""), write(r) {
      e[0].data = r;
      for (let i = 1;i < e.length; i++)
        e[i].data = "";
    }, restore() {
      for (let r = 0;r < e.length; r++)
        e[r].data = n[r];
    } };
  }
  function Vn(t, e) {
    if (e <= 0 || e >= t.length)
      return e;
    let n = t.charCodeAt(e - 1);
    return n >= 55296 && n <= 56319 ? e - 1 : e;
  }
  function Nf(t) {
    let e = t.getPropertyValue("-webkit-line-clamp") || t.getPropertyValue("line-clamp");
    e = (e || "").trim();
    let n = parseInt(e, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function Lf(t) {
    let e = (t.lineHeight || "").trim(), n = parseFloat(t.fontSize) || 16;
    return !e || e === "normal" ? Math.round(n * 1.2) : e.endsWith("px") ? parseFloat(e) : /^\d+(\.\d+)?$/.test(e) ? Math.round(parseFloat(e) * n) : e.endsWith("%") ? Math.round(parseFloat(e) / 100 * n) : Math.round(n * 1.2);
  }
  function If(t) {
    return (parseFloat(t.paddingTop) || 0) + (parseFloat(t.paddingBottom) || 0);
  }
  function Os(t) {
    return t.childElementCount > 0 ? false : Array.from(t.childNodes).some((e) => e.nodeType === Node.TEXT_NODE);
  }
  var Te = ["clone", "render"];
  var sn = { clone: 0, render: 1 };
  var ft = "render";
  function Ds(t) {
    let e = Array.isArray(t && t.plugins) ? t.plugins : [];
    if (!e.length)
      return { stage: ft, loweredBy: [] };
    let n = -1, r = [];
    for (let o of e) {
      if (!o || typeof o != "object")
        continue;
      let s = o.needs === undefined ? ft : o.needs;
      if (!Object.prototype.hasOwnProperty.call(sn, s))
        throw new Error(`[snapdom] plugin '${o.name || "(unnamed)"}' declares needs: ${JSON.stringify(s)}, expected one of ${Te.join(", ")}`);
      r.push({ name: o.name || "(unnamed)", needs: s }), n = Math.max(n, sn[s]);
    }
    if (n < 0)
      return { stage: ft, loweredBy: [] };
    let i = Te[n];
    return { loweredBy: i === ft ? [] : r.filter((o) => o.needs === i).map((o) => o.name), stage: i };
  }
  function $e(t, e) {
    return sn[t] >= sn[e];
  }
  function Us(t, e, n) {
    let r = e.length ? e.map((i) => `'${i}'`).join(", ") : "the attached plugins";
    return new Error(`[snapdom] no ${n}: this capture stopped at '${t}' because ${r} declared needs: '${t}' (result.needs says so too). It is not re-captured on demand — that would be a different instant. Ask the plugin for needs: 'render', or capture without it.`);
  }
  var Pe = [];
  function Ne(t) {
    if (!t)
      return null;
    if (Array.isArray(t)) {
      let [e, n] = t;
      return typeof e == "function" ? e(n) : e;
    }
    if (typeof t == "object" && "plugin" in t) {
      let { plugin: e, options: n } = t;
      return typeof e == "function" ? e(n) : e;
    }
    return typeof t == "function" ? t() : t;
  }
  function ho(...t) {
    let e = t.flat();
    for (let n of e) {
      let r = Ne(n);
      if (r) {
        if (r.needs !== undefined && r.needs !== ft)
          throw new Error(`[snapdom] global plugin '${r.name || "(unnamed)"}' declares needs: ${JSON.stringify(r.needs)}. A global plugin must run to '${ft}': lowering it here would stop EVERY capture in the app short of pixels. Pass it per capture instead: snapdom(el, { plugins: [<plugin>] }).`);
        Pe.some((i) => i && i.name && r.name && i.name === r.name) || Pe.push(r);
      }
    }
  }
  function Hs(t) {
    return t && Array.isArray(t.plugins) ? t.plugins : Pe;
  }
  async function Nt(t, e, n) {
    let r = n, i = Hs(e);
    for (let o of i) {
      let s = o && typeof o[t] == "function" ? o[t] : null;
      if (!s)
        continue;
      let a = await s(e, r);
      typeof a < "u" && (r = a);
    }
    return r;
  }
  async function Gn(t, e, n) {
    let r = [], i = Hs(e);
    for (let o of i) {
      let s = o && typeof o[t] == "function" ? o[t] : null;
      if (!s)
        continue;
      let a = await s(e, n);
      typeof a < "u" && r.push(a);
    }
    return r;
  }
  var Of = 0;
  function Df(t) {
    let e = [];
    if (Array.isArray(t))
      for (let n of t) {
        let r = Ne(n);
        if (!r)
          continue;
        r.name || (r.name = `anonymous-${++Of}`);
        let i = e.findIndex((o) => o && o.name === r.name);
        i >= 0 && e.splice(i, 1), e.push(r);
      }
    for (let n of Pe)
      n && n.name && !e.some((r) => r.name === n.name) && e.push(n);
    return Object.freeze(e);
  }
  function zs(t, e, n = false) {
    return !t || t.plugins && !n || (t.plugins = Df(e)), t;
  }
  function mo() {
    return Pe.slice();
  }
  var Bf = ["resolveNode", "beforeSnap", "beforeClone", "afterClone", "beforeRender", "afterRender"];
  function Xn(t) {
    let e = Array.isArray(t && t.plugins) ? t.plugins : [];
    for (let n of e) {
      let r = Ne(n);
      if (!(!r || r.pure === true)) {
        for (let i of Bf)
          if (typeof r[i] == "function")
            return true;
      }
    }
    return false;
  }
  dt();
  ye();
  var ce = "data-snapdom-asset";
  var Gs = "http://www.w3.org/1999/xlink";
  var Uf = 0;
  function Kn(t, e, n, r, i, o) {
    let s = o.__compressedAssets ||= new WeakMap, a = s.get(t);
    a || (a = { token: String(++Uf), properties: [] }, s.set(t, a), t.setAttribute(ce, a.token));
    let c = a.properties.find((f) => f.kind === e && f.name === n);
    c ? (c.compressed !== r && (c.original = r), c.compressed = i) : a.properties.push({ kind: e, name: n, original: r, compressed: i });
  }
  var Xs = (t, e) => e.kind === "style" ? t.style?.getPropertyValue(e.name) : t.getAttribute(e.name);
  function Qn(t, e) {
    let n = new Map;
    if (!t || !e)
      return n;
    let r = [t, ...t.querySelectorAll(`[${ce}]`)];
    for (let i of r) {
      let o = e.get(i);
      if (!o || i.getAttribute(ce) !== o.token)
        continue;
      let s = o.properties.filter((a) => Xs(i, a) === a.compressed).map((a) => Object.freeze({ ...a }));
      s.length && n.set(o.token, Object.freeze(s));
    }
    return n;
  }
  function Jn(t, e) {
    if (!t || !e)
      return;
    let n = 0;
    for (let r of [t, ...t.querySelectorAll(`[${ce}]`)]) {
      let i = e.get(r);
      i && (i.token = String(++n), r.setAttribute(ce, i.token));
    }
  }
  function Ys(t, e) {
    if (!e?.size || typeof t != "string" || !t.startsWith("data:image/svg+xml"))
      return t;
    let n = t.indexOf(","), r = new DOMParser().parseFromString(decodeURIComponent(t.slice(n + 1)), "image/svg+xml");
    if (r.querySelector("parsererror"))
      return t;
    let i = false;
    for (let o of r.querySelectorAll(`[${ce}]`))
      for (let s of e.get(o.getAttribute(ce)) || [])
        Xs(o, s) === s.compressed && (s.kind === "style" ? o.style.setProperty(s.name, s.original, o.style.getPropertyPriority(s.name)) : s.name === "xlink:href" ? o.setAttributeNS(Gs, s.name, s.original) : o.setAttribute(s.name, s.original), i = true);
    return i ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(r))}` : t;
  }
  function js(t) {
    if (t.is2D === false)
      return 1 / 0;
    let e = t.a * t.a + t.b * t.b + t.c * t.c + t.d * t.d, n = t.a * t.d - t.b * t.c;
    return Math.sqrt((e + Math.sqrt(Math.max(0, e * e - 4 * n * n))) / 2);
  }
  function go(t, e) {
    let n = e.element || t, r = n.isConnected ? W(n) : n.style, i = e.__compressionClip, o = (h, d) => {
      try {
        return h[d]?.baseVal?.value || 0;
      } catch {
        return 0;
      }
    }, s = i?.width || n.offsetWidth || parseFloat(r?.width) || o(n, "width"), a = i?.height || n.offsetHeight || parseFloat(r?.height) || o(n, "height"), c = Number.isFinite(e.width), f = Number.isFinite(e.height);
    if (!i && (c || f) && s && a)
      try {
        let h = e.outerTransforms === false && e.__compressionRootTransform ? e.__compressionRootTransform : qt({ baseTransform: r?.transform, rotate: r?.rotate, scale: r?.scale, width: s, height: a });
        if (h.is2D === false)
          s = 0, a = 0;
        else {
          let d = Math.abs(h.a) * s + Math.abs(h.c) * a, m = Math.abs(h.b) * s + Math.abs(h.d) * a;
          s = Math.min(s, d), a = Math.min(a, m);
        }
      } catch {
        s = 0, a = 0;
      }
    let l = (c || f ? Math.max(c ? s ? e.width / s : 1 / 0 : 0, f ? a ? e.height / a : 1 / 0 : 0) : e.scale || 1) * (e.dpr || 1);
    e.__compressionDensity = l;
    let u = new WeakMap, p = (h) => {
      if (!h || h.nodeType !== 1)
        return 1;
      if (u.has(h))
        return u.get(h);
      let d = h.isConnected ? W(h) : h.style, m = 1;
      try {
        d?.perspective && d.perspective !== "none" && (m = 1 / 0);
        let g = d?.transform;
        if (g && g !== "none")
          m *= js(new DOMMatrix(g));
        else if (h.transform?.baseVal?.numberOfItems) {
          let y = new DOMMatrix;
          for (let b = 0;b < h.transform.baseVal.numberOfItems; b++) {
            let w = h.transform.baseVal.getItem(b).matrix;
            y = y.multiply(new DOMMatrix([w.a, w.b, w.c, w.d, w.e, w.f]));
          }
          m *= js(y);
        }
        if (d?.scale && d.scale !== "none") {
          let y = d.scale.trim().split(/\s+/).map((b) => parseFloat(b) / (b.endsWith("%") ? 100 : 1));
          m *= Math.max(...y.map(Math.abs));
        }
        if (h !== n && d?.zoom && d.zoom !== "normal" && (m *= parseFloat(d.zoom) || 1), h.localName === "svg" && h.viewBox?.baseVal?.width > 0 && h.viewBox.baseVal.height > 0) {
          let y = h.viewBox.baseVal, b = (x) => /^\d+(?:\.\d+)?px$/.test(d?.[x] || "") ? parseFloat(d[x]) : o(h, x), w = b("width"), C = b("height");
          m *= w > 0 && C > 0 ? Math.max(w / y.width, C / y.height) : 1 / 0;
        }
      } catch {
        m = 1 / 0;
      }
      return Number.isFinite(m) || (m = 1 / 0), h !== n && (m *= p(h.parentElement || h.getRootNode?.().host)), u.set(h, m), m;
    };
    return { density: l, stretch: p };
  }
  var Ks = 0.92;
  var Qs = 1;
  async function Hf(t) {
    let e = new Image;
    return e.decoding = "sync", e.src = t, typeof e.decode == "function" ? (await e.decode(), e) : (await new Promise((n, r) => {
      e.onload = () => n(), e.onerror = r;
    }), e);
  }
  function zf(t) {
    let e = /^data:([^;,]+)/.exec(t);
    return e ? e[1] : "";
  }
  var jf = 64 * 1024;
  var Vs = 32 * 1024 * 1024;
  var Yn = new Map;
  function Vf(t, e, n, r) {
    if (n.length + (r?.length || 0) > Vs)
      return;
    t.set(e, { source: n, result: r });
    let i = 0;
    for (let o of t.values())
      i += o.source.length + (o.result?.length || 0);
    for (;i > Vs; ) {
      let o = t.keys().next().value, s = t.get(o);
      i -= s.source.length + (s.result?.length || 0), t.delete(o);
    }
  }
  function qf(t, e) {
    let n = t.indexOf(",");
    if (n < 0 || !/;base64/i.test(t.slice(0, n)))
      return null;
    let r = Math.ceil(e / 3) * 4, i = t.length - n - 1, o = Math.min(i, r);
    try {
      let s = atob(t.slice(n + 1, n + 1 + o - o % 4)), a = new Uint8Array(s.length);
      for (let c = 0;c < s.length; c++)
        a[c] = s.charCodeAt(c);
      return a;
    } catch {
      return null;
    }
  }
  function Gf(t) {
    let e = qf(t, 4096);
    if (!e || e.length < 16)
      return null;
    let n = (r) => e[r] << 8 | e[r + 1];
    if (e[0] === 137 && e[1] === 80 && e.length >= 24)
      return { w: (e[16] << 24 | e[17] << 16 | e[18] << 8 | e[19]) >>> 0, h: (e[20] << 24 | e[21] << 16 | e[22] << 8 | e[23]) >>> 0 };
    if (e[0] === 71 && e[1] === 73 && e[2] === 70)
      return { w: e[6] | e[7] << 8, h: e[8] | e[9] << 8 };
    if (e[0] === 82 && e[1] === 73 && e[8] === 87 && e.length >= 30) {
      let r = e[15];
      if (r === 32 && e[23] === 157)
        return { w: (e[26] | e[27] << 8) & 16383, h: (e[28] | e[29] << 8) & 16383 };
      if (r === 76)
        return { w: (e[21] | (e[22] & 63) << 8) + 1, h: ((e[22] >> 6 | e[23] << 2 | (e[24] & 15) << 10) & 16383) + 1 };
      if (r === 88)
        return { w: (e[24] | e[25] << 8 | e[26] << 16) + 1, h: (e[27] | e[28] << 8 | e[29] << 16) + 1 };
    }
    if (e[0] === 255 && e[1] === 216) {
      let r = 2;
      for (;r + 9 < e.length; ) {
        if (e[r] !== 255) {
          r++;
          continue;
        }
        let i = e[r + 1];
        if (i === 216 || i === 1 || i >= 208 && i <= 215) {
          r += 2;
          continue;
        }
        if (i >= 192 && i <= 207 && i !== 196 && i !== 200 && i !== 204)
          return { h: n(r + 5), w: n(r + 7) };
        let o = n(r + 2);
        if (o < 2)
          break;
        r += 2 + o;
      }
    }
    return null;
  }
  function qs(t, e, n, r) {
    let i = Math.min(1, Math.max(n / t, r / e));
    return !(i > 0) || i >= 0.95 ? 0 : i;
  }
  var Xf = `self.onmessage = async (e) => {
  const { id, dataURL, blob: given, srcLength, targetW, targetH, resFactor, quality, mime } = e.data
  try {
    const blob = given || await (await fetch(dataURL)).blob()
    const bmp = await createImageBitmap(blob)
    const nw = bmp.width, nh = bmp.height
    if (!nw || !nh) { bmp.close(); self.postMessage({ id, url: null }); return }
    const raw = Math.min(1, Math.max(targetW / nw, targetH / nh))
    if (!(raw > 0) || raw >= 0.95) { bmp.close(); self.postMessage({ id, url: null }); return }
    const factor = raw * resFactor
    const ow = Math.max(1, Math.round(nw * factor))
    const oh = Math.max(1, Math.round(nh * factor))
    const canvas = new OffscreenCanvas(ow, oh)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, ow, oh)
    bmp.close()
    const out = await canvas.convertToBlob({ type: mime, quality })
    const url = new FileReaderSync().readAsDataURL(out)
    self.postMessage({ id, url: (url && url.length < srcLength) ? url : null })
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  }
}`;
  var Yf = Math.max(1, Math.min(4, (typeof navigator < "u" && navigator.hardwareConcurrency || 2) - 1));
  var Ft = null;
  var Kf = 0;
  var Qf = 0;
  var ae = new Map;
  function Js() {
    for (let t of ae.values())
      t(undefined);
    if (ae.clear(), Array.isArray(Ft))
      for (let t of Ft)
        try {
          t?.terminate();
        } catch {}
    Ft = false;
  }
  function Jf() {
    let t, e = null;
    try {
      t = URL.createObjectURL(new Blob([Xf], { type: "text/javascript" })), e = new Worker(t), e.onmessage = (n) => {
        let r = ae.get(n.data.id);
        r && (ae.delete(n.data.id), r(n.data.error ? undefined : n.data.url ?? null));
      }, e.onerror = Js;
    } catch {
      e = null;
    }
    return t && URL.revokeObjectURL(t), e;
  }
  function Zf() {
    if (Ft === false)
      return false;
    if (Ft === null) {
      if (typeof Worker > "u" || typeof OffscreenCanvas > "u")
        return Ft = false;
      Ft = [];
    }
    let t = Kf++ % Yf;
    if (!Ft[t]) {
      let e = Jf();
      if (!e)
        return Js(), false;
      Ft[t] = e;
    }
    return Ft[t];
  }
  var tu = 5000;
  function eu(t, e, n, r, i) {
    let o = Zf();
    return o ? new Promise((s) => {
      let a = ++Qf, c = setTimeout(() => {
        ae.delete(a), s(undefined);
      }, tu);
      ae.set(a, (f) => {
        clearTimeout(c), s(f);
      });
      try {
        o.postMessage({ id: a, dataURL: i ? "" : t, blob: i, srcLength: t.length, targetW: e, targetH: n, resFactor: Qs, quality: Ks, mime: r });
      } catch {
        clearTimeout(c), ae.delete(a), s(undefined);
      }
    }) : Promise.resolve(undefined);
  }
  async function yo(t, e, n, r) {
    if (typeof t != "string" || !t.startsWith("data:image") || t.startsWith("data:image/svg"))
      return null;
    e = Math.ceil(e), n = Math.ceil(n);
    let i = t.length + ":" + t.slice(0, 64) + t.slice(-64) + ":" + e + "x" + n, o = P.compress, s = o.get(i);
    if (s?.source === t)
      return s.result;
    let a = Yn.get(i);
    if (a?.source === t && a.cache === o)
      return a.promise;
    let c = (async () => {
      let l = zf(t), u = l === "image/jpeg" ? "image/jpeg" : l === "image/webp" ? "image/webp" : "image/png", p = Gf(t);
      if (p && p.w > 0 && p.h > 0 && !qs(p.w, p.h, e, n))
        return null;
      if (t.length >= jf) {
        let S = await eu(t, e, n, u, r);
        if (S !== undefined)
          return S;
      }
      let h;
      try {
        h = await Hf(t);
      } catch {
        return null;
      }
      let d = h.naturalWidth || h.width, m = h.naturalHeight || h.height;
      if (!d || !m)
        return null;
      let g = qs(d, m, e, n);
      if (!g)
        return null;
      let y = g * Qs, b = Math.max(1, Math.round(d * y)), w = Math.max(1, Math.round(m * y)), C = document.createElement("canvas");
      C.width = b, C.height = w;
      let x = C.getContext("2d");
      if (!x)
        return null;
      x.imageSmoothingEnabled = true, x.imageSmoothingQuality = "high", x.drawImage(h, 0, 0, b, w);
      try {
        let S = C.toDataURL(u, Ks);
        if (typeof S == "string" && S.startsWith("data:image") && S.length < t.length)
          return S;
      } catch {}
      return null;
    })(), f = { source: t, promise: c, cache: o };
    Yn.set(i, f);
    try {
      let l = await c;
      return Vf(o, i, t, l), l;
    } finally {
      Yn.get(i) === f && Yn.delete(i);
    }
  }
  async function nu(t, e, n = new Map, r = {}) {
    if (!e.compress)
      return { count: 0, before: 0, after: 0 };
    let i = Array.from(t.querySelectorAll("img"));
    t.tagName === "IMG" && i.unshift(t);
    let o = 0, s = 0, a = 0, c = async (l) => {
      let u = l.getAttribute("src") || "";
      if (!u.startsWith("data:image") || u.startsWith("data:image/svg"))
        return;
      let p = parseFloat(l.dataset.snapdomWidth) || parseFloat(l.style.width) || l.width || 0, h = parseFloat(l.dataset.snapdomHeight) || parseFloat(l.style.height) || l.height || 0;
      if (!p || !h)
        return;
      let d = r.value ||= go(t, e), m = d.density * d.stretch(n.get(l) || l), g = await yo(u, p * m, h * m, l.__snapdomBlob);
      g && (o++, s += u.length, a += g.length, l.setAttribute("src", g), Kn(l, "attribute", "src", u, g, e));
    }, f = 6;
    for (let l = 0;l < i.length; l += f)
      await Promise.allSettled(i.slice(l, l + f).map(c));
    return { count: o, before: s, after: a };
  }
  var ru = /^(cover|contain|(\d+(\.\d+)?%(\s+\d+(\.\d+)?%)?))$/;
  function ou(t) {
    let e = t.offsetWidth || t.getBoundingClientRect().width || 0, n = t.offsetHeight || t.getBoundingClientRect().height || 0;
    return { w: e, h: n };
  }
  async function iu(t, e, n = new Map, r = {}) {
    if (!e.compress)
      return { count: 0 };
    let i = [], o = [t, ...t.querySelectorAll("*")];
    for (let f of o) {
      let l = f.style && f.style.backgroundImage;
      l && l.includes("data:image") && i.push(f);
    }
    let s = 0, a = async (f) => {
      let l = n.get(f);
      if (!l || !l.isConnected)
        return;
      let u;
      try {
        u = getComputedStyle(l);
      } catch {
        return;
      }
      if ((u.backgroundRepeat || "repeat").toLowerCase().split(",").some((v) => v.trim() !== "no-repeat"))
        return;
      let h = (f.style.backgroundSize || u.backgroundSize || "auto").toLowerCase();
      if (h.split(",").some((v) => !ru.test(v.trim())))
        return;
      let { w: d, h: m } = ou(l);
      if (!d || !m)
        return;
      let g = Math.max(1, ...(h.match(/\d+(?:\.\d+)?%/g) || []).map((v) => parseFloat(v) / 100)), y = r.value ||= go(t, e), b = y.density * y.stretch(l) * g, w = d * b, C = m * b, x = f.style.backgroundImage, S = [...x.matchAll(/url\((['"]?)(data:image\/[^)'"]+)\1\)/gi)], A = x;
      for (let v of S) {
        let M = v[2];
        if (M.startsWith("data:image/svg"))
          continue;
        let k = await yo(M, w, C);
        k && (A = A.split(M).join(k), s++);
      }
      A !== x && (f.style.setProperty("background-image", A, f.style.getPropertyPriority("background-image")), Kn(f, "style", "background-image", x, f.style.backgroundImage, e));
    }, c = 6;
    for (let f = 0;f < i.length; f += c)
      await Promise.allSettled(i.slice(f, f + c).map(a));
    return { count: s };
  }
  async function su(t, e, n = new Map, r = {}) {
    if (!e.compress)
      return { count: 0 };
    let i = Array.from(t.querySelectorAll("image"));
    t.localName === "image" && i.unshift(t);
    let o = 0, s = async (c) => {
      let f = c.getAttribute("href") || (typeof c.getAttributeNS == "function" ? c.getAttributeNS("http://www.w3.org/1999/xlink", "href") : null);
      if (!f || !f.startsWith("data:image") || f.startsWith("data:image/svg"))
        return;
      let l = c.getAttribute("width") || "", u = c.getAttribute("height") || "";
      if (l.includes("%") || u.includes("%"))
        return;
      let p = n.get(c), h = p ? W(p) : c.style, d = (C, x) => {
        if (/^\d+(?:\.\d+)?px$/.test(h?.[C] || ""))
          return parseFloat(h[C]);
        if (/^\d+(?:\.\d+)?(?:px)?$/.test(x.trim()))
          return parseFloat(x);
        try {
          return p?.[C]?.baseVal?.value || 0;
        } catch {
          return 0;
        }
      }, m = d("width", l), g = d("height", u);
      if (!m || !g)
        return;
      let y = r.value ||= go(t, e), b = y.density * y.stretch(p || c), w = await yo(f, m * b, g * b);
      w && (c.setAttribute("href", w), Kn(c, "attribute", "href", f, w, e), c.hasAttribute("xlink:href") && (c.setAttributeNS(Gs, "xlink:href", w), Kn(c, "attribute", "xlink:href", f, w, e)), o++);
    }, a = 6;
    for (let c = 0;c < i.length; c += a)
      await Promise.allSettled(i.slice(c, c + a).map(s));
    return { count: o };
  }
  async function Zn(t, e, n) {
    if (!e.compress)
      return;
    let r = {};
    await nu(t, e, n, r), await iu(t, e, n, r), await su(t, e, n, r);
  }
  ht();
  dt();
  wt();
  function au(t, e) {
    if (Y())
      return t;
    let n = t.indexOf("</style>");
    if (n === -1)
      return t;
    let r = /<style\b[^>]*>[\s\S]*?<\/style>/g, i = [], o = n, s;
    for (r.lastIndex = n;s = r.exec(t); )
      i.push({ text: t.slice(o, s.index), intern: true }), i.push({ text: s[0], intern: false }), o = r.lastIndex;
    i.push({ text: t.slice(o), intern: true });
    let a = new Map, c = / style="([^"]*)"/g, f;
    for (let y of i)
      if (y.intern)
        for (c.lastIndex = 0;f = c.exec(y.text); )
          a.set(f[1], (a.get(f[1]) || 0) + 1);
    let l = 0;
    for (let [y, b] of a)
      b > 1 && (l += (b - 1) * y.length);
    if (l < 2048 || t.includes(" data-sdi="))
      return t;
    let u = cu(e, i.some((y) => !y.intern), t.includes("data-snapdom-asset"));
    if (u === null)
      return t;
    let p = new Map, h = 0, d = [], m = (y, b) => {
      if ((a.get(b) || 0) < 2 || u.has(b))
        return y;
      let w = p.get(b);
      return w === undefined && (w = "i" + (h++).toString(36), p.set(b, w), d.push(`[data-sdi="${w}"]{${b}}`)), ` data-sdi="${w}"`;
    }, g = "";
    for (let y of i)
      g += y.intern ? y.text.replace(c, m) : y.text;
    return t.slice(0, n) + d.join("") + g;
  }
  function cu(t, e, n) {
    let r = new Set;
    if (!e && !n)
      return r;
    if (!t || t.querySelector("[data-sdi]"))
      return null;
    let i = (c) => {
      let f = c.getAttribute("style");
      f && r.add(f);
    };
    if (n && t.querySelectorAll("[data-snapdom-asset][style]").forEach(i), e)
      try {
        let c = (f) => {
          for (let l of f) {
            if (l.type === CSSRule.IMPORT_RULE || l.type === CSSRule.NAMESPACE_RULE)
              throw new Error("External or namespaced CSS");
            if (l.selectorText) {
              if (/\[\s*style\b|data-sdi|\[[^\]]*\\|&/i.test(l.selectorText))
                throw new Error("Attribute-dependent or nested CSS");
              t.querySelectorAll(l.selectorText).forEach(i);
            }
            l.cssRules && c(l.cssRules);
          }
        };
        for (let f of [...t.querySelectorAll("style")].slice(1)) {
          let l = f.textContent || "";
          if (/@import\b/i.test(l))
            return null;
          let u = new CSSStyleSheet;
          u.replaceSync(l), c(u.cssRules);
        }
      } catch {
        return null;
      }
    let o = new Set, s = document.createElement("div"), a = new XMLSerializer;
    for (let c of r) {
      s.setAttribute("style", c);
      let f = a.serializeToString(s).match(/ style="([^"]*)"/);
      f && o.add(f[1]);
    }
    return o;
  }
  async function tr(t, e) {
    let { clipWindow: n, outerTransforms: r, outerShadows: i, rootTransform2D: o, fontsCSS: s } = e, a = t.options;
    if (t !== a) {
      let { options: K, ...tt } = t;
      t = Object.assign(a, tt), Object.defineProperty(t, "options", { value: t, configurable: true });
    }
    let c, f;
    Fs(t, s), await Nt("beforeRender", t);
    let l = W(t.element), u = t.element.getBoundingClientRect(), p = Math.max(1, I(t.element.offsetWidth || parseFloat(l.width) || u.width || 1)), h = Math.max(1, I(t.element.offsetHeight || parseFloat(l.height) || u.height || 1)), d = t.element.ownerDocument || document;
    if (!n && (t.element === d.body || t.element === d.documentElement) && !t.__pinned) {
      let K = Math.max(t.element.scrollHeight || 0, d.documentElement?.scrollHeight || 0, d.body?.scrollHeight || 0), tt = Math.max(t.element.scrollWidth || 0, d.documentElement?.scrollWidth || 0, d.body?.scrollWidth || 0);
      K > 0 && (h = Math.max(h, I(K))), tt > 0 && (p = Math.max(p, I(tt)));
      try {
        let Q = (t.scrollbarCSS || "").length + (t.baseCSS || "").length + (t.fontsCSS || "").length + (t.classCSS || "").length, et = P.measureHints.get(t.element);
        if (et && et.cssLen === Q && et.w0 === p && et.docH === K && et.docW === tt)
          et.csh > 0 && (h = Math.max(h, I(et.csh))), et.csw > 0 && (p = Math.max(p, I(et.csw)));
        else {
          let nt = d.createElement("div");
          J(nt), nt.style.cssText = "position:absolute!important;left:-9999px!important;top:0!important;width:" + p + "px!important;overflow:visible!important;visibility:hidden!important;";
          let Xt = nt.attachShadow({ mode: "open" }), Yt = d.createElement("style");
          Yt.textContent = (t.scrollbarCSS || "") + t.baseCSS + "svg{overflow:visible;} foreignObject{overflow:visible;}" + t.classCSS, Xt.appendChild(Yt), Xt.appendChild(t.clone.cloneNode(true)), d.body.appendChild(nt);
          let { scrollHeight: He, scrollWidth: Ot } = nt;
          d.body.removeChild(nt), P.measureHints.set(t.element, { cssLen: Q, w0: p, docH: K, docW: tt, csh: He, csw: Ot }), He > 0 && (h = Math.max(h, I(He))), Ot > 0 && (p = Math.max(p, I(Ot)));
        }
      } catch {}
    }
    if (t.options?.excludeMode === "remove" || typeof t.options?.filter == "function" && t.options.filterMode === "remove") {
      let K = fo(t.element, t.options), tt = 1, Q = fo(t.element, {}), et = Math.max(2, h * 0.15);
      Number.isFinite(Q) && Q >= h - et && Number.isFinite(K) && K > 0 && (h = Math.max(1, Math.min(h, I(K + tt))));
    }
    if (t.options?.reconcile)
      try {
        let K = (t.scrollbarCSS || "") + t.baseCSS + "svg{overflow:visible;} foreignObject{overflow:visible;}" + t.classCSS;
        Rs(t.element, t.clone, K, t.nodeMap, p, h);
      } catch (K) {
        console.warn("[snapdom] reconcile pass failed:", K);
      }
    let g = (K, tt = NaN) => {
      let Q = typeof K == "string" ? parseFloat(K) : K;
      return Number.isFinite(Q) ? Q : tt;
    }, y = g(t.options.width), b = g(t.options.height), w = n ? I(n.width) : p, C = n ? I(n.height) : h, x = w, S = C, A = Number.isFinite(y), v = Number.isFinite(b), M = C > 0 ? w / C : 1;
    A && v ? (x = Math.max(1, I(y)), S = Math.max(1, I(b))) : A ? (x = Math.max(1, I(y)), S = Math.max(1, I(x / (M || 1)))) : v && (S = Math.max(1, I(b)), x = Math.max(1, I(S * (M || 1))));
    let k = 0, R = 0, E = p, T = h;
    if (n) {
      let K = 0, tt = 0;
      if (bo(t.element)) {
        let Q = null;
        if (!r && o && Number.isFinite(o.a))
          Q = { a: o.a, b: o.b || 0, c: o.c || 0, d: o.d || 1, e: 0, f: 0 };
        else {
          let et = se(t.element), nt = lo(l.transform && l.transform !== "none" ? l.transform : "", et);
          nt && nt.is2D && (Q = { a: nt.a, b: nt.b, c: nt.c, d: nt.d, e: 0, f: 0 });
        }
        if (Q && !(Q.a === 1 && Q.b === 0 && Q.c === 0 && Q.d === 1)) {
          let { ox: et, oy: nt } = on(l, p, h), Xt = Re(p, h, Q, et, nt);
          K = Xt.minX, tt = Xt.minY;
        }
      }
      k = I(n.x + K), R = I(n.y + tt), E = I(k + n.width), T = I(R + n.height);
    } else if (!r && o && Number.isFinite(o.a)) {
      let K = { a: o.a, b: o.b || 0, c: o.c || 0, d: o.d || 1, e: 0, f: 0 }, tt = Re(p, h, K, 0, 0);
      k = I(tt.minX), R = I(tt.minY), E = I(tt.maxX), T = I(tt.maxY);
    } else if (r && bo(t.element)) {
      let tt = l.transform && l.transform !== "none" ? l.transform : "", Q = se(t.element), et = qt({ baseTransform: tt, rotate: Q.rotate || "0deg", scale: Q.scale, translate: Q.translate, width: p, height: h }), { ox: nt, oy: Xt } = on(l, p, h), Yt = et.is2D ? et : new DOMMatrix(et.toString()), He = { a: Yt.a, b: Yt.b, c: Yt.c, d: Yt.d, e: 0, f: 0 }, Ot = Re(p, h, He, nt, Xt);
      k = I(Ot.minX), R = I(Ot.minY), E = I(Ot.maxX), T = I(Ot.maxY);
    }
    let N = no(l), O = ro(l), H = oo(l), _ = io(l), L = so(l), $ = u.width > 0 ? (E - k) / u.width : 1, F = u.height > 0 ? (T - R) / u.height : 1, V = i === "subtree" && !n ? ys(t.element, t.nodeMap, t.styleCache, $, F) : { top: 0, right: 0, bottom: 0, left: 0 }, z = n ? { top: 0, right: 0, bottom: 0, left: 0 } : i ? { top: I(Math.max(N.top, O.top, V.top) + H.top + _.top + L.bleed.top), right: I(Math.max(N.right, O.right, V.right) + H.right + _.right + L.bleed.right), bottom: I(Math.max(N.bottom, O.bottom, V.bottom) + H.bottom + _.bottom + L.bleed.bottom), left: I(Math.max(N.left, O.left, V.left) + H.left + _.left + L.bleed.left) } : { top: H.top, right: H.right, bottom: H.bottom, left: H.left };
    k = I(k - z.left), R = I(R - z.top), E = I(E + z.right), T = I(T + z.bottom);
    let q = Math.max(1, I(E - k)), B = Math.max(1, I(T - R)), Z = "http://www.w3.org/2000/svg", Mt = bo(t.element) ? 2 : 0, gt = I(Mt + (r ? 0 : 1)), st = Math.ceil(q + gt * 2), at = Math.ceil(B + gt * 2), $t = I(-(I(k) - gt)), U = I(-(I(R) - gt)), G = Math.max(0, $t), j = Math.max(0, U), ut = I(st - Math.min(0, $t)), Et = I(at - Math.min(0, U)), yt = document.createElementNS(Z, "foreignObject");
    yt.setAttribute("x", String(Math.min(0, $t))), yt.setAttribute("y", String(Math.min(0, U))), yt.setAttribute("width", String(ut)), yt.setAttribute("height", String(Et)), yt.style.overflow = "visible";
    let fe = document.createElement("style"), dn = "svg{overflow:visible;} foreignObject{overflow:visible;} foreignObject>div{-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important;}";
    fe.textContent = (t.scrollbarCSS || "") + t.baseCSS + t.fontsCSS + dn + t.classCSS, yt.appendChild(fe);
    let Be = document.createElement("div");
    Be.setAttribute("xmlns", "http://www.w3.org/1999/xhtml"), Be.style.cssText = `all:initial;box-sizing:border-box;display:block;overflow:visible;width:${ut}px;height:${Et}px` + (G !== 0 || j !== 0 ? `;padding:${j}px 0 0 ${G}px !important` : ""), Be.appendChild(t.clone), yt.appendChild(Be);
    let fr = new XMLSerializer().serializeToString(yt), It = A || v, ur = Object.freeze({ w0: w, h0: C, vbW: st, vbH: at, targetW: x, targetH: S, contentX: I($t + (n ? k : 0)), contentY: I(U + (n ? R : 0)), clip: n ? Object.freeze({ x: I(k), y: I(R), width: w, height: C }) : null });
    Object.defineProperty(a, "meta", { value: ur, enumerable: true, writable: false, configurable: true });
    let dr = !It || Y() ? st : A ? x : I(st * (S / at)), pn = !It || Y() ? at : v ? S : I(at * (x / st)), Wt = parseFloat(W(d.documentElement)?.fontSize) || 16;
    f = `<svg xmlns="${Z}" width="${dr}" height="${pn}" viewBox="0 0 ${st} ${at}" font-size="${Wt}px">` + au(fr, yt) + "</svg>", c = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(f)}`, t.svgString = f, t.dataURL = c, a.__artifacts = { classCSS: t.classCSS || "", fontsCSS: t.fontsCSS || "", baseCSS: t.baseCSS || "", scrollbarCSS: t.scrollbarCSS || "" }, await Nt("afterRender", t), t.clone = t.nodeMap = t.styleCache = t.svgString = null;
    let pr = [...document.querySelectorAll("#snapdom-sandbox")].find(Ut);
    return pr && pr.style.position === "absolute" && pr.remove(), t.dataURL;
  }
  function bo(t) {
    return ws(t);
  }
  function lu(t) {
    let e = Array.isArray(t.plugins) ? t.plugins : mo(), n = [];
    for (let r of e) {
      let i = Ne(r);
      i && typeof i.resolveNode == "function" && n.push(i.resolveNode.bind(i));
    }
    return n.length ? n : null;
  }
  async function Zs(t, e) {
    if (!t)
      throw new Error("Element cannot be null or undefined");
    e.__session = Ls(e.cache), delete e.__compressedAssets, delete e.__compressedSnapshot, delete e.__compressionDensity, e.__resolveNodeHooks = lu(e);
    let n = e;
    n.element = t, Object.defineProperty(n, "options", { value: n, configurable: true });
    let r, i, o, s, a, c, f, l = "", u = null, p = e.needs || ft, h = n.format, d = n.type;
    await Nt("beforeSnap", n);
    let m = n.format !== h && /^(?:png|jpe?g|webp|svg)$/i.test(n.format), g = n.type !== d && /^(?:png|jpe?g|webp|svg)$/i.test(n.type);
    if (m || g) {
      let E = String(m ? n.format : n.type).toLowerCase();
      n.format = E === "jpg" ? "jpeg" : E, n.type = n.format, n.__explicitFormat = n.format, /^(?:jpeg|webp)$/.test(n.format) && (n.backgroundColor == null || n.backgroundColor === "transparent") && (n.backgroundColor = "#ffffff");
    }
    await Nt("beforeClone", n);
    let y = n.outerTransforms !== false, b = n.outerShadows === "subtree" ? "subtree" : !!n.outerShadows, w = n.clip ? On(n.element, n.clip) : null;
    if (e.__styleShare === undefined)
      try {
        e.__styleShare = mi(n.element) && (typeof n.element.getAnimations != "function" || n.element.getAnimations({ subtree: true }).length === 0);
      } catch {
        e.__styleShare = false;
      }
    let C = qn(n.element, w);
    try {
      ({ clone: r, classCSS: i, classPrefixCSS: o, styleCache: s, nodeMap: a, reconcileRisk: c, clipWindow: f } = await Ts(n.element, n.options)), c > 0 && !e.reconcile && (St(e.__session, "reconcile-risk", "text in inline/table-cell elements kept natural width and may re-wrap; pass { reconcile: true } for pixel-exact layout"), P.warnedReconcile || (P.warnedReconcile = true, console.warn("[snapdom] Text in inline/table-cell elements kept its natural width and may re-wrap under font-fallback rasterization. Pass { reconcile: true } for pixel-exact layout (roughly doubles capture time)."))), !y && r && (u = bs(n.element, r)), !b && r && As(n.element, r, n.options), r && (Es(n.element, r, a), Ms(n.element, r));
    } finally {
      C();
    }
    if (n.clone = r, n.classCSS = i, n.styleCache = s, n.nodeMap = a, await Nt("afterClone", n), !$e(p, "render"))
      return null;
    if (Dn(n.clone), n.options?.excludeMode === "remove" || typeof n.options?.filter == "function" && n.options.filterMode === "remove")
      try {
        _s(n.element, n.clone, n.styleCache, n.nodeMap);
      } catch (E) {
        St(e.__session, "shrink-failed", "shrink pass failed", E), console.warn("[snapdom] shrink pass failed:", E);
      }
    try {
      await Rn(n.clone, n.element, n.nodeMap);
    } catch {}
    let x = (E) => Promise.resolve().then(E), S = (async () => {
      await Promise.all([x(() => Un(n.clone, n.options)), x(() => zn(n.element, n.clone, n.styleCache, n.options, n.nodeMap))]);
      try {
        Ns(n.element, n.clone, n.nodeMap);
      } catch (E) {
        St(e.__session, "backdrop-filter-failed", "backdrop-filter emulation failed", E), console.warn("[snapdom] backdrop-filter emulation failed:", E);
      }
      if (e.compress && (e.__compressionClip = f, e.__compressionRootTransform = u, await x(() => Zn(n.clone, n.options, n.nodeMap))), e.captureSelection)
        try {
          Ui(n.nodeMap);
        } catch (E) {
          St(e.__session, "selection-compose-failed", "field selection compose failed", E);
        }
    })(), A = Promise.resolve();
    (e.embedFonts === "auto" ? ((n.element.ownerDocument || document).fonts?.size || 0) > 0 : e.embedFonts) && (A = x(async () => {
      let E = n.element.ownerDocument || document, T = w ? (H) => {
        try {
          let _ = H.getBoundingClientRect();
          return _.right >= w.left - 200 && _.left <= w.right + 200 && _.bottom >= w.top - 200 && _.top <= w.bottom + 200;
        } catch {
          return true;
        }
      } : null, { required: N, usedCodepoints: O } = !w && e.__fontUsage || Pn(n.element, T);
      if (e.embedFonts === "auto") {
        let H = new Set;
        try {
          for (let L of E.fonts)
            H.add(String(L.family).replace(/["']/g, "").toLowerCase());
        } catch {}
        if (!(H.size > 0 && Array.from(N).some((L) => H.has(String(L).split("__")[0].toLowerCase()))))
          return;
      }
      if (Y()) {
        let H = new Set(Array.from(N).map((_) => String(_).split("__")[0]).filter(Boolean));
        await Nn(H, 1, E);
      }
      l = await es({ required: N, usedCodepoints: O, exclude: n.options.excludeFonts, localFonts: n.options.localFonts, useProxy: n.options.useProxy, fontStylesheetDomains: n.options.fontStylesheetDomains, iconMatchers: n.options.__iconMatchers, doc: E });
    })), await Promise.all([S, A]);
    let M = (n.options.plugins || []).some((E) => E && (typeof E.beforeRender == "function" || typeof E.afterRender == "function"));
    n.options.engine;
    let k = n.clone;
    Jn(k, e.__compressedAssets);
    let R = await tr(n, { clipWindow: f, outerTransforms: y, outerShadows: b, rootTransform2D: u, fontsCSS: l });
    if (e.__compressedSnapshot = Qn(k, e.__compressedAssets), typeof e.__retain == "function")
      try {
        e.__retain({ clone: r, nodeMap: a, styleCache: s, styleMap: e.__session.styleMap, classPrefixCSS: o, fontsCSS: l, clipWindow: f, outerTransforms: y, outerShadows: b, rootTransform2D: u, __compressedAssets: e.__compressedAssets, __compressionDensity: e.__compressionDensity });
      } catch {}
    return R;
  }
  dt();
  bt();
  var fu = new Set(["png", "jpeg", "jpg", "webp", "svg"]);
  function ta(t = {}) {
    let e = typeof t.type == "string" && fu.has(t.type.toLowerCase()) ? t.type.toLowerCase() : null, n = t.format ?? e ?? "png";
    n === "jpg" && (n = "jpeg");
    let r = t.format != null ? n : e === "jpg" ? "jpeg" : e, i = zo(t.cache), o = t.exclude == null ? [] : Array.isArray(t.exclude) ? t.exclude : [t.exclude], s = [], a = [];
    for (let u of o)
      typeof u == "string" ? s.push(u) : typeof u == "function" ? a.push(u) : u != null && console.warn("[snapdom] Ignored invalid exclude entry (expected selector string or predicate):", u);
    let c = t.excludeMode ?? "hide", f = (u) => {
      if (!u || u.nodeType !== 1)
        return false;
      if (u.getAttribute("data-capture") === "exclude")
        return true;
      for (let p of Array.isArray(l.exclude) ? l.exclude : [])
        try {
          if (u.matches(p))
            return true;
        } catch {}
      for (let p of Array.isArray(l.excludePredicates) ? l.excludePredicates : [])
        try {
          if (p(u))
            return true;
        } catch {}
      if (typeof l.filter == "function")
        try {
          if (!l.filter(u))
            return true;
        } catch {}
      return false;
    }, l = { debug: t.debug ?? false, scale: t.scale ?? 1, exclude: s, excludePredicates: a.length ? a : null, excludeMode: c, filter: t.filter ?? null, filterMode: t.filterMode ?? "hide", shouldExclude: f, placeholders: t.placeholders !== false, captureSelection: t.captureSelection ?? false, canvas: rt(t.canvas, "canvas") ? t.canvas : null, embedFonts: t.embedFonts ?? "auto", iconFonts: Array.isArray(t.iconFonts) ? t.iconFonts : t.iconFonts ? [t.iconFonts] : [], __iconMatchers: Vi(t.iconFonts), localFonts: Array.isArray(t.localFonts) ? t.localFonts : [], excludeFonts: t.excludeFonts ?? undefined, fontStylesheetDomains: Array.isArray(t.fontStylesheetDomains) ? t.fontStylesheetDomains : [], fallbackURL: t.fallbackURL ?? undefined, cache: i, __styleShare: t.__styleShare, useProxy: typeof t.useProxy == "string" ? t.useProxy : "", width: t.width ?? null, height: t.height ?? null, format: n, __explicitFormat: r, type: n, quality: t.quality ?? 0.92, dpr: t.dpr ?? (window.devicePixelRatio || 1), backgroundColor: t.backgroundColor ?? (["jpeg", "webp"].includes(n) ? "#ffffff" : null), filename: t.filename ?? "snapDOM", outerTransforms: t.outerTransforms ?? true, outerShadows: t.outerShadows ?? false, reconcile: t.reconcile ?? false, burst: t.burst, engine: t.engine, invalidate: t.invalidate ?? false, __pinned: t.__pinned === true, clip: t.clip ?? null, compress: t.compress !== false, excludeStyleProps: t.excludeStyleProps ?? null, resolvePicturePlaceholders: t.resolvePicturePlaceholders !== false };
    return l;
  }
  kt();
  Qt();
  ht();
  var ea = "svg,iframe,canvas,video,audio,object,embed,slot,template,picture,style,pre";
  function uu(t) {
    try {
      return t.matches?.("dialog,[popover]") || !!t.querySelector?.("dialog,[popover]");
    } catch {
      return true;
    }
  }
  var du = /(?:^|;)\s*(?:-webkit-)?backdrop-filter:\s*(?!none(?:\s*!important)?(?:;|$))[^;]+/i;
  function pu(t) {
    if (t.__usesBackdropFilter !== undefined)
      return t.__usesBackdropFilter;
    let e = false;
    for (let n of t.styleMap.values())
      if (du.test(n)) {
        e = true;
        break;
      }
    return t.__usesBackdropFilter = e, e;
  }
  function hu(t, e) {
    let n = e.has("backdrop-filter") || e.has("-webkit-backdrop-filter");
    if (!n && (n = ((o) => /(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:/i.test(o.getAttribute?.("style") || ""))(t), !n))
      try {
        n = !!t.querySelector?.('[style*="backdrop-filter" i]');
      } catch {
        n = true;
      }
    if (!n)
      return false;
    let r = [t];
    t.querySelectorAll && r.push(...t.querySelectorAll("*"));
    for (let i of r) {
      let o = getComputedStyle(i), s = o.getPropertyValue("backdrop-filter") || o.getPropertyValue("-webkit-backdrop-filter");
      if (s && s !== "none")
        return true;
    }
    return false;
  }
  var wo = new WeakMap;
  function mu(t, e) {
    if (wo.has(e))
      return wo.get(e);
    let n = false, r = { budget: 20000 }, i = (o) => {
      for (let s = 0;s < o.length && !n; s++) {
        if (--r.budget < 0) {
          n = true;
          return;
        }
        let a = o[s], c = a.selectorText;
        if (c && /[+~]|:has\(/.test(c)) {
          n = true;
          return;
        }
        let f = a.style;
        if (f && (f.counterReset || f.counterIncrement || f.counterSet || f.content && f.content.includes("counter"))) {
          n = true;
          return;
        }
        a.cssRules && a.cssRules.length && i(a.cssRules);
      }
    };
    try {
      for (let o of t.styleSheets) {
        let s = null;
        try {
          s = o.cssRules;
        } catch {
          n = true;
        }
        if (n)
          break;
        s && i(s);
      }
      if (!n) {
        let o = t.adoptedStyleSheets;
        if (Array.isArray(o))
          for (let s of o) {
            if (n)
              break;
            try {
              i(s.cssRules);
            } catch {
              n = true;
            }
          }
      }
    } catch {
      n = true;
    }
    return wo.set(e, n), n;
  }
  var gu = 1 / 16;
  function yu(t, e) {
    if (t === e)
      return true;
    if (!t.endsWith("px") || !e.endsWith("px"))
      return false;
    let n = parseFloat(t), r = parseFloat(e);
    return Number.isFinite(n) && Number.isFinite(r) && Math.abs(n - r) <= gu;
  }
  var er = new Map;
  var bu = ["width", "height", "min-width", "min-height"];
  function wu(t) {
    let e = er.get(t);
    if (e === undefined) {
      e = null;
      for (let n of bu) {
        let r = t.match(new RegExp("(?:^|;)" + n + ":([^;]+)"));
        r && r[1].endsWith("px") && ((e ||= {})[n] = r[1]);
      }
      er.size > 5000 && er.clear(), er.set(t, e);
    }
    return e;
  }
  function Su(t) {
    if (!(!t.classList || !t.classList.length))
      for (let e of Array.from(t.classList))
        /^c\d+$/.test(e) && t.classList.remove(e);
  }
  function xu(t, e) {
    let n = [t];
    for (;n.length; ) {
      let r = n.pop();
      if (r.nodeType === 1) {
        let i = e.nodeMap.get(r);
        i !== undefined && (e.nodeMap.delete(r), e.srcToClone.get(i) === r && e.srcToClone.delete(i)), e.styleMap.delete(r);
      }
      for (let i = r.firstChild;i; i = i.nextSibling)
        n.push(i);
    }
  }
  var So = { attempts: 0, served: 0, reconciled: 0 };
  async function na(t, e, n) {
    So.attempts++;
    try {
      let r = await vu(t, e, n);
      return r && So.served++, r;
    } catch {
      return null;
    }
  }
  async function vu(t, e, n) {
    let r = e.retained;
    if (!r || !r.clone || !r.styleMap || !r.srcToClone || n.reconcile || n.clip || n.captureSelection || r.clipWindow || t.scrollTop || t.scrollLeft || uu(t) || pu(r) || r.fontsCSS || Xn(n))
      return null;
    for (let u of n.plugins || [])
      if (u && (typeof u.beforeSnap == "function" || typeof u.beforeClone == "function" || typeof u.resolveNode == "function" || typeof u.afterClone == "function"))
        return null;
    if (r.classPrefixCSS && (r.classPrefixCSS.includes("::marker") || r.classPrefixCSS.includes("::first-line")) || n.excludeMode === "remove")
      return null;
    let i = t.ownerDocument || document, o = Ze(t);
    if (!o || mu(i, o))
      return null;
    let s = [];
    t:
      for (let u of e.dirtyRoots) {
        if (!u.isConnected || u === t || !t.contains(u))
          return null;
        for (let p of e.dirtyRoots)
          if (p !== u && p !== t && p.contains(u))
            continue t;
        s.push(u);
      }
    if (!s.length)
      return null;
    n.__compressedAssets = r.__compressedAssets, n.__compressionDensity = r.__compressionDensity, n.__compressionRootTransform = r.rootTransform2D;
    for (let u of s) {
      if (u.parentElement === t || u.matches?.(ea) || u.querySelector?.(ea) || hu(u, o))
        return null;
      let p = r.srcToClone.get(u);
      if (!p || !p.parentNode)
        return null;
      let h = new Map, d = { styleMap: r.styleMap, styleCache: r.styleCache, nodeMap: h, options: n }, m = qn(u, null), g = Wn(u), y;
      try {
        y = await ie(u, d, n);
      } finally {
        g(), m();
      }
      if (!y || y.nodeType !== 1 || y.querySelector?.("style[data-sd]") || (await _e(u, y, d, n), d.__pseudoCSS))
        return null;
      await Cn(y, d), Dn(y);
      try {
        await Rn(y, u, h);
      } catch {}
      if (await Promise.all([Un(y, n), zn(u, y, r.styleCache, n, h)]), n.compress)
        try {
          await Zn(y, n, h);
        } catch {}
      for (let [b, w] of h.entries())
        po(b, w);
      p.replaceWith(y), xu(p, r);
      for (let [b, w] of h.entries())
        r.nodeMap.set(b, w), r.srcToClone.set(w, b);
    }
    let a = { styleMap: r.styleMap, styleCache: r.styleCache, nodeMap: r.nodeMap, options: n };
    for (let [u, p] of r.nodeMap.entries()) {
      if (!p || p.nodeType !== 1 || !p.isConnected)
        continue;
      let h = r.styleMap.get(u);
      if (!h)
        continue;
      let d = wu(h);
      if (!d)
        continue;
      let m = null, g = false;
      for (let y in d)
        if (m ||= getComputedStyle(p), !yu(m.getPropertyValue(y), d[y])) {
          g = true;
          break;
        }
      if (g) {
        if (n.__compressedAssets?.has(u))
          return null;
        So.reconciled++, await lt(p, u, a, n);
      }
    }
    let c = Ge(r.styleMap);
    for (let [u, p] of r.styleMap.entries())
      Su(u), uo(u, p, c);
    let f = (r.classPrefixCSS || "") + Array.from(c.entries()).map(([u, p]) => `.${p}{${u}}`).join("");
    Jn(r.clone, n.__compressedAssets);
    let l = await tr({ element: t, options: n, plugins: n.plugins, clone: r.clone, classCSS: f, styleCache: r.styleCache, nodeMap: r.nodeMap }, { clipWindow: null, outerTransforms: r.outerTransforms, outerShadows: r.outerShadows, rootTransform2D: r.rootTransform2D, fontsCSS: r.fontsCSS || "" });
    return n.__compressedSnapshot = Qn(r.clone, n.__compressedAssets), r.__compressedAssets = n.__compressedAssets, r.__compressionDensity = n.__compressionDensity, l;
  }
  bt();
  var vo = new WeakMap;
  var rr = new WeakMap;
  var da = new WeakSet;
  var xo = new WeakMap;
  var ku = 64;
  var an = new Map;
  var pa = ["scroll", "input", "change", "focusin", "focusout", "pointerdown", "pointerup", "pointercancel", "keydown", "keyup", "beforetoggle", "toggle"];
  var Cu = ["(prefers-color-scheme: dark)", "(prefers-reduced-motion: reduce)", "(prefers-contrast: more)", "(forced-colors: active)", "(inverted-colors: inverted)", "(prefers-reduced-transparency: reduce)", "(hover: hover)", "(any-hover: hover)", "(pointer: coarse)", "(any-pointer: coarse)", "(color-gamut: p3)", "(dynamic-range: high)"];
  function Au(t) {
    let e = t?.defaultView;
    return typeof e?.matchMedia != "function" ? "" : Cu.map((n) => {
      try {
        return e.matchMedia(n).matches ? "1" : "0";
      } catch {
        return "?";
      }
    }).join("");
  }
  function ra(t) {
    let e = [];
    for (let n = t;n; ) {
      try {
        let r = n.getBoundingClientRect();
        e.push(r.x, r.y, r.width, r.height);
      } catch {
        e.push("?");
      }
      n.parentElement ? n = n.parentElement : n = n.getRootNode?.()?.host || null;
    }
    return e.join("|");
  }
  function oa(t, e) {
    if (e.disposed || (an.delete(t), an.set(t, e), an.size <= ku))
      return;
    let [n, r] = an.entries().next().value;
    ha(n, r);
  }
  function ha(t, e) {
    e.disposed = true, an.delete(t), vo.delete(t);
    for (let n of e.observers)
      try {
        n.disconnect();
      } catch {}
    for (let n of pa)
      t.removeEventListener(n, e.onMediaDirty, true);
    for (let n of e.trackedShadowRoots.keys())
      for (let r of Co)
        n.removeEventListener(r, e.onMediaDirty, true);
    for (let [n, r] of e.trackedImages)
      n.removeEventListener("load", r), n.removeEventListener("error", r);
    e.trackedImages.clear(), e.trackedShadowRoots.clear(), e.images.length = 0, e.controls.length = 0, e.scrollNodes.length = 0, e.observers.length = 0, e.last = null, e.retained = null, e.retainedFrameDriven = false;
  }
  function ma(t) {
    if (da.has(t))
      return false;
    rr.delete(t);
    let e = [t], n = [], r = [];
    for (let i = 0;i < e.length; i++) {
      let o = e[i], s = [];
      o?.nodeType === 1 && s.push(o);
      try {
        s.push(...o.querySelectorAll("*"));
      } catch {
        return false;
      }
      for (let a of s) {
        a.shadowRoot && e.push(a.shadowRoot);
        let c = String(a.localName || a.tagName || "").toLowerCase();
        if (/^(?:iframe|canvas|video|audio|object|embed|marquee|blink)$/.test(c) || c === "progress" && !a.hasAttribute("value") || /^(?:animate|animatetransform|animatemotion|set)$/.test(c))
          return false;
        let f = "";
        if (c === "img") {
          r.push(a);
          try {
            f = a.currentSrc || a.src || "";
          } catch {}
        }
        /^(?:input|textarea|select|option)$/.test(c) && n.push(a);
        let l = a.getAttribute?.("style") || "", u = xo.get(a);
        if (f || l) {
          if ((!u || u.src !== f || u.style !== l) && (u = { src: f, style: l, animated: We(f) || We(l) }, xo.set(a, u)), u.animated)
            return false;
        } else
          u && xo.delete(a);
      }
    }
    return rr.set(t, { roots: e.slice(1), controls: n, images: r }), true;
  }
  function ko(t, e) {
    if (!t.querySelectorAll)
      return false;
    let n = rr.get(t);
    rr.delete(t);
    let r = new Set(n?.roots || []);
    if (n && (e.controls = n.controls, e.scannedImages = n.images), !n) {
      let i = [t];
      for (let o = 0;o < i.length; o++) {
        let s = i[o];
        s.shadowRoot && !r.has(s.shadowRoot) && (r.add(s.shadowRoot), i.push(s.shadowRoot));
        for (let a of s.querySelectorAll("*"))
          a.shadowRoot && !r.has(a.shadowRoot) && (r.add(a.shadowRoot), i.push(a.shadowRoot));
      }
    }
    for (let [i, o] of e.trackedShadowRoots)
      if (!r.has(i)) {
        try {
          o.disconnect();
        } catch {}
        for (let a of Co)
          i.removeEventListener(a, e.onMediaDirty, true);
        e.trackedShadowRoots.delete(i);
        let s = e.observers.indexOf(o);
        s >= 0 && e.observers.splice(s, 1);
      }
    for (let i of r)
      if (!e.trackedShadowRoots.has(i))
        try {
          let o = new MutationObserver(e.markDirty);
          o.observe(i, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }), o.__flush = e.markDirty, e.observers.push(o), e.trackedShadowRoots.set(i, o);
          for (let s of Co)
            i.addEventListener(s, e.onMediaDirty, { capture: true, passive: true });
          e.retained && e.dirtyAll();
        } catch {}
    return !!n;
  }
  var Co = ["scroll", "change", "beforetoggle", "toggle"];
  function or(t, e) {
    return [t, ...e.trackedShadowRoots.keys()];
  }
  function Ao(t, e) {
    let n = e.scannedImages;
    if (e.scannedImages = null, !n) {
      n = [], t.tagName === "IMG" && n.push(t);
      for (let r of or(t, e))
        r.querySelectorAll && n.push(...r.querySelectorAll("img"));
    }
    if (e.images = n, e.trackedImages.size) {
      let r = new Set(n);
      for (let [i, o] of e.trackedImages)
        r.has(i) || (i.removeEventListener("load", o), i.removeEventListener("error", o), e.trackedImages.delete(i));
    }
    for (let r of n) {
      if (r.complete || e.trackedImages.has(r))
        continue;
      let i = () => {
        e.capturing && (e.torn = true), e.dirty = true, e.dirtyRoots = null, r.removeEventListener("load", i), r.removeEventListener("error", i), e.trackedImages.delete(r);
      };
      e.trackedImages.set(r, i), r.addEventListener("load", i), r.addEventListener("error", i);
    }
  }
  function Mu(t) {
    let e = new Map, n = new Map, r = new Map;
    for (let i of t)
      if (te(i))
        if (i.type === "attributes") {
          let o = e.get(i.target);
          o || e.set(i.target, o = new Map), o.has(i.attributeName) || o.set(i.attributeName, i.oldValue);
        } else if (i.type === "characterData")
          n.has(i.target) || n.set(i.target, i.oldValue);
        else if (i.type === "childList") {
          let o = r.get(i.target);
          o || r.set(i.target, o = new Map);
          for (let s of i.addedNodes) {
            if (s.nodeType !== 3)
              return true;
            o.set(s.data, (o.get(s.data) || 0) + 1);
          }
          for (let s of i.removedNodes) {
            if (s.nodeType !== 3)
              return true;
            o.set(s.data, (o.get(s.data) || 0) - 1);
          }
        } else
          return true;
    for (let [i, o] of e)
      for (let [s, a] of o)
        if (i.getAttribute(s) !== a)
          return true;
    for (let [i, o] of n)
      if (i.data !== o)
        return true;
    for (let i of r.values())
      for (let o of i.values())
        if (o !== 0)
          return true;
    return false;
  }
  var Eu = /(?:^data:image\/(?:gif|apng)|\.(?:gif|apng)(?=[?#)'"\s;]|$))/i;
  var Ie = (t) => t && (typeof t == "object" || typeof t == "function") ? nr(t) : "-";
  function _u(t, e = 131072) {
    if (t = String(t || "").trim(), !/^data:/i.test(t))
      return "";
    let n = t.indexOf(",");
    if (n < 0)
      return "";
    let r = t.slice(0, n), i = t.slice(n + 1);
    try {
      if (/;base64/i.test(r)) {
        let o = Math.ceil(e / 3) * 4;
        return atob(i.slice(0, o - o % 4));
      }
      return i.slice(0, e * 3).replace(/%([0-9a-f]{2})/gi, (o, s) => String.fromCharCode(parseInt(s, 16))).slice(0, e);
    } catch {
      return "";
    }
  }
  function Ru(t) {
    let e = (t.match(/^data:([^;,]+)/i)?.[1] || "").toLowerCase();
    if (e === "image/gif" || e === "image/apng")
      return true;
    if (!/image\/(?:png|webp|avif|svg\+xml)/.test(e))
      return false;
    let n = _u(t);
    return e === "image/png" ? n.includes("acTL") : e === "image/webp" ? n.includes("ANIM") || n.includes("ANMF") || n.includes("VP8X") && !!(n.charCodeAt(n.indexOf("VP8X") + 8) & 2) : e === "image/avif" ? n.includes("avis") : /<(?:animate|animateTransform|animateMotion|set)\b|@keyframes\b|animation(?:-name)?\s*:/i.test(n);
  }
  function ia(t) {
    let e = String(t || "").trim();
    return e ? Eu.test(e) ? true : /^data:/i.test(e) ? Ru(e) : false : false;
  }
  function We(t) {
    let e = String(t || "");
    if (ia(e))
      return true;
    for (let n of e.matchAll(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi))
      if (ia(n[1] ?? n[2] ?? n[3]))
        return true;
    return false;
  }
  function sa(t, e = null) {
    let n = t && t.clone;
    if (!n)
      return false;
    let r = e ? e.map((i) => t.srcToClone?.get(i)).filter(Boolean) : [n];
    for (let i of r)
      for (let o of ga(i))
        if (We(o.getAttribute?.("src")) || We(o.getAttribute?.("href")) || We(o.getAttribute?.("style")) || We(t.styleMap?.get(o)))
          return true;
    return false;
  }
  function ga(t) {
    let e = [];
    t && t.nodeType === 1 && e.push(t);
    try {
      e.push(...t.querySelectorAll("*"));
    } catch {}
    return e;
  }
  function Mo(t, e) {
    let n = [], r = new Set, i = (o) => {
      o && !r.has(o) && (r.add(o), n.push(o));
    };
    t.matches?.("input,textarea,select,option") && i(t);
    for (let o of or(t, e))
      try {
        for (let s of o.querySelectorAll("input,textarea,select,option"))
          i(s);
      } catch {}
    e.controls = n;
  }
  function Eo(t, e) {
    let n = [], r = new Set, i = (o, s = false) => {
      if (!(!o || r.has(o))) {
        r.add(o);
        try {
          (s || o.scrollLeft || o.scrollTop || o.scrollWidth > o.clientWidth || o.scrollHeight > o.clientHeight) && n.push(o);
        } catch {}
      }
    };
    for (let o = t;o; o = o.parentElement)
      i(o, true);
    for (let o of or(t, e))
      for (let s of ga(o))
        i(s);
    e.scrollNodes = n;
  }
  function aa(t, e) {
    let n = t.ownerDocument || document, r = n.defaultView, i = [r?.location?.hash || "", Au(n), r?.innerWidth || 0, r?.innerHeight || 0, r?.devicePixelRatio || 1, r?.screen?.orientation?.type || ""];
    try {
      i.push(...[...n.adoptedStyleSheets || []].map(Ie));
    } catch {}
    for (let l of e.trackedShadowRoots.keys())
      try {
        i.push("#shadow", ...[...l.adoptedStyleSheets || []].map(Ie));
      } catch {}
    let { activeElement: o, fullscreenElement: s } = n;
    (o?.contains(t) || t.contains(o)) && i.push(Ie(o)), (s?.contains(t) || t.contains(s)) && i.push(Ie(s));
    let a = [r?.scrollX || 0, r?.scrollY || 0];
    for (let l of e.scrollNodes)
      a.push(l.scrollLeft || 0, l.scrollTop || 0);
    let c = [];
    for (let l of e.controls) {
      let u = String(l.localName || "").toLowerCase();
      u === "input" ? c.push(l.type, Ve(l) ? l.value.length : l.value, l.checked ? 1 : 0, l.indeterminate ? 1 : 0) : u === "textarea" ? c.push(l.value) : u === "select" ? c.push(l.selectedIndex, l.value) : c.push(l.selected ? 1 : 0);
    }
    let f = [];
    for (let l of e.images) {
      let u = "";
      try {
        u = l.currentSrc || l.src || "";
      } catch {}
      f.push(u, l.complete ? 1 : 0, l.naturalWidth || 0, l.naturalHeight || 0);
    }
    return { style: i.join("|"), scroll: a.join("|"), controls: c, images: f, frameDriven: e.retainedFrameDriven };
  }
  function Le(t, e, n) {
    if (!t)
      return false;
    let r = t[n], i = e[n];
    if (r === i)
      return true;
    if (!Array.isArray(r) || r.length !== i.length)
      return false;
    for (let o = 0;o < r.length; o++)
      if (r[o] !== i[o])
        return false;
    return true;
  }
  function ca(t, e) {
    let n = new Set;
    for (let r of or(t, e))
      try {
        let i = r.getAnimations?.(r.nodeType === 1 ? { subtree: true } : undefined) || [];
        for (let o of i)
          n.add(o);
      } catch {}
    return [...n];
  }
  function la(t) {
    return t.map((e) => [Ie(e), e.playState, Math.round((Number(e.currentTime) || 0) * 10), e.playbackRate].join(":")).join("|");
  }
  function Fu(t, e, n) {
    if (!n || n.nodeType !== 1)
      return null;
    if (n === t || t.contains(n))
      return t;
    for (let r of e.trackedShadowRoots.keys())
      if (r.contains(n))
        return r;
    return null;
  }
  function Tu(t) {
    let e = { dirty: true, pending: [], torn: false, dirtyRoots: new Set, retained: null, retainedFrameDriven: false, disposed: false, capturing: false, last: null, inflight: Promise.resolve(), observers: [], trackedShadowRoots: new Map, trackedImages: new Map, images: [], scannedImages: null, scrollNodes: [], controls: [], envEpoch: we(), styleEpoch: ee(), styleStamp: Je(t), outsideMutations: wn(t), geometry: null, renderState: null }, n = () => {
      e.dirty = true, e.dirtyRoots = null;
    }, r = (a) => {
      if (!e.dirtyRoots)
        return;
      let c = a && (a.nodeType === 1 ? a : a.parentElement);
      if (!c || c === t || !t.contains(c) || e.dirtyRoots.size >= 12) {
        e.dirtyRoots = null;
        return;
      }
      e.dirtyRoots.add(c);
    }, i = (a) => {
      if (e.capturing) {
        for (let c of a)
          e.pending.push(c);
        return;
      }
      for (let c of a)
        te(c) && (e.dirty = true, r(c.target));
    }, o = () => {
      if (e.capturing) {
        e.torn = true;
        return;
      }
      n();
    };
    e.dirtyAll = n;
    try {
      let a = new MutationObserver(i);
      a.observe(t, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true }), a.__flush = i, e.observers.push(a);
    } catch {}
    e.markDirty = i, e.onMediaDirty = o;
    try {
      for (let a of pa)
        t.addEventListener(a, o, { capture: true, passive: true });
    } catch {}
    return ko(t, e) || Mo(t, e), Eo(t, e), Ao(t, e), e;
  }
  var $u = 0;
  var fa = new WeakMap;
  function nr(t) {
    let e = fa.get(t);
    return e || (e = "@" + ++$u, fa.set(t, e)), e;
  }
  function _o(t, e) {
    let n = typeof t;
    if (n === "undefined")
      return null;
    if (t === null || n === "boolean" || n === "number" || n === "string")
      return JSON.stringify(t);
    if (n === "function" || n === "symbol")
      return n === "symbol" ? null : JSON.stringify(nr(t));
    if (n !== "object")
      return null;
    if (typeof t.nodeType == "number")
      return JSON.stringify(nr(t));
    if (e.has(t))
      return null;
    e.add(t);
    try {
      if (Array.isArray(t)) {
        let o = [];
        for (let s of t) {
          let a = _o(s, e);
          if (a === null)
            return null;
          o.push(a);
        }
        return "[" + o.join(",") + "]";
      }
      let r = Object.getPrototypeOf(t);
      if (r !== Object.prototype && r !== null)
        return JSON.stringify(nr(t));
      let i = [];
      for (let o of Object.keys(t).sort()) {
        let s = t[o];
        if (s === undefined)
          continue;
        let a = _o(s, e);
        if (a === null)
          return null;
        i.push(JSON.stringify(o) + ":" + a);
      }
      return "{" + i.join(",") + "}";
    } finally {
      e.delete(t);
    }
  }
  function ua(t, e) {
    let { burst: n, invalidate: r, ...i } = t || {};
    try {
      let o = _o(i, new Set);
      return o === null ? null : `${(e || []).map(Ie).join(",")}:${o}`;
    } catch {
      return null;
    }
  }
  function ya(t, e, n, r, i = null) {
    let o = vo.get(t);
    o || (o = Tu(t), o.baselineSignature = ua(e, n.plugins), vo.set(t, o));
    let s = ua(e, n.plugins), a = async () => {
      if (o.disposed)
        return r();
      let f = s === null || s !== o.baselineSignature;
      f && s !== null ? o.pendingSig === s ? (o.baselineSignature = s, o.last = null, o.dirty = true, o.dirtyRoots = null, o.pendingSig = null, f = false) : o.pendingSig = s : o.pendingSig = null, ko(t, o), Ao(t, o);
      for (let A of o.observers)
        A.__flush(A.takeRecords());
      Rt();
      let l = wn(t);
      o.dirty && o.outsideMutations !== l && o.dirtyAll(), o.outsideMutations = l;
      let u = t.getRootNode?.(), p = [...o.trackedShadowRoots.keys()];
      u?.nodeType === 11 && !p.includes(u) && p.push(u), xn(t.ownerDocument || document, p);
      let h = Je(t);
      o.styleStamp !== h && (o.styleStamp = h, o.dirty || o.dirtyAll());
      let d = aa(t, o), m = ca(t, o);
      d.animation = la(m), o.renderState && (!Le(o.renderState, d, "style") && (Se(), o.dirtyAll()), Le(o.renderState, d, "scroll") || o.dirtyAll(), Le(o.renderState, d, "controls") || (ne(t), o.dirtyAll()), !Le(o.renderState, d, "images") && !o.dirty && o.dirtyAll());
      let g = we();
      o.envEpoch !== g && (o.dirtyAll(), o.envEpoch = g);
      let y = ee();
      if (o.styleEpoch !== y && (o.styleEpoch = y, !o.dirty)) {
        let A = ra(t);
        o.geometry !== null && A !== o.geometry && (ne(t), o.dirtyAll()), o.geometry = A;
      }
      n.invalidate && o.dirtyAll();
      let b = false, w = !!o.renderState && !Le(o.renderState, d, "animation");
      try {
        let A = new Set;
        w && m.length === 0 && (A = null);
        for (let v of m) {
          let M = v.playState === "running";
          if (!M && !w)
            continue;
          M && (b = true), w = true;
          let k = v.effect?.target;
          if (Fu(t, o, k) === t)
            A.add(k);
          else {
            A = null;
            break;
          }
        }
        if (w && A && A.size && o.retained) {
          o.dirty = true;
          for (let v of A)
            o.dirtyRoots && o.dirtyRoots.add(v), ne(v);
        } else
          w && !A && o.dirtyAll();
      } catch {}
      let C = d.frameDriven, x = b || C;
      if (x && (o.last = null), C && o.dirtyAll(), !f && !x && !o.dirty && o.last)
        return oa(t, o), o.last;
      o.capturing = true;
      let S = null;
      try {
        let A = null, v = false, M = null;
        if (!f && o.dirty && o.retained && o.dirtyRoots && o.dirtyRoots.size && i) {
          M = [...o.dirtyRoots];
          let k = await na(t, o, n);
          k && (A = await i(k), v = true);
        }
        if (A || (f || (n.__retain = (k) => {
          let R = new Map;
          for (let [E, T] of k.nodeMap.entries())
            R.set(T, E);
          S = { ...k, srcToClone: R };
        }), A = await r()), !f && !o.disposed) {
          o.dirty = false, o.dirtyRoots = new Set, S ? (o.retained = S, o.retainedFrameDriven = sa(S), Mo(t, o), Eo(t, o)) : v && (o.retainedFrameDriven ||= sa(o.retained, M), Mo(t, o), Eo(t, o));
          let k = aa(t, o);
          k.animation = la(ca(t, o));
          let R = ["style", "scroll", "controls", "images"];
          b || R.push("animation");
          let E = R.every((T) => Le(d, k, T));
          o.renderState = k, o.styleEpoch = ee(), o.styleStamp = Je(t), o.geometry = ra(t), o.renderState.frameDriven ? (da.add(t), ha(t, o)) : E ? !x && !o.renderState.frameDriven && (o.last = A, oa(t, o)) : (o.dirtyAll(), o.last = null);
        }
        return A;
      } finally {
        n.__retain = undefined;
        for (let v of o.observers)
          for (let M of v.takeRecords())
            o.pending.push(M);
        Rt();
        let A = wn(t);
        (o.torn || Mu(o.pending) || A !== l) && (o.dirtyAll(), o.last = null), o.outsideMutations = A, o.styleEpoch = ee(), o.styleStamp = Je(t), o.pending.length = 0, o.torn = false, o.capturing = false, o.disposed || (ko(t, o), Ao(t, o));
      }
    }, c = o.inflight.then(a, a);
    return o.inflight = c.catch(() => {}), c;
  }
  var ir = null;
  function Sa(t) {
    ir = t;
  }
  var Pu = 'button, a[href], [role="button"], input, select, summary, label, [tabindex]';
  var Ro = false;
  var cn = null;
  var Fo = new WeakMap;
  var ba = false;
  function xa(t, e) {
    !Ro || !cn || e && e.burst === false || Fo.set(cn.control, { element: t, options: e && typeof e == "object" ? { ...e } : e });
  }
  function va(t) {
    let e = { control: t };
    cn = e, setTimeout(() => {
      cn === e && (cn = null);
    }, 0);
  }
  function $o(t) {
    let e = t.target, n = e && (e.nodeType === 1 ? e : e.parentElement);
    return n && n.closest ? n.closest(Pu) : null;
  }
  function wa(t) {
    if (t.type === "keydown" && t.key !== "Enter" && t.key !== " ")
      return;
    let e = $o(t);
    e && (va(e), To(t, false));
  }
  function Nu(t) {
    let e = $o(t);
    e && va(e);
  }
  function To(t, e = true) {
    if (!ir || document.visibilityState === "hidden")
      return;
    let n = $o(t);
    if (!n || t.type === "pointerenter" && t.target !== n)
      return;
    let r = Fo.get(n);
    if (r) {
      if (!r.element.isConnected) {
        Fo.delete(n);
        return;
      }
      ir(r.element, r.options).catch(() => {});
      return;
    }
    e && !ba && (ba = true, ir(document.body, { clip: "viewport", burst: false }).catch(() => {}));
  }
  function ka() {
    if (Ro || typeof document > "u" || typeof document.addEventListener != "function")
      return;
    Ro = true;
    let t = { capture: true, passive: true };
    document.addEventListener("pointerdown", wa, t), document.addEventListener("keydown", wa, t), document.addEventListener("click", Nu, t), document.addEventListener("pointerenter", To, t), document.addEventListener("focusin", To, t);
  }
  wt();
  function td(...t) {
    return ho(...t), X;
  }
  async function ed(t, e) {
    if (typeof t != "string" || !t.trim())
      throw new Error("[snapdom.fromString] html string required");
    let n = document.createElement("div");
    J(n), n.style.cssText = "position:fixed;left:-99999px;top:0;pointer-events:none;", n.innerHTML = t, document.body.appendChild(n);
    try {
      await pt();
      let r = Array.from(n.childNodes).some((o) => o.nodeType === 3 && o.textContent.trim()), i = n.children.length === 1 && !r ? n.firstElementChild : n;
      return await Ho(i, { ...e || {}, burst: false });
    } finally {
      n.remove();
    }
  }
  var nd = "3.0.0";
  var X = Object.assign(Ho, { plugins: td, fromString: ed, version: nd, preCapture: ka });
  Sa(Ho);
  var Uo = Symbol("snapdom.internal");
  var rd = Symbol("snapdom.internal.silent");
  var La = new Set(["png", "jpeg", "jpg", "webp", "svg"]);
  async function Ho(t, e) {
    if (!t)
      throw new Error("Element cannot be null or undefined");
    let n = ta(e);
    n.element = t, n.invalidate && Se(), zs(n, e && e.plugins);
    let { stage: r, loweredBy: i } = Ds(n);
    n.needs = r, n.__needsLoweredBy = i;
    let o = $e(r, "render"), s = n.burst === true || !Xn(n), a = typeof n.filter == "function" || !!n.excludePredicates || typeof n.excludeStyleProps == "function" || typeof n.fallbackURL == "function", f = o && !n.captureSelection && n.burst !== false && s && !a && ma(t);
    return f && xa(t, e), n.snap || (n.snap = { toPng: (l, u) => X.toPng(l, u), toSvg: (l, u) => X.toSvg(l, u) }), f ? ya(t, e, n, () => X.capture(t, n, Uo), (l) => Ia(l, n)) : X.capture(t, n, Uo);
  }
  X.capture = async (t, e, n) => {
    if (n !== Uo)
      throw new Error("[snapdom.capture] is internal. Use snapdom(...) instead.");
    if ($e(e.needs || ft, "render") && Y()) {
      if (e.embedFonts)
        try {
          let o = t.ownerDocument || document, s = new Set;
          if (e.embedFonts === "auto") {
            try {
              for (let l of o.fonts)
                s.add(String(l.family).replace(/["']/g, "").toLowerCase());
            } catch {}
            if (s.size === 0)
              throw null;
          }
          let a = Pn(t);
          e.clip || (e.__fontUsage = a);
          let c = a.required, f = new Set([...c].map((l) => String(l).split("__")[0]).filter(Boolean));
          if (e.embedFonts === "auto" && (f = new Set([...f].filter((l) => s.has(l.toLowerCase()))), f.size === 0))
            throw null;
          await Nn(f, 1, o);
        } catch {}
      let i = Array.from(t.querySelectorAll("canvas"));
      t.tagName === "CANVAS" && i.unshift(t);
      for (let o of i)
        try {
          if (nn(o))
            continue;
          let s = o.getContext("2d", { willReadFrequently: true });
          s && s.getImageData(0, 0, 1, 1);
        } catch (s) {
          D(e, "safari canvas poke failed", s);
        }
    }
    let r = await Zs(t, e);
    return Ia(r, e);
  };
  async function Ia(t, e) {
    let n = e.needs || ft, r = $e(n, "render"), i = (_) => Us(n, e.__needsLoweredBy || [], _), o = typeof HTMLCanvasElement < "u" && t instanceof HTMLCanvasElement ? t : null, s = o ? null : t, a = () => s ??= o.toDataURL(), c = o || t;
    o && (t = "");
    let { __compressedSnapshot: f, __compressionDensity: l } = e;
    delete e.__compressedSnapshot, delete e.__compressedAssets;
    let u, p = e.meta || {}, d = (Number.isFinite(e.width) || Number.isFinite(e.height)) && !Y(), m = d ? Number.isFinite(e.width) ? p.targetW / p.vbW : p.targetH / p.vbH : 1, g = d ? Number.isFinite(e.height) ? p.targetH / p.vbH : p.targetW / p.vbW : 1, y = (_) => {
      if (o || !f?.size)
        return c;
      let { vbW: L, vbH: $ } = p, F = _.crop;
      F && (L = Math.max(1, Math.min(L, F.x + F.width) - Math.max(0, F.x)), $ = Math.max(1, Math.min($, F.y + F.height) - Math.max(0, F.y)));
      let V = Number.isFinite(_.width), z = Number.isFinite(_.height);
      return (V && z ? Math.max(_.width / L, _.height / $) : V ? _.width / L * (F ? Math.max(1, g / m) : 1) : z ? _.height / $ * (F ? Math.max(1, m / g) : 1) : (_.scale || 1) * Math.max(m, g)) * (_.dpr || 1) <= l ? c : u ??= Ys(a(), f);
    }, b = async (_, L) => {
      let { rasterize: $ } = await Promise.resolve().then(() => (De(), un));
      return $(c, { ..._, ...L || {}, format: "png" });
    }, w = () => {
      if (!r)
        throw i("svgString");
      if (o)
        throw new Error("[snapdom] svgString: engine:'html-in-canvas' produces a raster capture; there is no serialized SVG");
      let _ = t.indexOf(",");
      return _ >= 0 ? decodeURIComponent(t.slice(_ + 1)) : "";
    }, C = (_) => Object.defineProperty({ ..._ || {}, svgString: w }, "url", r ? { get: a, enumerable: true } : { get() {
      throw i("export.url");
    }, enumerable: false, configurable: true }), x = { img: async (_, L) => {
      if (o)
        return b(_, L);
      let { toImg: $ } = await Promise.resolve().then(() => (Oo(), Wo)), F = { ..._, ...L || {} };
      return $(y(F), F);
    }, svg: async (_, L) => {
      if (o)
        return b(_, L);
      let { toSvg: $ } = await Promise.resolve().then(() => (Oo(), Wo)), F = { ..._, ...L || {} };
      return $(y(F), F);
    }, canvas: async (_, L) => {
      let { toCanvas: $ } = await Promise.resolve().then(() => (Oe(), Fa)), F = { ..._, ...L || {} };
      return $(y(F), F);
    }, blob: async (_, L) => {
      let { toBlob: $ } = await Promise.resolve().then(() => (Bo(), Ta)), F = { ..._, ...L || {} };
      return $(y(F), F);
    }, png: async (_, L) => {
      let { rasterize: $ } = await Promise.resolve().then(() => (De(), un)), F = { ..._, ...L || {}, format: "png" };
      return $(y(F), F);
    }, jpeg: async (_, L) => {
      let { rasterize: $ } = await Promise.resolve().then(() => (De(), un)), F = { ..._, ...L || {}, format: "jpeg" };
      return $(y(F), F);
    }, webp: async (_, L) => {
      let { rasterize: $ } = await Promise.resolve().then(() => (De(), un)), F = { ..._, ...L || {}, format: "webp" };
      return $(y(F), F);
    }, download: async (_, L) => {
      let { download: $ } = await Promise.resolve().then(() => (Na(), Pa)), F = { ..._, ...L || {} };
      return $(y(F), F);
    } };
    if (!r)
      for (let _ of Object.keys(x)) {
        let L = _ === "download" ? "download()" : `to${_.charAt(0).toUpperCase()}${_.slice(1)}()`;
        x[_] = async () => {
          throw i(L);
        };
      }
    let S = {};
    for (let _ of ["img", "svg", "canvas", "blob", "png", "jpeg", "webp"])
      S[_] = async (L) => x[_](e, { ...E(_, L || {}), [rd]: true });
    S.jpg = S.jpeg;
    let A = (_) => Object.defineProperty({ ...e, ..._ }, "options", { value: e, configurable: true }), v = A({ artifacts: e.__artifacts || null, export: C(), exports: S }), M = await Gn("defineExports", v), k = Object.assign({}, ...M.filter((_) => _ && typeof _ == "object").reverse()), R = { ...x, ...k };
    R.jpeg && !R.jpg && (R.jpg = (_, L) => R.jpeg(_, L));
    function E(_, L) {
      let $ = L || {}, F = { ...e, ...$ }, V = typeof $.type == "string" ? $.type.toLowerCase() : "", z = typeof $.format == "string" ? $.format.toLowerCase() : La.has(V) ? V : "";
      z && (F.format = z === "jpg" ? "jpeg" : z), F.__explicitFormat = z ? F.format : e.__explicitFormat ?? null, _ === "blob" && !F.__explicitFormat && (F.format = o ? "png" : "svg"), F.type = F.format;
      let q = (Z) => Z === "jpeg" || Z === "jpg" || Z === "webp";
      return [_, F.format, V].map((Z) => typeof Z == "string" ? Z.toLowerCase() : "").find(q) && (F.backgroundColor == null || F.backgroundColor === "transparent") && (F.backgroundColor = "#ffffff"), F.scale !== 1 && (Number.isFinite(F.width) || Number.isFinite(F.height)) && D(F, "width/height define the output size — scale is ignored when either is set"), F;
    }
    let T = false, N = Promise.resolve();
    async function O(_, L) {
      let $ = Object.freeze(L && typeof L == "object" ? { ...L } : {}), F = async () => {
        let z = R[_];
        if (!z)
          throw new Error(`[snapdom] Unknown export type: ${_}`);
        let q = E(_, $), B = A({ artifacts: e.__artifacts || null, export: C({ type: _, options: q, requestedOptions: $ }) }), Z = q.format, Mt = q.type;
        await Gn("beforeExport", B, { format: _, options: q });
        let Lt = q.format !== Z ? q.format : q.type !== Mt ? q.type : "", gt = typeof Lt == "string" ? Lt.toLowerCase() : "";
        La.has(gt) && (q.format = gt === "jpg" ? "jpeg" : gt, q.type = q.format, q.__explicitFormat = q.format, /^(?:jpeg|webp)$/.test(q.format) && (q.backgroundColor == null || q.backgroundColor === "transparent") && (q.backgroundColor = "#ffffff"));
        let st = await z(B, q);
        return await Gn("afterExport", B, { format: _, options: q, result: st }), T || (T = true, await Nt("afterSnap", e)), st;
      }, V = N.then(F);
      return N = V.catch(() => {}), V;
    }
    let H = { url: t, needs: n, warnings: e.__session && e.__session.warnings || [], toRaw: () => {
      if (!r)
        throw i("toRaw()");
      return a();
    }, to: (_, L) => O(_, L), toImg: (_) => O("img", _), toSvg: (_) => O("svg", _), toCanvas: (_) => O("canvas", _), toBlob: (_) => O("blob", _), toPng: (_) => O("png", _), toJpg: (_) => O("jpg", _), toWebp: (_) => O("webp", _), download: (_) => O("download", _) };
    r ? o && Object.defineProperty(H, "url", { get: a, enumerable: true, configurable: true }) : Object.defineProperty(H, "url", { get() {
      throw i("url");
    }, enumerable: false, configurable: true }), Object.defineProperty(H, "meta", r ? { value: e.meta, enumerable: true } : { get() {
      throw i("meta");
    }, enumerable: false, configurable: true });
    for (let _ of Object.keys(R)) {
      let L = "to" + _.charAt(0).toUpperCase() + _.slice(1);
      H[L] || (H[L] = ($) => O(_, $));
    }
    return H;
  }
  X.toRaw = (t, e) => X(t, e).then((n) => n.toRaw());
  X.toImg = (t, e) => X(t, e).then((n) => n.toImg());
  X.toSvg = (t, e) => X(t, e).then((n) => n.toSvg());
  X.toCanvas = (t, e) => X(t, e).then((n) => n.toCanvas());
  X.toBlob = (t, e) => X(t, e).then((n) => n.toBlob());
  X.toPng = (t, e) => X(t, { ...e, format: "png" }).then((n) => n.toPng());
  X.toJpg = (t, e) => X(t, { ...e, format: "jpeg" }).then((n) => n.toJpg());
  X.toWebp = (t, e) => X(t, { ...e, format: "webp" }).then((n) => n.toWebp());
  X.download = (t, e) => X(t, e).then((n) => n.download());

  // ../../packages/browser-visual/src/store.ts
  class RemoteVisualStoreError extends Error {
    code;
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "RemoteVisualStoreError";
    }
  }

  class RemoteVisualArtifactStore {
    capability;
    maxChunkBytes;
    rpc;
    lastCommittedResult = null;
    sequence = 0;
    constructor(capability, maxChunkBytes, rpc) {
      this.capability = capability;
      this.maxChunkBytes = maxChunkBytes;
      this.rpc = rpc;
      if (!capability)
        throw new TypeError("Visual store requires a capability");
      if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1)
        throw new TypeError("Visual store maxChunkBytes must be positive");
    }
    async readBaseline(name) {
      const opened = await this.call("baseline_read_open", { name });
      if (!opened)
        return null;
      const chunkBytes = Math.min(this.maxChunkBytes, opened.maxChunkBytes ?? this.maxChunkBytes);
      const image = new Uint8Array(opened.byteLength);
      let offset = 0;
      let closeAttempted = false;
      try {
        while (offset < image.byteLength) {
          const length = Math.min(chunkBytes, image.byteLength - offset);
          const value = await this.call("baseline_read_chunk", { readId: opened.readId, offset, length });
          const bytes = toRpcBytes(value);
          if (bytes.byteLength === 0 && length > 0)
            throw new RemoteVisualStoreError("VISUAL_SHORT_READ", "Visual baseline read ended early");
          image.set(bytes, offset);
          offset += bytes.byteLength;
        }
        closeAttempted = true;
        await this.call("baseline_read_close", { readId: opened.readId });
        return { name, image: new Blob([image], { type: "image/png" }), meta: opened.meta };
      } finally {
        if (!closeAttempted)
          await this.call("baseline_read_close", { readId: opened.readId }).catch(() => {
            return;
          });
      }
    }
    async writeBaseline(name, baseline) {
      const source = binarySource(baseline.image);
      const begin = await this.call("baseline_write_begin", {
        name,
        meta: baseline.meta,
        totalBytes: source.byteLength
      });
      await this.streamWrite(begin.writeId, source, begin.maxChunkBytes);
    }
    async writeRunArtifact(runId, filename, data) {
      const source = artifactSource(data);
      const begin = await this.call("run_write_begin", {
        runId,
        filename,
        totalBytes: source.byteLength
      });
      await this.streamWrite(begin.writeId, source, begin.maxChunkBytes);
    }
    async commitResult(runId, result) {
      this.lastCommittedResult = await this.call("result_commit", { runId, result });
    }
    async streamWrite(writeId, source, remoteMax) {
      const chunkBytes = Math.min(this.maxChunkBytes, remoteMax ?? this.maxChunkBytes);
      let offset = 0;
      try {
        while (offset < source.byteLength) {
          const length = Math.min(chunkBytes, source.byteLength - offset);
          const bytes = await source.slice(offset, offset + length);
          const result = await this.call("write_chunk", { writeId, offset, bytes });
          const next = result.offset;
          if (next !== offset + bytes.byteLength) {
            throw new RemoteVisualStoreError("VISUAL_OFFSET_MISMATCH", `Host acknowledged offset ${String(next)}; expected ${offset + bytes.byteLength}`);
          }
          offset = next;
        }
        await this.call("write_commit", { writeId });
      } catch (error) {
        await this.call("write_abort", { writeId }).catch(() => {
          return;
        });
        throw error;
      }
    }
    async call(method, payload) {
      const id = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
      const response = await this.rpc({ id, capability: this.capability, method, payload });
      if (!response.ok)
        throw new RemoteVisualStoreError(response.error.code, response.error.message);
      if (response.id !== id)
        throw new RemoteVisualStoreError("VISUAL_RPC_MISMATCH", `Visual RPC response id ${response.id} does not match ${id}`);
      return response.result;
    }
  }
  var binarySource = (value) => {
    if (value instanceof Blob)
      return blobSource(value);
    if (value instanceof Uint8Array)
      return uint8Source(value);
    if (value instanceof ArrayBuffer)
      return uint8Source(new Uint8Array(value));
    throw new TypeError("Unsupported SnapEye baseline image type");
  };
  var artifactSource = (value) => {
    if (typeof value === "string")
      return blobSource(new Blob([value], { type: "text/plain;charset=utf-8" }));
    return binarySource(value);
  };
  var blobSource = (blob) => ({
    byteLength: blob.size,
    slice: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer())
  });
  var uint8Source = (bytes) => ({
    byteLength: bytes.byteLength,
    slice: async (start, end) => bytes.subarray(start, end)
  });
  var toRpcBytes = (value) => {
    if (value instanceof Uint8Array)
      return value;
    if (value instanceof ArrayBuffer)
      return new Uint8Array(value);
    if (value && typeof value === "object" && "bytes" in value && typeof value.bytes === "string") {
      const encoded = value.bytes;
      const ctor = Uint8Array;
      if (typeof ctor.fromBase64 === "function")
        return ctor.fromBase64(encoded);
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0;index < binary.length; index++)
        bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    throw new RemoteVisualStoreError("VISUAL_INVALID_BYTES", "Visual RPC returned an invalid byte chunk");
  };

  // ../../packages/browser-visual/src/runtime.ts
  var runVisualOperation = async (input) => {
    throwIfAborted(input.signal);
    const rpc = async (request) => {
      throwIfAborted(input.signal);
      const response = await abortable(input.rpc(request), input.signal);
      throwIfAborted(input.signal);
      return response;
    };
    const store = new RemoteVisualArtifactStore(input.capability, input.maxChunkBytes, rpc);
    const wait2 = (milliseconds) => input.wait ? abortable(input.wait(Math.max(0, milliseconds)), input.signal) : abortableWait(milliseconds, input.signal);
    const timingWindow = input.preferWaitForFrames ? waitDrivenWindow() : undefined;
    const api = attachSnapEye({
      snapdom: X,
      store,
      ...timingWindow ? { window: timingWindow, document: globalThis.document } : {},
      reuse: false,
      autoOnQuery: false,
      forwardConsole: false,
      errorOverlay: false,
      hotkey: false,
      wait: wait2,
      encodeGif: encodeGifFrames,
      stabilize: true,
      settle: true,
      svg: true,
      hideSelectors: ["[data-opencode-overlay]", "[data-openfork-annotation-ui]"]
    });
    const options = withRedaction({ ...input.options ?? {}, runId: input.runId }, input.redaction);
    try {
      throwIfAborted(input.signal);
      let result;
      try {
        result = input.operation === "capture" ? await api.capture(input.name, input.target, options) : input.operation === "diff" ? await api.diff(input.name, input.target, options) : await api.record(input.name, input.target, options);
      } catch (error) {
        throwIfAborted(input.signal);
        throw error;
      }
      throwIfAborted(input.signal);
      return store.lastCommittedResult ?? result;
    } finally {
      api.destroy();
    }
  };
  var waitDrivenWindow = () => {
    const target = globalThis.window;
    if (!target)
      throw new Error("Visual timing facade requires a browser Window");
    const bindToWindow = new Set([
      "addEventListener",
      "removeEventListener",
      "setTimeout",
      "clearTimeout",
      "fetch",
      "createImageBitmap"
    ]);
    return new Proxy(target, {
      get(windowTarget, property) {
        if (property === "requestAnimationFrame" || property === "cancelAnimationFrame")
          return;
        const value = Reflect.get(windowTarget, property, windowTarget);
        return typeof value === "function" && bindToWindow.has(property) ? value.bind(windowTarget) : value;
      },
      set(windowTarget, property, value) {
        return Reflect.set(windowTarget, property, value, windowTarget);
      },
      deleteProperty(windowTarget, property) {
        return Reflect.deleteProperty(windowTarget, property);
      }
    });
  };
  var abortError = () => new DOMException("Visual operation aborted", "AbortError");
  var throwIfAborted = (signal) => {
    if (signal?.aborted)
      throw abortError();
  };
  var abortable = (promise, signal) => {
    if (!signal)
      return promise;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn2) => {
        if (settled)
          return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        fn2();
      };
      const onAbort = () => finish(() => reject(abortError()));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
  };
  var abortableWait = (milliseconds, signal) => {
    if (!signal)
      return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(resolve), Math.max(0, milliseconds));
      const finish = (fn2) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fn2();
      };
      const onAbort = () => finish(() => reject(abortError()));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  var withRedaction = (options, policy) => {
    const blocks = [...policy?.blocks ?? []];
    const attributes = [...policy?.attributes ?? []];
    if (blocks.length === 0 && attributes.length === 0)
      return options;
    const current = options.snapdomOptions ?? {};
    const existingExclude = current.exclude === undefined ? [] : Array.isArray(current.exclude) ? current.exclude : [current.exclude];
    const existingPlugins = current.plugins === undefined ? [] : Array.isArray(current.plugins) ? current.plugins : [current.plugins];
    const redactionPlugin = attributes.length > 0 ? {
      name: "opencode-redact-attributes-v1",
      pure: true,
      afterClone(context) {
        const clone = context.clone;
        if (!clone)
          return;
        for (const rule of attributes) {
          const matches = [];
          if (clone.matches(rule.selector))
            matches.push(clone);
          matches.push(...clone.querySelectorAll(rule.selector));
          for (const element of matches) {
            for (const name of rule.names) {
              element.removeAttribute(name);
              if (name === "value" && "value" in element) {
                try {
                  element.value = "";
                } catch {}
                if (element.tagName === "TEXTAREA")
                  element.textContent = "";
              }
              if (name === "srcdoc" && element instanceof HTMLIFrameElement) {
                try {
                  element.srcdoc = "";
                } catch {}
              }
            }
          }
        }
      }
    } : undefined;
    return {
      ...options,
      snapdomOptions: {
        ...current,
        ...blocks.length > 0 ? { exclude: [...existingExclude, ...blocks], excludeMode: "hide" } : {},
        ...redactionPlugin ? { plugins: [...existingPlugins, redactionPlugin] } : {}
      }
    };
  };
  // src/content/visual.ts
  var INSTALL_KEY = "__opencodeVisualRuntimeV1";
  var scope = globalThis;
  var activeRuns = new Map;
  var HUMAN_INTERRUPT_EVENTS = ["pointerdown", "keydown", "wheel", "beforeinput"];
  var interruptForTrustedInput = (event) => {
    if (!event.isTrusted || activeRuns.size === 0)
      return;
    for (const controller of activeRuns.values())
      controller.abort();
  };
  var setHumanInterruptMonitoring = (enabled) => {
    for (const type of HUMAN_INTERRUPT_EVENTS) {
      if (enabled)
        document.addEventListener(type, interruptForTrustedInput, { capture: true, passive: true });
      else
        document.removeEventListener(type, interruptForTrustedInput, true);
    }
  };
  if (!scope[INSTALL_KEY]) {
    scope[INSTALL_KEY] = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object")
        return;
      if (message.type === "opencode:visual-ready") {
        sendResponse({ ready: true, version: 1 });
        return false;
      }
      if (message.type === "opencode:visual-abort" && typeof message.requestId === "string") {
        const controller = activeRuns.get(message.requestId);
        controller?.abort();
        sendResponse({ ok: true, aborted: !!controller });
        return false;
      }
      if (message.type !== "opencode:visual-run")
        return;
      execute(message.command).then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({
        ok: false,
        aborted: error instanceof DOMException && error.name === "AbortError",
        error: error instanceof Error ? error.message : String(error)
      }));
      return true;
    });
  }
  async function execute(command) {
    if (!command || typeof command !== "object")
      throw new Error("Invalid visual command");
    if (command.operation !== "capture" && command.operation !== "diff" && command.operation !== "record")
      throw new Error("Unsupported visual operation");
    if (typeof command.name !== "string" || typeof command.runId !== "string" || typeof command.capability !== "string") {
      throw new Error("Visual command is missing identity fields");
    }
    if (typeof command.requestId !== "string")
      throw new Error("Visual command is missing requestId");
    if (!Number.isSafeInteger(command.maxChunkBytes) || command.maxChunkBytes < 1)
      throw new Error("Invalid visual chunk size");
    const controller = new AbortController;
    activeRuns.set(command.requestId, controller);
    if (activeRuns.size === 1)
      setHumanInterruptMonitoring(true);
    const rpc = async (request) => {
      if (controller.signal.aborted)
        return abortedRpc(request.id);
      const wireRequest = request.method === "write_chunk" && request.payload?.bytes instanceof Uint8Array ? {
        ...request,
        payload: {
          ...request.payload,
          bytes: bytesToBase64(request.payload.bytes)
        }
      } : request;
      const response = await chrome.runtime.sendMessage({ type: "opencode:visual-rpc", request: wireRequest });
      if (controller.signal.aborted)
        return abortedRpc(request.id);
      if (!response || typeof response !== "object") {
        return { ok: false, id: request.id, error: { code: "VISUAL_HOST_UNAVAILABLE", message: "Visual RPC returned no response" } };
      }
      return response;
    };
    try {
      const result = await runVisualOperation({
        operation: command.operation,
        name: command.name,
        runId: command.runId,
        capability: command.capability,
        maxChunkBytes: command.maxChunkBytes,
        rpc,
        signal: controller.signal,
        wait: (milliseconds) => extensionWait(command.requestId, milliseconds),
        preferWaitForFrames: true,
        target: typeof command.target === "string" ? command.target : undefined,
        redaction: command.redaction && typeof command.redaction === "object" ? command.redaction : undefined,
        options: command.options && typeof command.options === "object" ? command.options : undefined
      });
      if (controller.signal.aborted)
        throw new DOMException("Visual operation aborted", "AbortError");
      return result;
    } finally {
      if (activeRuns.get(command.requestId) === controller)
        activeRuns.delete(command.requestId);
      if (activeRuns.size === 0)
        setHumanInterruptMonitoring(false);
    }
  }
  async function extensionWait(requestId, milliseconds) {
    let remaining = Math.max(0, Number(milliseconds) || 0);
    if (remaining === 0)
      return;
    while (remaining > 0) {
      const durationMs = Math.min(1000, remaining);
      const response = await chrome.runtime.sendMessage({
        type: "opencode:visual-wait",
        requestId,
        durationMs
      });
      if (!response?.ok)
        throw new Error(response?.error ?? "Visual frame clock unavailable");
      remaining -= durationMs;
    }
  }
  function abortedRpc(id) {
    return { ok: false, id, error: { code: "VISUAL_ABORTED", message: "Visual operation aborted" } };
  }
  function bytesToBase64(bytes) {
    if (typeof bytes.toBase64 === "function")
      return bytes.toBase64();
    const BLOCK = 32768;
    let binary = "";
    for (let offset = 0;offset < bytes.byteLength; offset += BLOCK) {
      const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + BLOCK));
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  }
})();
