import {
  LIBRARY_PROFILES,
  libraryProfile,
} from "../shared/library-profiles.mjs";
const error = (code, message) =>
  Object.assign(Error(message), {
    toolError: { code, retryable: false, mathematicalConclusion: "unknown" },
  });
export function inspectionSelection(
  { profileId, externalLibraryReceiptIds = [], libraryIds = [] },
  installed,
  { defaultProfile = "std-v1" } = {},
) {
  const profiles = new Set(LIBRARY_PROFILES.map((p) => p.id)),
    legacyProfiles = libraryIds.filter((id) => profiles.has(id));
  if (
    new Set(legacyProfiles).size > 1 ||
    (profileId && legacyProfiles.some((id) => id !== profileId))
  )
    throw error(
      "conflicting_profile_selection",
      "profileId conflicts with a legacy built-in profile. Select exactly one built-in profile; externalLibraryReceiptIds accepts installation receipts only.",
    );
  const selected = profileId || legacyProfiles[0] || defaultProfile;
  if (!profiles.has(selected))
    throw error(
      "unknown_builtin_profile",
      "Unknown profileId. Use list from builtInProfiles; a profile is not an external installation receipt.",
    );
  const ids = [
    ...new Set([
      ...externalLibraryReceiptIds,
      ...libraryIds.filter((id) => !profiles.has(id)),
    ]),
  ];
  if (ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))
    throw error(
      "invalid_external_library_receipt",
      "externalLibraryReceiptIds requires 64-character IDs returned by install_library in this execution; built-in profiles use profileId and pinned Mathlib uses modules.",
    );
  const receipts = ids.map((id) => {
    if (!installed.has(id))
      throw error(
        "external_library_receipt_not_owned",
        "This execution has no install_library receipt for " +
          id +
          ". Install the external library here or remove it; pinned Mathlib modules do not need an external library ID.",
      );
    return installed.get(id);
  });
  return {
    profile: libraryProfile(selected),
    receipts,
    notices: legacyProfiles.length
      ? [
          {
            code: "legacy_profile_parameter_normalized",
            profileId: selected,
            instruction:
              "Use profileId for built-in profiles. Only install_library receipt IDs belong in externalLibraryReceiptIds.",
          },
        ]
      : [],
  };
}
