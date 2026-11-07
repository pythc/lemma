import { verificationContext } from "./toolchain-tree.mjs";
import { randomUUID } from "node:crypto";
import { digest } from "./evidence.mjs";
import { libraryAccess } from "./library-access.mjs";
import { nativeSpan } from "./native-timing.mjs";
import { withEnvironmentBorrow } from "./environment-borrows.mjs";

// Protect managed publication and pin the exact paths used by this operation.
// Same-user external writers cannot be excluded by chmod or a hash directory:
// retain a byte verification after use; no long-lived verification cache.
export async function checkedReservation(
  contract,
  verify,
  action,
  { signal, access = libraryAccess } = {},
) {
  return access.read(
    async () => {
      signal?.throwIfAborted();
      const environment = await nativeSpan("environment.verify", () =>
        verificationContext.run(
          { signal, verificationEpoch: "before-use" },
          () => verify(contract),
        ),
      );
      const identity = digest(environment),
        id = randomUUID();
      return nativeSpan(
        "environment.reservation",
        () =>
          withEnvironmentBorrow(
            identity,
            id,
            environment.library?.snapshot?.id || null,
            async () => {
              const result = await action(environment);
              signal?.throwIfAborted();
              const after = await nativeSpan(
                "environment.verify_after_use",
                () =>
                  verificationContext.run(
                    { signal, verificationEpoch: randomUUID() },
                    () => verify(contract),
                  ),
              );
              if (digest(after) !== identity)
                throw Object.assign(
                  Error(
                    "Environment bytes changed during this operation; the received result is not accepted as evidence for the earlier environment",
                  ),
                  {
                    code: "environment_changed",
                    details: {
                      reservationId: id,
                      before: identity,
                      after: digest(after),
                    },
                    dispatchState: "result_rejected",
                  },
                );
              return result;
            },
          ),
        {
          reservationId: id,
          identity,
          librarySnapshotId: environment.library?.snapshot?.id || null,
          verificationCache: "disabled",
          protection: "managed_read_lease_and_content_reverification",
        },
      );
    },
    { signal },
  );
}
