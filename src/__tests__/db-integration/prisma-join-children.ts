/**
 * Recognises the one concurrent-query source the integration suite's backstop
 * (setup.ts) exempts: Prisma's query interpreter loading the children of a
 * relation join, which it does with
 *
 *   Promise.all(t.args.children.map(async s => ({ joinExpr: s,
 *     childRecords: (await this.interpretNode(s.child, r)).value })))
 *
 * on the transaction's single connection. A stack frame is that construct only
 * when its column sits exactly on `interpretNode(` and the source right before
 * it is `childRecords:(await this.` — so the neighbouring interpreter arms (the
 * `case"transaction"` arm a few hundred characters on calls interpretNode too)
 * stay reported.
 */
const CHILD_LOAD_PREFIX = "childRecords:(await this.";
const CHILD_LOAD_CALL = "interpretNode(";

/** True when `column` (1-based) of `lineText` is the join-children load call. */
export function isPrismaJoinChildLoad(lineText: string, column: number): boolean {
  const at = column - 1;
  return lineText.startsWith(CHILD_LOAD_CALL, at) && lineText.slice(0, at).endsWith(CHILD_LOAD_PREFIX);
}

/**
 * True when a frame of `stack` in a Prisma runtime file is the join-children
 * load. `readLine(path, line)` returns that source line (1-based), or null.
 */
export function fromPrismaJoinChildren(
  stack: string,
  readLine: (path: string, line: number) => string | null,
): boolean {
  for (const match of stack.matchAll(/((?:file:\/\/)?[^\s()]*@prisma[^\s():]*):(\d+):(\d+)/g)) {
    const [, location, line, column] = match;
    const text = readLine(location, Number(line));
    if (text !== null && isPrismaJoinChildLoad(text, Number(column))) return true;
  }
  return false;
}
