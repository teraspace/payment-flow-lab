/** A successful value or an expected, typed use-case failure. */
export type Result<Value, Error> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: Error };

export const ok = <Value>(value: Value): Result<Value, never> => ({
  ok: true,
  value,
});

export const err = <Error>(error: Error): Result<never, Error> => ({
  ok: false,
  error,
});

export function andThen<Value, Error, NextValue, NextError>(
  result: Result<Value, Error>,
  next: (value: Value) => Result<NextValue, NextError>,
): Result<NextValue, Error | NextError> {
  return result.ok ? next(result.value) : result;
}

export async function andThenAsync<Value, Error, NextValue, NextError>(
  result: Result<Value, Error>,
  next: (value: Value) => Promise<Result<NextValue, NextError>>,
): Promise<Result<NextValue, Error | NextError>> {
  return result.ok ? next(result.value) : result;
}
