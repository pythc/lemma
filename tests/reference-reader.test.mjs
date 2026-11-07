import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "undici";
import {
  publicAddress,
  publicDocument,
  retrieveReference,
  paperUrls,
  discardReferenceBody,
} from "../server/reference-reader.mjs";
test("discarding an actual unread HTTP body cannot crash the review process", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: "https://example.org/paper" });
    res.write("redirect body remains open");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(
      `http://127.0.0.1:${server.address().port}/`,
      { maxRedirections: 0 },
    );
    discardReferenceBody(response.body);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(response.body.destroyed, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
import { inspection } from "../server/autonomy-schema.mjs";
const source = {
  pages: [
    {
      index: 0,
      text: "Use the external lemma at https://example.org/paper.pdf.",
    },
  ],
};
test("reference reader rejects nonpublic addresses and URLs outside actual bibliography candidates", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("1.1.1.1"), true);
  await assert.rejects(publicDocument("http://127.0.0.1/private"), /非公开/);
  await assert.rejects(publicDocument("file:///etc/passwd"), /公开/);
  await assert.rejects(
    retrieveReference({ url: "https://unmentioned.example/paper" }, source),
    /未出现/,
  );
});
test("bibliographic lookup remains metadata only, while retrieved PDF keeps byte identity and pages", async () => {
  const common = {
    url: "https://example.org/paper.pdf",
    sha256: "a".repeat(64),
    visited: [],
    retrievedAt: "2026-10-18T00:00:00Z",
  };
  const metadata = await retrieveReference(
    { query: "Test title" },
    source,
    [],
    {
      fetchDocument: async () => ({
        ...common,
        buffer: Buffer.from(
          JSON.stringify({
            message: {
              items: [
                {
                  title: ["Test title"],
                  DOI: "10.1/test",
                  URL: "https://example.org/paper.pdf",
                },
              ],
            },
          }),
        ),
      }),
    },
  );
  assert.equal(metadata.status, "metadata_only");
  assert.equal(metadata.externalReferencesVerified, false);
  const pdf = await retrieveReference(
    { url: paperUrls(source)[0] },
    source,
    [metadata],
    {
      fetchDocument: async () => ({
        ...common,
        buffer: Buffer.from("%PDF-fixture"),
        contentType: "application/pdf",
      }),
      extract: async () => ({
        pageCount: 1,
        pages: [{ index: 0, text: "The external lemma requires compactness." }],
      }),
    },
  );
  assert.equal(pdf.status, "text_obtained");
  assert.equal(Buffer.from(pdf.pdfBase64, "base64").toString(), "%PDF-fixture");
  assert.equal(pdf.externalReferencesVerified, false);
});
test("external evidence anchors keep their own identity and cannot be attached as the current PDF", () => {
  const ref = {
    id: "reference-1",
    url: "https://example.org/paper.pdf",
    artifact: "a".repeat(64),
    pages: [{ index: 0, text: "The external lemma requires compactness." }],
  };
  const value = {
    status: "unresolved",
    summary: "Need to check the compactness assumption.",
    anchors: [
      { pageIndex: 0, quote: source.pages[0].text },
      { referenceId: ref.id, pageIndex: 0, quote: ref.pages[0].text },
    ],
    assumptions: [],
    steps: [],
    dependencies: ["compactness"],
  };
  const result = inspection(value, source, { id: "c" }, "inspect_citation", [
    ref,
  ]);
  assert.equal(result.anchors[1].referenceId, ref.id);
  assert.equal(result.anchors[1].referenceArtifact, ref.artifact);
  assert.throws(
    () =>
      inspection(
        { ...value, anchors: [value.anchors[1]] },
        source,
        { id: "c" },
        "inspect_citation",
        [ref],
      ),
    /当前论文/,
  );
  assert.throws(
    () => inspection(value, source, { id: "c" }, "inspect_citation", []),
    /实际取得/,
  );
});
