/**
 * Member-set gates for member-foothold containment (C10): which code reads
 * webhooks to DELIVER, and which code WRITES a foothold row.
 *
 * Both sets are keyed per CALL SITE with its enclosing function
 * (`<path>::<function>::<model>.<method>`), never per file, so a second write
 * added to an already-classified file is a new, unclassified key.
 *
 * 1. Delivery readers: every `tenantWebhook.` / `teamWebhook.` `find*` call
 *    and every lexed raw read of tenant_webhooks / team_webhooks or of a
 *    templated table slot, in src/ and scripts/. Each key is classified as
 *    delivery (its function must call creatorVerdicts / webhookCreatorVerdicts),
 *    management or claim-carry, with a reason. Unclassified and stale keys fail.
 * 2. Foothold writers, default-deny: models come from FOOTHOLD_MODEL in
 *    member-containment.ts. EVERY create / createMany / createManyAndReturn /
 *    upsert / update / updateMany / updateManyAndReturn on those delegates in
 *    src/ is a site, whatever `data` holds, wrappers included (a wrapper's
 *    write is keyed at the write itself). A site calls lockFootholdWriter
 *    before any advisoryXactLock and any write in the same callback, or is an
 *    exempt key with a reason. Nested relation writes, aliased / destructured /
 *    computed delegates and lexed raw INSERT / UPDATE / DELETE (or a templated
 *    table slot) are sites too: an undecidable spelling is refused, not guessed.
 *    scripts/ and prisma/ are OUT of the writer scope: they run with an
 *    operator's authority, not a member's session.
 * 3. Model set, name-agnostic: a schema model with a tenantId is in the class
 *    when it has a relation to User other than its own subject `userId`, or a
 *    scalar uuid column that no relation names (an FK-less column). Every such
 *    column is keyed `Model.field` in FK_LESS_UUID as "creator" (its model must
 *    then be a FOOTHOLD_MODEL value or a keyed "not containable" entry) or with
 *    the reason it attributes no authority to a user. Unkeyed and stale keys fail.
 *    Only `@db.Uuid` String scalars are candidates: every user reference in this
 *    schema is a uuid column, and widening to any String would key names, URLs
 *    and hashes. A creator column declared without `@db.Uuid` would escape —
 *    accepted boundary.
 *
 * Verified without a Program (ts-morph in memory): names are read from syntax,
 * so a delegate reached through a type-erased alias the spelling rules cannot
 * see is refused or missed, never resolved. The SQL is lexed by the shared
 * scripts/checks/lib/sql-scan.mjs, not matched by regex.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { createAstProject, walkSourceFiles } from "../../scripts/checks/lib/ast-project.mjs";
import { TOKEN, nameOf, sqlInputFromNode, tokenizeSql } from "../../scripts/checks/lib/sql-scan.mjs";

const REPO_ROOT = path.resolve(__dirname, "../..");
const MIN_REASON_LENGTH = 10;

const WRITE_METHODS: ReadonlySet<string> = new Set([
  "create", "createMany", "createManyAndReturn", "upsert", "update", "updateMany", "updateManyAndReturn",
]);
const READ_METHODS: ReadonlySet<string> = new Set([
  "findFirst", "findFirstOrThrow", "findMany", "findUnique", "findUniqueOrThrow",
]);
/** Every delegate method, to tell `tx.model.method(` from a property read on an unrelated object. */
const DELEGATE_METHODS: ReadonlySet<string> = new Set([
  ...WRITE_METHODS, ...READ_METHODS, "delete", "deleteMany", "count", "aggregate", "groupBy",
]);
const NESTED_WRITE_KEYS: ReadonlySet<string> = new Set([
  "create", "createMany", "connectOrCreate", "upsert", "update", "updateMany", "set",
]);
const VERDICT_CALLS: ReadonlySet<string> = new Set(["creatorVerdicts", "webhookCreatorVerdicts"]);
const GATE = "lockFootholdWriter";
const GATE_MODULE = "@/lib/tenant/foothold-write-gate";
const WEBHOOK_MODELS: ReadonlySet<string> = new Set(["tenantWebhook", "teamWebhook"]);
const WEBHOOK_TABLES: ReadonlySet<string> = new Set(["tenant_webhooks", "team_webhooks"]);

/** Client-ish receivers: where a delegate access is recognised without a type. */
const CLIENT_RECEIVER = /(^|\.)(tx|prisma|db|client|workerPrisma|\w*Prisma|\w*Tx)$/;

// ─── Classification ───────────────────────────────────────

type ReaderClass = { kind: "delivery" | "management" | "claim-carry"; reason: string };

/**
 * Every webhook read site. `delivery` sites must call a creator-verdict
 * function in their own function; the others say why they never deliver.
 */
const READER_CLASS: Readonly<Record<string, ReaderClass>> = {
  "src/workers/audit-outbox-worker.ts::resolveWebhookSubscribers::teamWebhook.findMany": {
    kind: "delivery", reason: "worker fan-out resolves live team subscribers; verdicts filter creators who left",
  },
  "src/workers/audit-outbox-worker.ts::resolveWebhookSubscribers::tenantWebhook.findMany": {
    kind: "delivery", reason: "worker fan-out resolves live tenant subscribers; verdicts filter creators who left",
  },
  "src/lib/webhook-dispatcher.ts::dispatchTenantWebhook::tenantWebhook.findMany": {
    kind: "delivery", reason: "direct dispatch reads the tenant's webhooks and filters by creator verdict",
  },
  "src/app/api/tenant/webhooks/route.ts::handleGET::tenantWebhook.findMany": {
    kind: "management", reason: "settings list; reports creatorAuthorized to the admin, delivers nothing",
  },
  "src/app/api/tenant/webhooks/[webhookId]/route.ts::handleDELETE::tenantWebhook.findFirst": {
    kind: "management", reason: "existence read before a delete; delivers nothing",
  },
  "src/app/api/teams/[teamId]/webhooks/route.ts::handleGET::teamWebhook.findMany": {
    kind: "management", reason: "team settings list; reports creatorAuthorized, delivers nothing",
  },
  "src/app/api/teams/[teamId]/webhooks/[webhookId]/route.ts::handleDELETE::teamWebhook.findFirst": {
    kind: "management", reason: "existence read before a delete; delivers nothing",
  },
  "src/lib/tenant/member-containment.ts::listMemberContainment::tenantWebhook.findMany": {
    kind: "management", reason: "containment listing for the admin dialog; delivers nothing",
  },
  "src/lib/tenant/member-containment.ts::containMemberInTx::tenantWebhook.findMany": {
    kind: "management", reason: "containment revoke reads the rows it deletes; delivers nothing",
  },
  "scripts/migrate-webhook-secrets-v1-to-v2.ts::migrateInTx::teamWebhook.findMany": {
    kind: "management", reason: "operator secret re-encryption migration; sends nothing",
  },
  "scripts/migrate-webhook-secrets-v1-to-v2.ts::migrateInTx::tenantWebhook.findMany": {
    kind: "management", reason: "operator secret re-encryption migration; sends nothing",
  },
  "src/workers/retention-gc-worker/sweep.ts::sweepExpiryEntry::sql:read:${slot}": {
    kind: "management", reason: "retention sweep over a closed table list; counts expired rows, delivers nothing",
  },
  "src/workers/retention-gc-worker/sweep.ts::sweepGuardedExpiryEntry::sql:read:${slot}": {
    kind: "management", reason: "retention sweep over a closed table list; counts expired rows, delivers nothing",
  },
  "src/workers/retention-gc-worker/sweep.ts::sweepAuditProvenanceEntry::sql:read:${slot}": {
    kind: "management", reason: "retention sweep over a closed table list; reads provenance, delivers nothing",
  },
  "src/workers/retention-gc-worker/sweep.ts::sweepPerTenantAge::sql:read:${slot}": {
    kind: "management", reason: "retention sweep over a closed table list; reads row ages, delivers nothing",
  },
};

