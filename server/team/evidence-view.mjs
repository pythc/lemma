// Bounded presentation, not bounded evidence. Every omitted value has an exact
// path and continuation offset into the immutable artifact.
export function evidenceView(
  value,
  artifactId,
  basePath = [],
  maxCharacters = 64000,
) {
  const { pageImage, ...withoutImage } =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const payload = pageImage ? withoutImage : value;
  if ((JSON.stringify(payload) || "null").length <= maxCharacters) return value;
  let remaining = Math.floor(maxCharacters / 2),
    nodes = 0;
  const omitted = [];
  const trim = (x, at, depth = 0) => {
    if (++nodes > 256 || remaining < 256 || depth > 12) {
      omitted.push({
        path: at,
        nextOffset: 0,
        type: Array.isArray(x) ? "array" : typeof x,
      });
      return null;
    }
    remaining -= 64;

    if (typeof x === "string" && x.length > Math.min(2000, remaining)) {
      omitted.push({
        path: at,
        total: x.length,
        nextOffset: Math.min(2000, remaining),
        type: "string",
      });
      const part = x.slice(0, Math.min(2000, remaining));
      remaining -= part.length;
      return part;
    }
    if (Array.isArray(x)) {
      const limit = depth > 4 ? 3 : 12;
      if (x.length > limit)
        omitted.push({
          path: at,
          total: x.length,
          nextOffset: limit,
          type: "array",
        });
      return x
        .slice(0, limit)
        .map((v, i) => trim(v, [...at, String(i)], depth + 1));
    }
    if (x && typeof x === "object") {
      const entries = Object.entries(x);
      if (entries.length > 24)
        omitted.push({
          path: at,
          total: entries.length,
          nextOffset: 24,
          type: "object",
        });
      return Object.fromEntries(
        entries
          .slice(0, 24)
          .map(([k, v]) => [k, trim(v, [...at, k], depth + 1)]),
      );
    }
    if (typeof x === "string") remaining -= x.length;
    return x;
  };
  const preview = trim(payload, basePath);
  const projected = {
    ...(preview && typeof preview === "object" && !Array.isArray(preview)
      ? preview
      : { preview }),
    ...(pageImage ? { pageImage } : {}),
    _view: {
      complete: false,
      artifactId,
      omitted,
      instruction:
        "This is a preview, not the whole evidence. read_evidence with artifactId, path, offset, limit retrieves exact saved content. No evidence has been deleted or shortened on disk.",
    },
  };
  // Path metadata can also grow for wide/deep objects. Fall back to an exact
  // paginated handle, never an unmarked or silently truncated source.
  if (
    JSON.stringify({ ...projected, pageImage: undefined }).length >
    maxCharacters
  )
    return {
      ...(pageImage ? { pageImage } : {}),
      _view: {
        complete: false,
        artifactId,
        omitted: [
          {
            path: basePath,
            nextOffset: 0,
            type: Array.isArray(payload) ? "array" : typeof payload,
          },
        ],
        instruction:
          "Use read_evidence with this artifactId, path, offset and limit for the exact saved content.",
      },
    };
  return projected;
}
export function selectEvidence(artifact, args = {}) {
  if (
    args.path !== undefined &&
    (!Array.isArray(args.path) || args.path.some((k) => typeof k !== "string"))
  )
    throw Error("Evidence path must be an array of string keys");
  for (const key of ["offset", "limit"])
    if (
      args[key] !== undefined &&
      (!Number.isSafeInteger(args[key]) ||
        args[key] < (key === "limit" ? 1 : 0))
    )
      throw Error(
        `Evidence ${key} must be a ${key === "limit" ? "positive" : "nonnegative"} integer`,
      );
  let value = artifact;
  const selectedPath = args.path || [];
  const parentPath = [];
  for (const key of selectedPath) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw Object.assign(
        Error("Evidence path not found; use the returned parent navigation."),
        {
          navigation: {
            tool: "read_evidence",
            arguments: {
              artifactId: artifact.id,
              path: parentPath,
              offset: 0,
              limit: 20,
            },
            availableKeys:
              value && typeof value === "object"
                ? Object.keys(value).slice(0, 40)
                : [],
            valueType: typeof value,
          },
        },
      );
    value = value[key];
    parentPath.push(key);
  }
  if (args.offset !== undefined || args.limit !== undefined) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value),
        offset = args.offset || 0,
        limit = Math.min(100, Math.max(1, args.limit || 20));
      return {
        artifactId: artifact.id,
        path: selectedPath,
        type: "object",
        total: keys.length,
        offset,
        nextOffset: offset + limit < keys.length ? offset + limit : null,
        entries: keys.slice(offset, offset + limit).map((key) => ({
          key,
          read: {
            tool: "read_evidence",
            arguments: {
              artifactId: artifact.id,
              path: [...selectedPath, key],
            },
          },
          value: evidenceView(
            value[key],
            artifact.id,
            [...selectedPath, key],
            Math.max(512, Math.floor(32000 / limit)),
          ),
        })),
      };
    }
    if (!Array.isArray(value) && typeof value !== "string")
      return {
        artifactId: artifact.id,
        path: selectedPath,
        total: 1,
        value,
        nextOffset: null,
      };
    const offset = args.offset || 0,
      limit = Math.min(
        typeof value === "string" ? 64000 : 100,
        Math.max(1, args.limit || 100),
      );
    return {
      artifactId: artifact.id,
      path: selectedPath,
      total: value.length,
      offset,
      nextOffset: offset + limit < value.length ? offset + limit : null,
      value:
        typeof value === "string"
          ? value.slice(offset, offset + limit)
          : value
              .slice(offset, offset + limit)
              .map((entry, i) =>
                evidenceView(
                  entry,
                  artifact.id,
                  [...selectedPath, String(offset + i)],
                  Math.max(512, Math.floor(32000 / limit)),
                ),
              ),
    };
  }
  return evidenceView(value, artifact.id, selectedPath);
}
