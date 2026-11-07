export function toolError(
  code,
  message,
  {
    fieldErrors = [],
    navigation = null,
    details = null,
    dispatchState = null,
  } = {},
) {
  return Object.assign(new Error(message), {
    code,
    fieldErrors,
    navigation,
    details,
    dispatchState,
  });
}
export function errorView(error) {
  return {
    message: error.message,
    code: error.code || null,
    cause: error.cause?.message || null,
    causeCode: error.cause?.code || null,
    fieldErrors: error.fieldErrors || [],
    navigation: error.navigation || null,
    details: error.details || null,
    dispatchState: error.dispatchState || null,
  };
}