type WriterExempt = Readonly<Record<string, string>>;

/** Foothold write sites that do not call lockFootholdWriter, each with why. */
const WRITER_EXEMPT: WriterExempt = {
  "src/app/api/mcp/register/route.ts::handlePOST::mcpClient.create":
    "DCR registration: an unclaimed client with no tenant and no creator until the consent claim, which is gated",
  "src/app/api/tenant/breakglass/[id]/route.ts::handleDELETE::personalLogAccessGrant.updateMany":
    "revocation: only sets revokedAt, which is what containment does too",
  "src/app/api/tenant/members/[userId]/reset-vault/[resetId]/revoke/route.ts::handlePOST::adminVaultReset.updateMany":
    "revocation: only sets revokedAt and clears the token",
  "src/app/api/tenant/scim-tokens/[tokenId]/route.ts::handleDELETE::scimToken.update":
    "revocation: only sets revokedAt",
  "src/app/api/tenant/service-accounts/[id]/tokens/[tokenId]/route.ts::handleDELETE::serviceAccountToken.update":
    "revocation: only sets revokedAt",
  "src/app/api/vault/admin-reset/route.ts::handlePOST::adminVaultReset.updateMany":
    "target-driven reset execute: the target's own token consumes the reset, no admin session is acting",
  "src/auth.ts::claimedTenantMembership::emergencyAccessGrant.updateMany":
    "bootstrap tenantId move of the sole member's own grants into their new tenant; no foothold is created",
  "src/lib/auth/tokens/scim-token.ts::validateScimToken::scimToken.update":
    "lastUsedAt bookkeeping on token validation",
  "src/lib/auth/tokens/service-account-token.ts::validateServiceAccountToken::serviceAccountToken.update":
    "lastUsedAt bookkeeping on token validation",
  "src/lib/emergency-access/emergency-access-state.ts::transition::emergencyAccessGrant.updateMany":
    "state machine forward moves (accept, confirm, request, approve, revoke); creation is gated in its route",
  "src/lib/emergency-access/emergency-access-state.ts::bulkTransition::emergencyAccessGrant.updateMany":
    "state-machine bulk moves (expiry, vault-reset revocation); only state fields change, no grant is created",
  "src/lib/tenant/departure-footholds.ts::endCreatorFootholdsInTx::serviceAccountToken.updateManyAndReturn":
    "C4 departure revocation: sets revokedAt on a departed creator's tokens",
  "src/lib/tenant/departure-footholds.ts::endCreatorFootholdsInTx::adminVaultReset.updateManyAndReturn":
    "C4 departure revocation: revokes a departed initiator's unapproved resets",
  "src/lib/tenant/member-containment.ts::containMemberInTx::scimToken.updateManyAndReturn":
    "C7 containment: revokes the contained member's tokens under the admin's authority",
  "src/lib/tenant/member-containment.ts::containMemberInTx::serviceAccount.updateManyAndReturn":
    "C7 containment: deactivates the contained member's service accounts",
  "src/lib/tenant/member-containment.ts::containMemberInTx::serviceAccountToken.updateManyAndReturn":
    "C7 containment: revokes the contained member's service-account tokens",
  "src/lib/tenant/member-containment.ts::containMemberInTx::mcpClient.updateManyAndReturn":
    "C7 containment: deactivates the contained member's MCP clients",
  "src/lib/tenant/member-containment.ts::containMemberInTx::personalLogAccessGrant.updateManyAndReturn":
    "C7 containment: revokes the contained member's break-glass grants",
  "src/lib/tenant/member-containment.ts::containMemberInTx::adminVaultReset.updateManyAndReturn":
    "C7 containment: revokes the contained member's pending vault resets",
  "src/lib/tenant/member-containment.ts::containMemberInTx::passwordShare.updateManyAndReturn":
    "containment: revokes the contained member's share links and Sends (sets revokedAt only)",
  "src/lib/tenant/member-containment.ts::containMemberInTx::auditDeliveryTarget.updateManyAndReturn":
    "containment: deactivates the contained member's audit delivery targets (isActive false only)",
  "src/app/api/admin/rotate-master-key/[rotationId]/execute/route.ts::handlePOST::passwordShare.updateMany":
    "operator master-key re-encryption of existing share ciphertext; creates no share, runs on an operator token",
  "src/app/api/share-links/[id]/content/route.ts::handleGET::sql:UPDATE:password_shares":
    "view counting on a share being read (view_count); creates and revokes nothing",
  "src/app/s/[token]/download/route.ts::GET::sql:UPDATE:password_shares":
    "view counting on a Send being downloaded (view_count); creates and revokes nothing",
  "src/app/s/[token]/page.tsx::SharePage::sql:UPDATE:password_shares":
    "view counting on a share being opened (view_count); creates and revokes nothing",
  "src/app/api/share-links/[id]/route.ts::handleDELETE::passwordShare.updateMany":
    "revocation: only sets revokedAt, which is what containment does too",
  "src/auth.ts::claimedTenantMembership::passwordShare.updateMany":
    "bootstrap tenantId move of the sole member's own shares into their new tenant; no share is created",
  "src/workers/audit-outbox-worker.ts::processOneDelivery::auditDeliveryTarget.update":
    "delivery health bookkeeping (lastDeliveredAt, failCount, isActive); creates no target",
  "src/workers/audit-outbox-worker.ts::recordDeliveryError::auditDeliveryTarget.update":
    "delivery health bookkeeping (failCount, lastError, isActive); creates no target",
  "src/lib/webhook-dispatcher.ts::dispatchTenantWebhook::tenantWebhook.update":
    "delivery health bookkeeping (lastDeliveredAt, failCount, isActive); creates no webhook",
  "src/workers/audit-outbox-worker.ts::onWebhookDeliverySuccess::tenantWebhook.update":
    "delivery health bookkeeping (lastDeliveredAt, failCount); creates no webhook",
  "src/workers/audit-outbox-worker.ts::onWebhookDeliveryFailure::sql:UPDATE:${slot}":
    "delivery health bookkeeping over team_webhooks / tenant_webhooks (failCount, isActive); creates no webhook",
  "src/workers/retention-gc-worker/sweep.ts::sweepExpiryEntry::sql:DELETE:${slot}":
    "retention sweep over a closed table list; deletes expired rows only",
  "src/workers/retention-gc-worker/sweep.ts::sweepGuardedExpiryEntry::sql:DELETE:${slot}":
    "retention sweep over a closed table list; deletes expired rows only",
  "src/workers/retention-gc-worker/sweep.ts::sweepAuditProvenanceEntry::sql:DELETE:${slot}":
    "retention sweep over a closed table list; deletes expired rows only",
  "src/workers/retention-gc-worker/sweep.ts::sweepPerTenantAge::sql:DELETE:${slot}":
    "retention sweep over a closed table list; deletes aged rows only",
};

