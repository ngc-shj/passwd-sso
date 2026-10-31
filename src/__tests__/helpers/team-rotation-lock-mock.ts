/**
 * `$queryRaw` mock body for code that takes a team key-rotation lock
 * (src/lib/team/team-key-rotation-lock.ts). The bounded lock wait first
 * reads the transaction's lock_timeout to restore it afterwards; that read
 * is answered here, and every other query goes to `answer`.
 */
export function teamLockQuery(
  answer: unknown[] | ((sql: string, values: unknown[]) => unknown),
) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: "0" }];
    return typeof answer === "function" ? answer(sql, values) : answer;
  };
}

/** The calls of a `$queryRaw` mock other than the lock_timeout read. */
export function lockQueryCalls(mock: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }) {
  return mock.mock.calls
    .map((call, i) => ({
      sql: (call[0] as TemplateStringsArray).join("?"),
      values: call.slice(1),
      order: mock.mock.invocationCallOrder[i],
    }))
    .filter((call) => !call.sql.includes("current_setting('lock_timeout')"));
}
