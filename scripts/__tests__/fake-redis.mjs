// An in-memory Redis server with the commands the integration runner's Redis
// claim sends, for its unit tests: logical databases, connected clients and
// their selected database, and the claim/release scripts evaluated as the
// server would (each runs atomically, as here).
import { CLAIM_SCRIPT, RELEASE_SCRIPT } from "../run-integration-tests.mjs";

export class FakeRedis {
  constructor({ databases = 16 } = {}) {
    this.databases = databases;
    this.dbs = new Map();
    this.clients = new Map();
    this.nextId = 1;
  }

  db(index) {
    if (!this.dbs.has(index)) this.dbs.set(index, new Map());
    return this.dbs.get(index);
  }

  /** A client that never sends a command: only its selected database shows (CLIENT LIST). */
  attach(db) {
    const id = this.nextId++;
    this.clients.set(id, { db });
    return id;
  }

  /** A connection with the keeper shape scratchRedisLifecycle uses. */
  connect() {
    const id = this.attach(0);
    return {
      call: async (...args) => this.exec(id, args.map(String)),
      lost: () => false,
      close: async () => {
        this.clients.delete(id);
      },
    };
  }

  exec(id, [cmd, ...args]) {
    const self = this.clients.get(id);
    const db = this.db(self.db);
    const verb = cmd.toUpperCase();
    switch (verb === "CLIENT" || verb === "CONFIG" ? `${verb} ${args[0].toUpperCase()}` : verb) {
      case "CLIENT ID":
        return id;
      case "CLIENT LIST":
        return [...this.clients].map(([cid, c]) => `id=${cid} addr=127.0.0.1:1 name= db=${c.db} cmd=client|list\n`).join("");
      case "CONFIG GET":
        return ["databases", String(this.databases)];
      case "SELECT":
        self.db = Number(args[0]);
        return "OK";
      case "GET":
        return db.get(args[0]) ?? null;
      case "EVAL": {
        const [script, , key, value] = args;
        if (script === CLAIM_SCRIPT) {
          if (db.size !== 0) return 0;
          db.set(key, value);
          return 1;
        }
        if (script === RELEASE_SCRIPT) {
          if (db.get(key) !== value) return 0;
          db.clear();
          return 1;
        }
        throw new Error("unexpected script");
      }
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  }
}