type NotContainable = Readonly<Record<string, string>>;

/** Schema models with a tenantId and a non-subject User relation that are not containable footholds. */
const NOT_CONTAINABLE: NotContainable = {
  OperatorToken: "operator tokens are subject-bound: they authenticate as their subject, not as the creator",
  TeamInvitation: "team domain, handled with team footholds in #1043",
  TeamPasswordEntry: "team entry content authored by a member; not an authority-bearing credential",
  TeamPasswordEntryHistory: "history of team entries; content, not authority (team domain, #1043)",
  Attachment: "encrypted entry attachment; content, not authority",
  AccessRequest: "the issued token goes to the approver, not the requester's creator relation",
  MasterKeyRotation: "operator-driven master-key rotation; not a member's foothold",
  TeamWebhook: "team domain: paused at delivery once its creator lost team authority, #1043",
};

/**
 * Every uuid scalar of a tenant model that no relation names, keyed
 * `Model.field`: "creator" for a column recording who made the row (the model
 * must then be classified above), otherwise the reason it attributes no
 * authority to a user.
 */
const FK_LESS_UUID: Readonly<Record<string, string>> = {
  "TenantWebhook.createdById": "creator",
  "TeamWebhook.createdById": "creator",
  "AuditDeliveryTarget.createdById": "creator",
  "ExtensionToken.familyId": "rotation family id grouping one token's refresh chain; names no user",
  "McpRefreshToken.familyId": "rotation family id grouping one token's refresh chain; names no user",
  "TeamPasswordEntry.itemKeyId": "id of the item key that wraps the entry; a key reference, not a user",
  "TeamPasswordEntryHistory.itemKeyId": "id of the item key that wraps the history row; a key reference, not a user",
  "Attachment.cekItemKeyId": "id of the item key that wraps the attachment key; a key reference, not a user",
  "AuditLog.userId": "the actor recorded for provenance; the row is a record, not a credential that acts",
  "AuditLog.outboxId": "id of the outbox row the log was drained from; names no user",
  "AuditDelivery.outboxId": "id of the outbox row being delivered; names no user",
  "WebhookDelivery.outboxId": "id of the outbox row being delivered; names no user",
  "WebhookDelivery.teamId": "destination team of a delivery record; names no user",
  "AccessRequest.grantedTokenId": "id of the token issued on approval; names no user",
  "McpAuthorizationCode.userId": "token subject: authenticates as that user and is revoked with their auth artifacts",
  "McpAuthorizationCode.serviceAccountId": "token subject: authenticates as that service account, not a creator link",
  "McpAccessToken.userId": "token subject: authenticates as that user and is revoked with their auth artifacts",
  "McpAccessToken.serviceAccountId": "token subject: authenticates as that service account, not a creator link",
  "McpRefreshToken.userId": "token subject: authenticates as that user and is revoked with their auth artifacts",
  "McpRefreshToken.serviceAccountId": "token subject: authenticates as that service account, not a creator link",
};

// ─── Schema and model map ─────────────────────────────────

interface SchemaModel {
  name: string;
  table: string | null;
  hasTenantId: boolean;
  /** Relation fields to User other than the subject `userId` relation. */
  otherUserRelations: string[];
  /** Fields typed as another model: field name -> model name. */
  fieldModels: Map<string, string>;
  /** Uuid String scalars (other than id / tenantId) that no relation's `fields` names. */
  fkLessUuids: string[];
}

function parseSchema(text: string): SchemaModel[] {
  const models: SchemaModel[] = [];
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lines = m[2].split("\n").map((l) => l.trim());
    const model: SchemaModel = {
      name: m[1], table: null, hasTenantId: false, otherUserRelations: [], fieldModels: new Map(), fkLessUuids: [],
    };
    const relationFks = new Set<string>();
    const uuidScalars: string[] = [];
    for (const line of lines) {
      const map = line.match(/^@@map\("([^"]+)"\)/);
      if (map) model.table = map[1];
      if (/^tenantId\s/.test(line)) model.hasTenantId = true;
      const field = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
      if (!field) continue;
      model.fieldModels.set(field[1], field[2]);
      const fks = field[4].match(/@relation\([^)]*fields:\s*\[([^\]]*)\]/);
      if (fks) for (const fk of fks[1].split(",")) relationFks.add(fk.trim());
      if (
        field[2] === "String" && field[3] !== "[]" && /@db\.Uuid/.test(field[4]) && !/@id\b/.test(field[4]) &&
        field[1] !== "id" && field[1] !== "tenantId"
      ) {
        uuidScalars.push(field[1]);
      }
      if (field[2] === "User") {
        const fk = field[4].match(/fields:\s*\[(\w+)\]/);
        if (fk && fk[1] !== "userId") model.otherUserRelations.push(field[1]);
      }
    }
    model.fkLessUuids = uuidScalars.filter((f) => !relationFks.has(f));
    models.push(model);
  }
  return models;
}

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** FOOTHOLD_MODEL's delegate names, read from the declaration's object literal. */
function parseFootholdModel(file: SourceFile): string[] {
  const decl = file.getVariableDeclaration("FOOTHOLD_MODEL");
  const init = decl?.getInitializer();
  if (!init || !Node.isObjectLiteralExpression(init)) throw new Error("FOOTHOLD_MODEL is not an object literal");
  return init.getProperties().map((p) => {
    if (!Node.isPropertyAssignment(p)) throw new Error("FOOTHOLD_MODEL has a non-property member");
    const value = p.getInitializer();
    if (!value || !Node.isStringLiteral(value)) throw new Error("FOOTHOLD_MODEL has a non-literal value");
    return value.getLiteralText();
  });
}

