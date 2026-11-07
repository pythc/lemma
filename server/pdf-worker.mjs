import { parentPort, workerData } from "node:worker_threads";
let stage = "初始化 PDF 解析器";
try {
  // Import inside the boundary so initialization failures are reported as well.
  const { extractPage, extractPaper, extractPageGeometry } =
    await import("./pdf.mjs");
  stage = "读取 PDF 原文";
  parentPort.postMessage({
    type: "lemma.pdf.result.v1",
    ok: true,
    value: await (workerData.geometry
      ? extractPageGeometry(workerData.base64, workerData.pageIndex, {
          visibility: workerData.visibility === true,
          geometryVersion: workerData.geometryVersion,
        })
      : workerData.pageIndex === null
        ? extractPaper(workerData.base64)
        : extractPage(workerData.base64, workerData.pageIndex)),
  });
} catch (error) {
  const detail = typeof error?.message === "string" ? error.message.trim() : "";
  parentPort.postMessage({
    type: "lemma.pdf.result.v1",
    ok: false,
    error: `${stage}失败：${detail || "解析器没有提供具体错误信息。"}`,
  });
}
