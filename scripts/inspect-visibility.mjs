import { readFile, writeFile } from "node:fs/promises";
import {
  pageGeometry,
  mathematicalDiscrepancies,
} from "../server/math-extraction.mjs";
const [pdf, out] = process.argv.slice(2);
const g = await pageGeometry((await readFile(pdf)).toString("base64"), 0, {
  visibility: true,
});
await writeFile(
  out + ".json",
  JSON.stringify(
    { geometry: g, issues: mathematicalDiscrepancies(g, null) },
    null,
    2,
  ),
  { flag: "wx" },
);
await writeFile(out + ".png", Buffer.from(g.pageImage.base64, "base64"), {
  flag: "wx",
});
console.log(
  g.visibility.items.map((x) => ({ text: g.items[x.itemIndex].text, ...x })),
);