interface FootholdContext {
  /** Delegate names (lowerCamel model names). */
  delegates: ReadonlySet<string>;
  /** `@@map` table names. */
  tables: ReadonlySet<string>;
  /** Fields on any model typed as a foothold model (nested-write targets). */
  relationFields: ReadonlySet<string>;
}

function buildContext(schema: SchemaModel[], delegates: string[]): FootholdContext {
  const modelNames = new Set(delegates.map(upperFirst));
  const tables = new Set<string>();
  const relationFields = new Set<string>();
  for (const model of schema) {
    if (modelNames.has(model.name) && model.table) tables.add(model.table);
    for (const [field, type] of model.fieldModels) if (modelNames.has(type)) relationFields.add(field);
  }
  return { delegates: new Set(delegates), tables, relationFields };
}

// ─── AST helpers ──────────────────────────────────────────

const isFunctionLike = (n: Node): boolean =>
  Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n);

/** Function-like ancestors of `node`, innermost first. */
function functionChain(node: Node): Node[] {
  return node.getAncestors().filter(isFunctionLike);
}

/** The innermost function-like node enclosing `node`, or the source file. */
function scopeOf(node: Node): Node {
  return functionChain(node)[0] ?? node.getSourceFile();
}

/**
 * The named function a site belongs to: the nearest declared or method
 * function, else the module-level binding the code sits in (`export const
 * POST = withLog(async …)`), so an inline callback is keyed under its handler
 * and a local `const result = …` never names a site.
 */
function enclosingNamed(node: Node): { name: string; node: Node } {
  let passedFunction = false;
  for (const a of node.getAncestors()) {
    if (isFunctionLike(a)) {
      passedFunction = true;
      if ((Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a)) && a.getName()) {
        return { name: a.getName() as string, node: a };
      }
    } else if (passedFunction && Node.isVariableDeclaration(a) && scopeOf(a) === a.getSourceFile()) {
      return { name: a.getName(), node: a };
    }
  }
  return { name: passedFunction ? "<anonymous>" : "<module>", node: node.getSourceFile() };
}

const calleeName = (call: Node): string | null => {
  if (!Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  return Node.isIdentifier(callee) ? callee.getText() : null;
};

/** Nodes of `kind` under `root` whose innermost function is `scope`. */
function inDirectScope<T extends Node>(root: Node, kind: SyntaxKind, scope: Node): T[] {
  return root.getDescendantsOfKind(kind).filter((n) => scopeOf(n) === scope) as T[];
}

// ─── Sites ────────────────────────────────────────────────

interface Site {
  key: string;
  file: string;
  /** What the spelling is: "write", "nested", "alias", "destructure", "computed", "sql". */
  spelling: string;
  node: Node;
  scope: Node;
  fn: Node;
}

function siteKey(file: SourceFile, node: Node, label: string, rel: string): { key: string; fn: Node } {
  const named = enclosingNamed(node);
  return { key: `${rel}::${named.name}::${label}`, fn: named.node };
}

function propertyAccessOf(call: Node): { receiver: Node; model: string; method: string } | null {
  if (!Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const delegate = callee.getExpression();
  if (!Node.isPropertyAccessExpression(delegate)) return null;
  return { receiver: delegate.getExpression(), model: delegate.getName(), method: callee.getName() };
}

/** Raw SQL statements found by lexing one literal: [{ op, table }] or reads. */
function rawStatements(node: Node): { op: "INSERT" | "UPDATE" | "DELETE" | "READ"; table: string }[] {
  const input = sqlInputFromNode(node);
  if (!input) return [];
  const text = input.parts.join(" ").toLowerCase();
  if (!/(insert|update|delete|select)/.test(text)) return [];
  const tokens = tokenizeSql(input) as { type: string; upper: string; text: string; value: string }[];
  const isSlot = (t: { type: string; value: string }) =>
    t.type === TOKEN.OPAQUE || (t.type === TOKEN.QIDENT && (t.value === "" || t.value.includes("")));
  const hasSelect = tokens.some((t) => t.type === TOKEN.WORD && t.upper === "SELECT");
  const out: { op: "INSERT" | "UPDATE" | "DELETE" | "READ"; table: string }[] = [];

  /** The table named at `i`: last name of a dotted chain, or the slot's text. */
  const tableAt = (start: number): { table: string; end: number } | null => {
    let i = start;
    if (tokens[i]?.type === TOKEN.WORD && tokens[i].upper === "ONLY") i++;
    let last: string | null = null;
    for (;;) {
      const t = tokens[i];
      if (!t) break;
      if (isSlot(t)) last = "${slot}";
      else if (t.type === TOKEN.WORD || t.type === TOKEN.QIDENT) last = nameOf(t);
      else break;
      i++;
      if (tokens[i]?.type === TOKEN.DOT) i++;
      else break;
    }
    return last === null ? null : { table: last, end: i };
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== TOKEN.WORD) continue;
    const prev = tokens[i - 1];
    if (t.upper === "INSERT" && tokens[i + 1]?.upper === "INTO") {
      const at = tableAt(i + 2);
      if (at) out.push({ op: "INSERT", table: at.table });
    } else if (t.upper === "UPDATE" && !(prev?.type === TOKEN.WORD && prev.upper === "DO")) {
      const at = tableAt(i + 1);
      if (!at) continue;
      // UPDATE <t> [[AS] alias] SET: prose that merely says "update" has no SET.
      const rest = tokens.slice(at.end, at.end + 3);
      if (rest.some((r) => r.type === TOKEN.WORD && r.upper === "SET")) out.push({ op: "UPDATE", table: at.table });
    } else if (t.upper === "DELETE" && tokens[i + 1]?.upper === "FROM") {
      const at = tableAt(i + 2);
      if (at) out.push({ op: "DELETE", table: at.table });
    } else if (t.upper === "FROM" && hasSelect && !(prev?.type === TOKEN.WORD && prev.upper === "DELETE")) {
      const at = tableAt(i + 1);
      if (at) out.push({ op: "READ", table: at.table });
    } else if (t.upper === "JOIN" && hasSelect) {
      const at = tableAt(i + 1);
      if (at) out.push({ op: "READ", table: at.table });
    }
  }
  return out;
}

interface Analysis {
  readers: (Site & { callsVerdict: boolean })[];
  writers: (Site & { gate: "ok" | "missing" | "after-lock" | "after-write" | "no-import" })[];
}

function hasGateImport(file: SourceFile): boolean {
  return file.getImportDeclarations().some(
    (d) => d.getModuleSpecifierValue() === GATE_MODULE && d.getNamedImports().some((n) => n.getName() === GATE && !n.getAliasNode()),
  );
}

/** Whether a gate call precedes the site, and nothing locks or writes before the gate in its callback. */
function gateStatus(site: Site, file: SourceFile): Analysis["writers"][number]["gate"] {
  const gates = file.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => calleeName(c) === GATE);
  const chain: Node[] = [...functionChain(site.node), file];
  for (const fn of chain) {
    const gate = gates.find((g) => scopeOf(g) === fn && g.getStart() < site.node.getStart());
    if (!gate) continue;
    if (!hasGateImport(file)) return "no-import";
    const calls = inDirectScope<Node>(fn, SyntaxKind.CallExpression, fn).filter((c) => c.getStart() < gate.getStart());
    if (calls.some((c) => calleeName(c) === "advisoryXactLock")) return "after-lock";
    const wroteBefore = calls.some((c) => {
      const access = propertyAccessOf(c);
      if (access && (WRITE_METHODS.has(access.method) || access.method === "delete" || access.method === "deleteMany")) return true;
      const callee = Node.isCallExpression(c) ? c.getExpression().getText() : "";
      return /\$executeRaw(Unsafe)?$/.test(callee);
    });
    return wroteBefore ? "after-write" : "ok";
  }
  return "missing";
}

