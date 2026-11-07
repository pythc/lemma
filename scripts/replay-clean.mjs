import { cleanReplay } from "../server/clean-replay.mjs";
const file = process.argv[2];
const expected = process.argv.find((v) => v.startsWith("--expected-root="))?.slice(16);
const output = process.argv.find((v) => v.startsWith("--output="))?.slice(9);
if (!file || !expected || !output) {
  console.error("Usage: node scripts/replay-clean.mjs evidence.json|ndjson --expected-root=<archive root> --output=<NEW absolute directory>");
  process.exit(2);
}
const r = await cleanReplay(file, expected, output);
console.log(JSON.stringify({ output, integrity: r.integrity, reproduced: r.reproduced,
  revalidated: r.revalidated, sameEnvironment: r.sameEnvironment, error: r.error || r.result?.error || null }));
process.exitCode = r.reproduced ? 0 : 1;
