/**
 * A node:http stand-in for the GitHub Releases API, shaped from its documented
 * behaviour (the real API is not reachable from the tests). It models what the
 * destination depends on: releases by tag, assets with a `state`, name
 * uniqueness within a release (422 on a taken name, whatever the holder's
 * state), asset download and asset delete.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeAsset = {
  id: number;
  name: string;
  state: string;
  created_at: string;
  content: Buffer;
};

export type FakeRelease = {
  id: number;
  tag_name: string;
  assets: FakeAsset[];
};

export type FakeGitHub = {
  /** Pass as the destination's `apiBaseUrl`. */
  baseUrl: string;
  releases: FakeRelease[];
  /** Every request, as `METHOD path` without the query string, in order. */
  requests: string[];
  /** Asset ids a DELETE removed, in order. */
  deletedAssetIds: number[];
  /** Runs before each request is answered; a case scripts state changes here. */
  beforeRequest: ((method: string, path: string) => void) | null;
  /** Answer the next asset upload with a 422 although no asset holds the name. */
  rejectNextUpload: boolean;
  /** Answer every asset DELETE with this status instead of deleting. */
  deleteStatus: number | null;
  /** Plant a release, or an asset in it, without going through the API. */
  addRelease(tag: string): FakeRelease;
  addAsset(tag: string, asset: { name: string; state: string; created_at?: string; content?: Buffer }): FakeAsset;
  count(request: string | RegExp): number;
  close(): Promise<void>;
};

const REPO_PATH = "/repos/test-org/test-repo";
export const FAKE_GITHUB_REPO = "test-org/test-repo";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  let nextId = 1;
  const releases: FakeRelease[] = [];

  const assetView = (a: FakeAsset) => ({
    id: a.id,
    name: a.name,
    state: a.state,
    size: a.content.length,
    created_at: a.created_at,
  });
  const releaseView = (r: FakeRelease, host: string) => ({
    id: r.id,
    tag_name: r.tag_name,
    upload_url: `http://${host}/upload/${r.id}/assets{?name,label}`,
    assets: r.assets.map(assetView),
  });
  const findAsset = (id: number) => {
    for (const release of releases) {
      const asset = release.assets.find((a) => a.id === id);
      if (asset) return { release, asset };
    }
    return null;
  };

  const fake: FakeGitHub = {
    baseUrl: "",
    releases,
    requests: [],
    deletedAssetIds: [],
    beforeRequest: null,
    rejectNextUpload: false,
    deleteStatus: null,
    addRelease(tag) {
      const release: FakeRelease = { id: nextId++, tag_name: tag, assets: [] };
      // Newest first, as the API lists them.
      releases.unshift(release);
      return release;
    },
    addAsset(tag, asset) {
      const release = releases.find((r) => r.tag_name === tag) ?? fake.addRelease(tag);
      const stored: FakeAsset = {
        id: nextId++,
        name: asset.name,
        state: asset.state,
        created_at: asset.created_at ?? new Date().toISOString(),
        content: asset.content ?? Buffer.alloc(0),
      };
      release.assets.push(stored);
      return stored;
    },
    count(request) {
      return fake.requests.filter((r) => (typeof request === "string" ? r === request : request.test(r))).length;
    },
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://fake");
      const method = req.method ?? "GET";
      const host = req.headers.host ?? "localhost";
      const path = url.pathname;
      fake.requests.push(`${method} ${path}`);
      fake.beforeRequest?.(method, path);

      if (path === `${REPO_PATH}/releases` && method === "POST") {
        const tag = (JSON.parse(body.toString("utf-8")) as { tag_name: string }).tag_name;
        if (releases.some((r) => r.tag_name === tag)) return json(res, 422, { message: "Validation Failed" });
        return json(res, 201, releaseView(fake.addRelease(tag), host));
      }

      if (path === `${REPO_PATH}/releases` && method === "GET") {
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const slice = releases.slice((page - 1) * perPage, page * perPage);
        return json(res, 200, slice.map((r) => releaseView(r, host)));
      }

      const byTag = path.match(new RegExp(`^${REPO_PATH}/releases/tags/(.+)$`));
      if (byTag && method === "GET") {
        const release = releases.find((r) => r.tag_name === decodeURIComponent(byTag[1]));
        return release ? json(res, 200, releaseView(release, host)) : json(res, 404, { message: "Not Found" });
      }

      const upload = path.match(/^\/upload\/(\d+)\/assets$/);
      if (upload && method === "POST") {
        const release = releases.find((r) => r.id === Number(upload[1]));
        const name = url.searchParams.get("name") ?? "";
        if (!release) return json(res, 404, { message: "Not Found" });
        if (fake.rejectNextUpload) {
          fake.rejectNextUpload = false;
          return json(res, 422, { message: "Validation Failed" });
        }
        if (release.assets.some((a) => a.name === name)) return json(res, 422, { message: "Validation Failed" });
        const asset = fake.addAsset(release.tag_name, { name, state: "uploaded", content: body });
        return json(res, 201, assetView(asset));
      }

      const byId = path.match(new RegExp(`^${REPO_PATH}/releases/assets/(\\d+)$`));
      if (byId && method === "GET") {
        const found = findAsset(Number(byId[1]));
        if (!found) return json(res, 404, { message: "Not Found" });
        if (req.headers.accept === "application/octet-stream") {
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          return res.end(found.asset.content);
        }
        return json(res, 200, assetView(found.asset));
      }
      if (byId && method === "DELETE") {
        if (fake.deleteStatus !== null) return json(res, fake.deleteStatus, { message: "refused" });
        const found = findAsset(Number(byId[1]));
        if (!found) return json(res, 404, { message: "Not Found" });
        found.release.assets.splice(found.release.assets.indexOf(found.asset), 1);
        fake.deletedAssetIds.push(found.asset.id);
        res.writeHead(204);
        return res.end();
      }

      return json(res, 404, { message: "Not Found" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