function analyze(files: ReadonlyMap<string, string>, ctx: FootholdContext, opts: { writerScope: (rel: string) => boolean }): Analysis {
  const project = createAstProject();
  const analysis: Analysis = { readers: [], writers: [] };

  for (const [rel, text] of files) {
    const file = project.createSourceFile(rel, text, { overwrite: true });
    const addWriter = (node: Node, label: string, spelling: string) => {
      const { key, fn } = siteKey(file, node, label, rel);
      const site: Site = { key, file: rel, spelling, node, scope: scopeOf(node), fn };
      analysis.writers.push({ ...site, gate: gateStatus(site, file) });
    };
    const addReader = (node: Node, label: string) => {
      const { key, fn } = siteKey(file, node, label, rel);
      const callsVerdict = fn
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .some((c) => VERDICT_CALLS.has(calleeName(c) ?? ""));
      analysis.readers.push({ key, file: rel, spelling: "read", node, scope: scopeOf(node), fn, callsVerdict });
    };
    const writerScope = opts.writerScope(rel);

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const access = propertyAccessOf(call);
      if (!access) continue;
      if (WEBHOOK_MODELS.has(access.model) && READ_METHODS.has(access.method)) {
        addReader(call, `${access.model}.${access.method}`);
      }
      if (!writerScope) continue;
      if (ctx.delegates.has(access.model) && WRITE_METHODS.has(access.method)) {
        addWriter(call, `${access.model}.${access.method}`, "write");
      } else if (WRITE_METHODS.has(access.method)) {
        // A nested relation write: a parent's data holds `<relation>: { create | … }` to a foothold model.
        const dataArg = call.getArguments()[0];
        if (dataArg && Node.isObjectLiteralExpression(dataArg)) {
          for (const prop of dataArg.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
            const value = prop.getInitializer();
            if (!ctx.relationFields.has(prop.getName()) || !value || !Node.isObjectLiteralExpression(value)) continue;
            const nested = value.getProperties().some((p) => Node.isPropertyAssignment(p) && NESTED_WRITE_KEYS.has(p.getName()));
            if (nested) addWriter(call, `nested:${access.model}.${access.method}->${prop.getName()}`, "nested");
          }
        }
      }
    }

    if (writerScope) {
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (!ctx.delegates.has(access.getName())) continue;
        if (!CLIENT_RECEIVER.test(access.getExpression().getText())) continue;
        const parent = access.getParent();
        const isCallee =
          Node.isPropertyAccessExpression(parent) && parent.getExpression() === access && DELEGATE_METHODS.has(parent.getName());
        // `tx.model.fields.<column>` is a field reference (a column compared to another): it cannot write.
        const isFieldRef = Node.isPropertyAccessExpression(parent) && parent.getExpression() === access && parent.getName() === "fields";
        if (!isCallee && !isFieldRef) addWriter(access, `alias:${access.getName()}`, "alias");
      }
      for (const el of file.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
        if (!CLIENT_RECEIVER.test(el.getExpression().getText())) continue;
        const arg = el.getArgumentExpression();
        const literal = arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) ? arg.getLiteralText() : null;
        if (literal === null || ctx.delegates.has(literal)) addWriter(el, `computed:${el.getExpression().getText()}[]`, "computed");
      }
      for (const el of file.getDescendantsOfKind(SyntaxKind.BindingElement)) {
        const name = (el.getPropertyNameNode() ?? el.getNameNode()).getText();
        if (!ctx.delegates.has(name)) continue;
        const pattern = el.getParent();
        const owner = pattern?.getParent();
        const init = owner && Node.isVariableDeclaration(owner) ? owner.getInitializer()?.getText() : undefined;
        const typed = owner && Node.isParameterDeclaration(owner) ? owner.getTypeNode()?.getText() : undefined;
        if ((init && CLIENT_RECEIVER.test(init)) || (typed && /Prisma|Transaction|Tx|Client/.test(typed))) {
          addWriter(el, `destructure:${name}`, "destructure");
        }
      }
    }

    // Raw SQL, over every string / template literal.
    const literals = [
      ...file.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
      ...file.getDescendantsOfKind(SyntaxKind.TemplateExpression),
    ].filter((n) => !Node.isImportDeclaration(n.getParent()) && !Node.isExportDeclaration(n.getParent()));
    for (const lit of literals) {
      for (const stmt of rawStatements(lit)) {
        const named = stmt.table === "${slot}" || WEBHOOK_TABLES.has(stmt.table);
        if (stmt.op === "READ") {
          if (named) addReader(lit, `sql:read:${stmt.table}`);
        } else if (writerScope && (stmt.table === "${slot}" || ctx.tables.has(stmt.table))) {
          addWriter(lit, `sql:${stmt.op}:${stmt.table}`, "sql");
        }
      }
    }
  }
  return analysis;
}

