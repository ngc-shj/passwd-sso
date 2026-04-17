/** Thrown when a SCIM operation attempts to modify a tenant owner. */
export class ScimOwnerProtectedError extends Error {
  constructor() {
    super("SCIM_OWNER_PROTECTED");
    this.name = "ScimOwnerProtectedError";
  }
}
