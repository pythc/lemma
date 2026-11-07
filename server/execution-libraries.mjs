// A model-generated library id is not installation evidence. Only dependencies
// installed by this exact execution may be bound into a new mathematical target.
export async function receivedLibraries(store, record, ids = []) {
  if (!ids.length) return [];
  if (
    record?.source !== "deepagents-js" ||
    !record.harnessRoot ||
    !record.harnessRunId
  )
    throw Error(
      "External imports require execution-owned installation receipts",
    );
  const bundle = await store.bundle(record.harnessRoot);
  const report = bundle.artifacts.find((a) => a.id === record.harnessRoot);
  if (
    report?.payload.runId !== record.harnessRunId ||
    report.kind !== "harness:report"
  )
    throw Error("Foreign execution report");
  const values = bundle.artifacts
    .filter(
      (a) =>
        a.kind === "harness:tool" &&
        a.payload.runId === record.harnessRunId &&
        a.payload.name === "install_library",
    )
    .map((a) => a.payload.value);
  return ids.map((id) => {
    const receipt = values.find((v) => v.id === id);
    if (!receipt)
      throw Error(
        "Requested library was not installed in this execution stage",
      );
    return receipt;
  });
}