// ─── Evaluation ───────────────────────────────────────────

function dedupe<T extends { key: string }>(items: T[]): Map<string, T[]> {
  const byKey = new Map<string, T[]>();
  for (const item of items) byKey.set(item.key, [...(byKey.get(item.key) ?? []), item]);
  return byKey;
}

function checkReasons(label: string, entries: Record<string, { reason: string } | string>): string[] {
  return Object.entries(entries)
    .filter(([, v]) => (typeof v === "string" ? v : v.reason).trim().length < MIN_REASON_LENGTH)
    .map(([k]) => `${label} without a reason: ${k}`);
}

function evaluateReaders(
  analysis: Analysis,
  classes: Readonly<Record<string, ReaderClass>>,
): string[] {
  const problems = checkReasons("reader class", { ...classes });
  const byKey = dedupe(analysis.readers);
  for (const [key, sites] of byKey) {
    const cls = classes[key];
    if (!cls) {
      problems.push(`unclassified webhook read: ${key}`);
    } else if (cls.kind === "delivery" && !sites.every((s) => s.callsVerdict)) {
      problems.push(`delivery read without a creator verdict in its function: ${key}`);
    }
  }
  for (const key of Object.keys(classes)) if (!byKey.has(key)) problems.push(`stale reader key: ${key}`);
  return problems;
}

function evaluateWriters(analysis: Analysis, exempt: WriterExempt): string[] {
  const problems = checkReasons("writer exemption", { ...exempt });
  const byKey = dedupe(analysis.writers);
  for (const [key, sites] of byKey) {
    for (const site of sites) {
      if (site.gate === "after-lock") problems.push(`${GATE} comes after advisoryXactLock: ${key}`);
      else if (site.gate === "after-write") problems.push(`${GATE} comes after a write in its callback: ${key}`);
      else if (site.gate === "no-import") problems.push(`${GATE} is not imported from ${GATE_MODULE}: ${key}`);
      else if (site.gate === "missing" && !(key in exempt)) problems.push(`unclassified foothold write (${site.spelling}): ${key}`);
    }
  }
  for (const key of Object.keys(exempt)) if (!byKey.has(key)) problems.push(`stale writer exemption: ${key}`);
  return problems;
}

function evaluateModelSet(
  schema: SchemaModel[],
  delegates: string[],
  notContainable: NotContainable,
  fkLessUuid: Readonly<Record<string, string>> = {},
): string[] {
  const problems = [
    ...checkReasons("not-containable entry", { ...notContainable }),
    ...checkReasons("FK-less uuid key", Object.fromEntries(Object.entries(fkLessUuid).filter(([, v]) => v !== "creator"))),
  ];
  const footholdModels = new Set(delegates.map(upperFirst));
  const known = new Set(schema.map((m) => m.name));

  const candidates = new Set(
    schema.filter((m) => m.hasTenantId).flatMap((m) => m.fkLessUuids.map((f) => `${m.name}.${f}`)),
  );
  for (const key of candidates) if (!(key in fkLessUuid)) problems.push(`unkeyed FK-less uuid column: ${key}`);
  for (const key of Object.keys(fkLessUuid)) if (!candidates.has(key)) problems.push(`stale FK-less uuid key: ${key}`);

  const derived = new Set([
    ...schema.filter((m) => m.hasTenantId && m.otherUserRelations.length > 0).map((m) => m.name),
    ...Object.entries(fkLessUuid).filter(([key, v]) => v === "creator" && candidates.has(key)).map(([key]) => key.split(".")[0]),
  ]);
  for (const name of derived) {
    if (!footholdModels.has(name) && !(name in notContainable)) problems.push(`schema model neither in FOOTHOLD_MODEL nor not-containable: ${name}`);
  }
  for (const name of footholdModels) if (!known.has(name)) problems.push(`FOOTHOLD_MODEL value is not a schema model: ${name}`);
  for (const name of Object.keys(notContainable)) {
    if (!derived.has(name)) problems.push(`stale not-containable entry (not a creator-bearing tenant model): ${name}`);
    if (footholdModels.has(name)) problems.push(`model is both in FOOTHOLD_MODEL and not-containable: ${name}`);
  }
  return problems;
}

// ─── Real tree ────────────────────────────────────────────

function readTree(): Map<string, string> {
  const files = new Map<string, string>();
  for (const dir of ["src", "scripts"]) {
    for (const abs of walkSourceFiles(path.join(REPO_ROOT, dir), [".ts", ".tsx", ".mjs"]) as string[]) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
      files.set(rel, readFileSync(abs, "utf8"));
    }
  }
  return files;
}

const schema = parseSchema(readFileSync(path.join(REPO_ROOT, "prisma/schema.prisma"), "utf8"));
const delegates = parseFootholdModel(
  createAstProject().createSourceFile("member-containment.ts", readFileSync(path.join(REPO_ROOT, "src/lib/tenant/member-containment.ts"), "utf8")),
);
const context = buildContext(schema, delegates);
const inSrc = (rel: string): boolean => rel.startsWith("src/");

describe("foothold member set (real tree)", () => {
  const analysis = analyze(readTree(), context, { writerScope: inSrc });

  it("classifies every webhook read site as delivery, management or claim-carry", () => {
    expect(evaluateReaders(analysis, READER_CLASS)).toEqual([]);
  });

  it("gates or exempts every foothold write site, with the gate first in its transaction", () => {
    expect(evaluateWriters(analysis, WRITER_EXEMPT)).toEqual([]);
  });

  it("covers every schema model with a tenantId and a non-subject User relation", () => {
    expect(evaluateModelSet(schema, delegates, NOT_CONTAINABLE, FK_LESS_UUID)).toEqual([]);
  });

  it("finds the sites it is meant to find", () => {
    // A scan that matched nothing would pass every test above.
    expect(analysis.readers.length).toBeGreaterThan(5);
    expect(analysis.writers.length).toBeGreaterThan(20);
    expect(delegates).toContain("scimToken");
  });
});

// ─── Positive controls ────────────────────────────────────

const GATE_IMPORT = `import { lockFootholdWriter } from "${GATE_MODULE}";\n`;
const run = (source: string, exempt: WriterExempt = {}): string[] =>
  evaluateWriters(analyze(new Map([["src/fixture.ts", source]]), context, { writerScope: inSrc }), exempt);

