// Shared prop types for detail section components

export type CreateGuardedGetterFn = (
  entryId: string,
  requireReprompt: boolean,
  getter: () => string,
) => () => Promise<string>;
