import { parseTree, createScanner, SyntaxKind } from "jsonc-parser";

// Use a lossless syntax tree, never the parser's fault-tolerant object result.
// Decoded property names make escaped aliases collide at every nesting level.
export function jsonSyntaxTree(text, { limits } = {}) {
  if (typeof text !== "string") throw Error("JSON input must be a string");
  if (limits) {
    const scanner = createScanner(text, true),
      collections = [];
    let tokens = 0,
      token;
    while ((token = scanner.scan()) !== SyntaxKind.EOF) {
      if (++tokens > limits.nodes * 2)
        throw Object.assign(
          Error("Received JSON exceeds the structured-response token limit"),
          { code: "model_response_structure_limit" },
        );
      if (
        token === SyntaxKind.OpenBraceToken ||
        token === SyntaxKind.OpenBracketToken
      )
        collections.push(0);
      if (token === SyntaxKind.CommaToken && collections.length)
        collections[collections.length - 1]++;
      if (
        collections.length > limits.depth ||
        (collections.at(-1) || 0) >= limits.collection
      )
        throw Object.assign(
          Error(
            "Received JSON exceeds the structured-response collection/depth limit",
          ),
          { code: "model_response_structure_limit" },
        );
      if (
        token === SyntaxKind.CloseBraceToken ||
        token === SyntaxKind.CloseBracketToken
      )
        collections.pop();
    }
  }
  const errors = [];
  const tree = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (!tree || errors.length)
    throw Object.assign(Error("Invalid strict JSON syntax"), {
      code: "strict_json_invalid",
    });
  return tree;
}

export function assertJsonTreeBounds(tree, limits) {
  const pending = [[tree, 0]];
  let seen = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (
      ++seen > limits.nodes ||
      depth > limits.depth ||
      (node.children?.length || 0) > limits.collection
    )
      throw Object.assign(
        Error("Received JSON exceeds the structured-response traversal limit"),
        { code: "model_response_structure_limit" },
      );
    for (const child of node.children || []) pending.push([child, depth + 1]);
  }
}
export function parseUniqueJson(text, { limits } = {}) {
  const tree = jsonSyntaxTree(text, { limits });
  if (limits) assertJsonTreeBounds(tree, limits);
  const pending = [[tree, 0]];
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (depth > 256)
      throw Object.assign(Error("Strict JSON nesting limit exceeded"), {
        code: "strict_json_depth",
      });
    if (node.type === "object") {
      const keys = new Set();
      for (const property of node.children || []) {
        const key = property.children[0].value;
        if (keys.has(key))
          throw Object.assign(
            Error(`Duplicate JSON object key at offset ${property.offset}`),
            { code: "strict_json_duplicate_key", offset: property.offset },
          );
        keys.add(key);
      }
    }
    for (const child of node.children || []) pending.push([child, depth + 1]);
  }
  // Only after the complete syntax/duplicate scan. JSON.parse also enforces
  // native JSON details rather than accepting JSONC recovery or extensions.
  return JSON.parse(text);
}