describe("foothold member set (positive controls)", () => {
  it("passes a gated write", () => {
    const source = `${GATE_IMPORT}export async function POST(tx: any) {
      await lockFootholdWriter(tx);
      await tx.scimToken.create({ data: {} });
    }`;
    expect(run(source)).toEqual([]);
  });

  it("fails an unclassified write", () => {
    const source = `export async function POST(tx: any) { await tx.scimToken.create({ data: {} }); }`;
    expect(run(source)).toEqual(["unclassified foothold write (write): src/fixture.ts::POST::scimToken.create"]);
  });

  it("passes an exempt write that has a reason", () => {
    const source = `export async function reap(tx: any) { await tx.scimToken.updateMany({ data: {} }); }`;
    expect(run(source, { "src/fixture.ts::reap::scimToken.updateMany": "reaper only sets revokedAt on expired rows" })).toEqual([]);
  });

  it("fails an exemption without a reason", () => {
    const source = `export async function reap(tx: any) { await tx.scimToken.updateMany({ data: {} }); }`;
    expect(run(source, { "src/fixture.ts::reap::scimToken.updateMany": "" })).toEqual([
      "writer exemption without a reason: src/fixture.ts::reap::scimToken.updateMany",
    ]);
  });

  it("fails a stale exemption", () => {
    expect(run(`export const x = 1;`, { "src/fixture.ts::gone::scimToken.create": "was removed long ago" })).toEqual([
      "stale writer exemption: src/fixture.ts::gone::scimToken.create",
    ]);
  });

  it("fails a write whose data is a spread", () => {
    const source = `export async function POST(tx: any, body: object) { await tx.serviceAccount.create({ data: { ...body } }); }`;
    expect(run(source)).toHaveLength(1);
  });

  it("fails a nested relation write from a parent", () => {
    const source = `export async function POST(tx: any) {
      await tx.tenant.update({ where: {}, data: { scimTokens: { create: { tokenHash: "x" } } } });
    }`;
    expect(run(source)).toEqual([
      "unclassified foothold write (nested): src/fixture.ts::POST::nested:tenant.update->scimTokens",
    ]);
  });

  it("fails a destructured delegate", () => {
    const source = `export async function POST(tx: any) { const { scimToken } = tx; await scimToken.create({ data: {} }); }`;
    expect(run(source)).toEqual(["unclassified foothold write (destructure): src/fixture.ts::POST::destructure:scimToken"]);
  });

  it("does not take a field reference of a foothold delegate for an alias", () => {
    const source = `export async function list(tx: any) { return tx.scimToken.findMany({ where: { a: tx.scimToken.fields.b } }); }`;
    expect(run(source)).toEqual([]);
  });

  it("exempts only `fields`: another non-method member of a foothold delegate is still an alias", () => {
    const source = `export async function POST(tx: any) { await tx.scimToken.unknownWriter({ data: {} }); }`;
    expect(run(source)).toEqual(["unclassified foothold write (alias): src/fixture.ts::POST::alias:scimToken"]);
  });

  it("still sees the ungated write around a field reference", () => {
    const source = `export async function POST(tx: any) { await tx.scimToken.create({ data: { a: tx.scimToken.fields.b } }); }`;
    expect(run(source)).toEqual(["unclassified foothold write (write): src/fixture.ts::POST::scimToken.create"]);
  });

  it("fails an aliased delegate", () => {
    const source = `export async function POST(tx: any) { const d = tx.scimToken; await d.create({ data: {} }); }`;
    expect(run(source)).toEqual(["unclassified foothold write (alias): src/fixture.ts::POST::alias:scimToken"]);
  });

  it("fails a computed delegate", () => {
    const source = `export async function POST(tx: any, model: string) { await tx[model].create({ data: {} }); }`;
    expect(run(source)).toEqual(["unclassified foothold write (computed): src/fixture.ts::POST::computed:tx[]"]);
  });

  it("fails a raw INSERT into a foothold table", () => {
    const source = "export async function POST(tx: any) { await tx.$executeRaw`INSERT INTO scim_tokens (id) VALUES (1)`; }";
    expect(run(source)).toEqual(["unclassified foothold write (sql): src/fixture.ts::POST::sql:INSERT:scim_tokens"]);
  });

  it("fails a raw UPDATE through a templated table slot", () => {
    const source = "export async function POST(tx: any, t: string) { await tx.$executeRaw`UPDATE ${t} SET a = 1`; }";
    expect(run(source)).toEqual(["unclassified foothold write (sql): src/fixture.ts::POST::sql:UPDATE:${slot}"]);
  });

  it("fails the write inside a wrapper at the wrapper's own write", () => {
    const source = `export async function transition(args: { db: any }) { return args.db.emergencyAccessGrant.updateMany({ data: {} }); }`;
    expect(run(source)).toEqual(["unclassified foothold write (write): src/fixture.ts::transition::emergencyAccessGrant.updateMany"]);
  });

  it("fails a gate called after advisoryXactLock", () => {
    const source = `${GATE_IMPORT}export async function POST(tx: any) {
      await advisoryXactLock(tx, 1);
      await lockFootholdWriter(tx);
      await tx.scimToken.create({ data: {} });
    }`;
    expect(run(source)).toEqual([`${GATE} comes after advisoryXactLock: src/fixture.ts::POST::scimToken.create`]);
  });

  it("fails a gate called after a write in the same callback", () => {
    const source = `${GATE_IMPORT}export async function POST(tx: any) {
      await tx.scimToken.update({ data: {} });
      await lockFootholdWriter(tx);
      await tx.scimToken.create({ data: {} });
    }`;
    expect(run(source)).toContain(`${GATE} comes after a write in its callback: src/fixture.ts::POST::scimToken.create`);
  });

  it("fails a write that precedes its own gate", () => {
    const source = `${GATE_IMPORT}export async function POST(tx: any) {
      await tx.scimToken.create({ data: {} });
      await lockFootholdWriter(tx);
    }`;
    expect(run(source)).toEqual(["unclassified foothold write (write): src/fixture.ts::POST::scimToken.create"]);
  });

  it("fails a gate that is not the shared helper", () => {
    const source = `import { lockFootholdWriter } from "./other";\nexport async function POST(tx: any) {
      await lockFootholdWriter(tx);
      await tx.scimToken.create({ data: {} });
    }`;
    expect(run(source)).toEqual([`${GATE} is not imported from ${GATE_MODULE}: src/fixture.ts::POST::scimToken.create`]);
  });

  it("does not scope writers outside src/", () => {
    const analysis = analyze(
      new Map([["scripts/op.ts", `export async function f(tx: any) { await tx.scimToken.create({ data: {} }); }`]]),
      context,
      { writerScope: inSrc },
    );
    expect(analysis.writers).toEqual([]);
  });
});

