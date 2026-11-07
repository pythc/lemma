// A pixel/geometry diagnostic, never a certificate that extracted glyphs match
// the visible text. Overlapping unrelated ink can fool a bounding-box check.
export function legacyTextVisibility(items, styles, viewport, pixels) {
  const [a, b, c, d, e, f] = viewport.transform;
  return items
    .filter((i) => i.text.trim())
    .map((item) => {
      const [u, v, w, z, x, y] = item.transform;
      const tx = a * x + c * y + e,
        ty = b * x + d * y + f;
      const dx = a * u + c * v,
        dy = b * u + d * v,
        length = Math.hypot(dx, dy) || 1;
      const vx = a * w + c * z,
        vy = b * w + d * z;
      const ascent = styles[item.fontName]?.ascent ?? 0.85;
      const descent = styles[item.fontName]?.descent ?? -0.25;
      const width = item.width * viewport.scale;
      const corners = [ascent, descent].flatMap((h) =>
        [0, width].map((t) => [
          tx + (dx / length) * t + vx * h,
          ty + (dy / length) * t + vy * h,
        ]),
      );
      const box = [
        Math.floor(Math.min(...corners.map((p) => p[0]))),
        Math.floor(Math.min(...corners.map((p) => p[1]))),
        Math.ceil(Math.max(...corners.map((p) => p[0]))),
        Math.ceil(Math.max(...corners.map((p) => p[1]))),
      ];
      const clipped =
        box[0] < 0 ||
        box[1] < 0 ||
        box[2] > pixels.width ||
        box[3] > pixels.height;
      const sample = [
        Math.max(0, box[0]),
        Math.max(0, box[1]),
        Math.min(pixels.width, box[2]),
        Math.min(pixels.height, box[3]),
      ];
      let min = 255,
        max = 0,
        count = 0;
      for (let y = sample[1]; y < sample[3]; y++)
        for (let x = sample[0]; x < sample[2]; x++) {
          const at = (y * pixels.width + x) * 4,
            value =
              (pixels.data[at] + pixels.data[at + 1] + pixels.data[at + 2]) / 3;
          min = Math.min(min, value);
          max = Math.max(max, value);
          count++;
        }
      const flags = [];
      if (clipped || !count) flags.push("text_outside_or_clipped_page");
      if (Math.hypot(w, z) < 3) flags.push("text_abnormally_small");
      if (count && max - min < 10) flags.push("text_visibility_unresolved");
      return {
        itemIndex: item.index,
        box,
        coordinateSpace: "rendered_page_pixels",
        sampledPixels: count,
        luminanceRange: count ? Math.round(max - min) : null,
        flags,
        status: flags.length
          ? "unresolved"
          : "ink_present_not_glyph_identity_verified",
      };
    });
}

// Version 2 diagnoses missing geometry rather than inventing a bounding box.
// A page-wide sample cap also bounds overlapping/oversized text rectangles.
export function textVisibility(items, styles, viewport, pixels) {
  const finite = (a, n) =>
    Array.isArray(a) && a.length === n && a.every(Number.isFinite);
  let remaining = 12_000_000;
  return items
    .filter((i) => i.text.trim())
    .map((item) => {
      const unresolved = (reason, box = null) => ({
        itemIndex: item.index,
        box,
        coordinateSpace: "rendered_page_pixels",
        sampledPixels: 0,
        luminanceRange: null,
        flags: [reason],
        status: "unresolved",
      });
      if (
        !finite(viewport.transform, 6) ||
        !Number.isFinite(viewport.scale) ||
        viewport.scale <= 0
      )
        return unresolved("viewport_geometry_unresolved");
      if (
        !finite(item.transform, 6) ||
        !Number.isFinite(item.width) ||
        !Number.isFinite(item.height) ||
        item.width < 0
      )
        return unresolved("text_geometry_unresolved");
      const style = styles[item.fontName];
      if (!Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent))
        return unresolved("font_metrics_unresolved");
      const [a, b, c, d, e, f] = viewport.transform,
        [u, v, w, z, x, y] = item.transform;
      const dx = a * u + c * v,
        dy = b * u + d * v,
        length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length === 0)
        return unresolved("text_geometry_unresolved");
      const tx = a * x + c * y + e,
        ty = b * x + d * y + f,
        vx = a * w + c * z,
        vy = b * w + d * z;
      const corners = [style.ascent, style.descent].flatMap((h) =>
        [0, item.width * viewport.scale].map((t) => [
          tx + (dx / length) * t + vx * h,
          ty + (dy / length) * t + vy * h,
        ]),
      );
      if (corners.some((p) => !p.every(Number.isFinite)))
        return unresolved("text_geometry_unresolved");
      const box = [
        Math.floor(Math.min(...corners.map((p) => p[0]))),
        Math.floor(Math.min(...corners.map((p) => p[1]))),
        Math.ceil(Math.max(...corners.map((p) => p[0]))),
        Math.ceil(Math.max(...corners.map((p) => p[1]))),
      ];
      if (!box.every(Number.isSafeInteger))
        return unresolved("text_geometry_unresolved");
      const sample = [
        Math.max(0, box[0]),
        Math.max(0, box[1]),
        Math.min(pixels.width, box[2]),
        Math.min(pixels.height, box[3]),
      ];
      const area =
        Math.max(0, sample[2] - sample[0]) * Math.max(0, sample[3] - sample[1]);
      if (area > 1_000_000 || area > remaining)
        return unresolved("visibility_sample_budget_exceeded", box);
      remaining -= area;
      // The legacy sampler is safe only after the finite/area checks above.
      return legacyTextVisibility([item], styles, viewport, pixels)[0];
    });
}

export function geometryDiagnosticValue(value) {
  if (typeof value === "number" && !Number.isFinite(value))
    return { kind: "non_finite_number", value: String(value) };
  if (Array.isArray(value)) return value.map(geometryDiagnosticValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, geometryDiagnosticValue(v)]),
    );
  return value;
}
