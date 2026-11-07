import { LibraryAccess } from "../../server/library-access.mjs";

const [lockFile, mode] = process.argv.slice(2);
const lock = new LibraryAccess({ lockFile });
const controller = new AbortController();
let release;
const held = new Promise((resolve) => (release = resolve));
process.on("message", (message) => {
  if (message === "release") release();
  if (message === "cancel") controller.abort();
});
process.send({ event: "attempting", mode });
try {
  await lock.run(
    mode,
    async () => {
      process.send({ event: "entered", mode });
      await held;
    },
    { signal: controller.signal },
  );
  process.send({ event: "released", mode });
} catch (error) {
  process.send({ event: "rejected", mode, message: error.message });
}
process.disconnect();