describe("foothold member set (reader positive controls)", () => {
  const readers = (source: string, classes: Readonly<Record<string, ReaderClass>> = {}): string[] =>
    evaluateReaders(analyze(new Map([["src/fixture.ts", source]]), context, { writerScope: inSrc }), classes);
  const read = `export async function list(tx: any) { return tx.tenantWebhook.findMany({}); }`;
  const key = "src/fixture.ts::list::tenantWebhook.findMany";

  it("fails an unclassified read", () => {
    expect(readers(read)).toEqual([`unclassified webhook read: ${key}`]);
  });

  it("passes a management read with a reason", () => {
    expect(readers(read, { [key]: { kind: "management", reason: "settings list, delivers nothing" } })).toEqual([]);
  });

  it("fails a classification without a reason", () => {
    expect(readers(read, { [key]: { kind: "management", reason: "" } })).toEqual([`reader class without a reason: ${key}`]);
  });

  it("fails a delivery read whose function has no creator verdict", () => {
    expect(readers(read, { [key]: { kind: "delivery", reason: "fan-out to subscribers" } })).toEqual([
      `delivery read without a creator verdict in its function: ${key}`,
    ]);
  });

  it("passes a delivery read whose function calls creatorVerdicts", () => {
    const source = `export async function list(tx: any) { const r = await tx.tenantWebhook.findMany({}); return creatorVerdicts(tx, r); }`;
    expect(readers(source, { [key]: { kind: "delivery", reason: "fan-out to subscribers" } })).toEqual([]);
  });

  it("fails a stale reader key", () => {
    expect(readers(`export const x = 1;`, { [key]: { kind: "management", reason: "settings list, delivers nothing" } })).toEqual([
      `stale reader key: ${key}`,
    ]);
  });

  it("finds a raw read of tenant_webhooks", () => {
    const source = "export async function list(tx: any) { return tx.$queryRaw`SELECT id FROM tenant_webhooks WHERE 1 = 1`; }";
    expect(readers(source)).toEqual(["unclassified webhook read: src/fixture.ts::list::sql:read:tenant_webhooks"]);
  });

  it("finds a raw read through a templated table slot", () => {
    const source = "export async function list(tx: any, t: string) { return tx.$queryRaw`SELECT id FROM ${t}`; }";
    expect(readers(source)).toEqual(["unclassified webhook read: src/fixture.ts::list::sql:read:${slot}"]);
  });
});

describe("foothold member set (model-set positive controls)", () => {
  const fixture = parseSchema(`model Thing {
  id String @id
  tenantId String @map("tenant_id")
  createdBy User @relation(fields: [createdById], references: [id])
  createdById String
  @@map("things")
}
model Own {
  id String @id
  tenantId String
  user User @relation(fields: [userId], references: [id])
  userId String
}`);

  it("fails a model with a tenantId and a non-subject User relation that is unlisted", () => {
    expect(evaluateModelSet(fixture, [], {})).toEqual(["schema model neither in FOOTHOLD_MODEL nor not-containable: Thing"]);
  });

  it("passes a model listed in FOOTHOLD_MODEL", () => {
    expect(evaluateModelSet(fixture, ["thing"], {})).toEqual([]);
  });

  it("passes a model listed as not containable with a reason", () => {
    expect(evaluateModelSet(fixture, [], { Thing: "a placeholder reason for it" })).toEqual([]);
  });

  it("fails a not-containable entry without a reason and a stale one", () => {
    expect(evaluateModelSet(fixture, [], { Thing: "", Own: "subject-bound only, so stale here" })).toEqual([
      "not-containable entry without a reason: Thing",
      "stale not-containable entry (not a creator-bearing tenant model): Own",
    ]);
  });
});

describe("foothold member set (FK-less uuid positive controls)", () => {
  const fkLess = parseSchema(`model Loose {
  id String @id @db.Uuid
  tenantId String @map("tenant_id") @db.Uuid
  createdById String? @map("created_by_id") @db.Uuid
  keyId String @map("key_id") @db.Uuid
  @@map("loose")
}`);
  const notCandidates = parseSchema(`model Linked {
  id String @id @db.Uuid
  tenantId String @map("tenant_id") @db.Uuid
  createdById String @map("created_by_id") @db.Uuid
  createdBy User @relation(fields: [createdById], references: [id])
}
model Named {
  id String @id @db.Uuid
  tenantId String @map("tenant_id") @db.Uuid
  title String
  slug String @unique
}
model Global {
  id String @id @db.Uuid
  createdById String @db.Uuid
}`);

  it("fails an FK-less uuid column no key names", () => {
    expect(evaluateModelSet(fkLess, [], {}, {})).toEqual([
      "unkeyed FK-less uuid column: Loose.createdById",
      "unkeyed FK-less uuid column: Loose.keyId",
    ]);
  });

  it("fails a creator key whose model is classified nowhere, passes it once listed or not containable", () => {
    const keys = { "Loose.createdById": "creator", "Loose.keyId": "a key reference, names no user" };
    expect(evaluateModelSet(fkLess, [], {}, keys)).toEqual(["schema model neither in FOOTHOLD_MODEL nor not-containable: Loose"]);
    expect(evaluateModelSet(fkLess, ["loose"], {}, keys)).toEqual([]);
    expect(evaluateModelSet(fkLess, [], { Loose: "a creator column on a content model" }, keys)).toEqual([]);
  });

  it("does not require a model to be classified for a column keyed with a non-creator reason", () => {
    const keys = { "Loose.createdById": "recorded for provenance only", "Loose.keyId": "a key reference, names no user" };
    expect(evaluateModelSet(fkLess, [], {}, keys)).toEqual([]);
  });

  it("fails a stale key and a key without a reason", () => {
    const keys = { "Loose.createdById": "creator", "Loose.keyId": "", "Ghost.createdById": "creator" };
    expect(evaluateModelSet(fkLess, ["loose"], {}, keys)).toEqual([
      "FK-less uuid key without a reason: Loose.keyId",
      "stale FK-less uuid key: Ghost.createdById",
    ]);
  });

  it("takes neither an FK column, a non-uuid String, nor a model without a tenantId for a candidate", () => {
    expect(notCandidates.map((m) => m.fkLessUuids)).toEqual([[], [], ["createdById"]]);
    expect(evaluateModelSet(notCandidates, ["linked"], {}, {})).toEqual([]);
  });

  it("derives the real schema's candidates, and the K5/K7 creator columns are among them", () => {
    const candidates = schema.filter((m) => m.hasTenantId).flatMap((m) => m.fkLessUuids.map((f) => `${m.name}.${f}`));
    expect(candidates).toEqual(expect.arrayContaining(["TenantWebhook.createdById", "TeamWebhook.createdById", "AuditDeliveryTarget.createdById"]));
  });
});
