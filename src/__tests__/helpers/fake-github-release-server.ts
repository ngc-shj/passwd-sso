/**
 * A node:http stand-in for the GitHub Releases API, shaped from its documented
 * behaviour (the real API is not reachable from the tests). It models what the
 * destination depends on: releases by tag, assets with a `state`, name
 * uniqueness within a release (422 on a taken name, whatever the holder's
 * state), asset download and asset delete.
 *
 * An asset download is documented as "either redirect or stream directly", so
 * by default it answers 302 to a second listener — another origin — that
 * serves the bytes; `downloadRedirect = false` streams them directly.
 *
 * What it assumes of the real API and cannot verify:
 *   - the `assets` array embedded in a list or by-tag release is complete;
 *   - the `state` values: `uploaded` for an asset with content, anything else
 *     for a name held without it;
 *   - a name reservation carries the `created_at` of its upload's start;
 *   - deleting an asset that never finished uploading answers 204.
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
  /** The `Authorization` header of the latest API request. */
  apiAuthorization: string | undefined;
  /** Answer an asset download with a redirect to the download listener (default) or with the bytes. */
  downloadRedirect: boolean;
  /** Every request the download listener received, with the `Authorization` header it carried. */
  downloads: Array<{ path: string; authorization: string | undefined }>;
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
    apiAuthorization: undefined,
    downloadRedirect: true,
    downloads: [],
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
    close: async () => {
      for (const listener of [server, downloadServer]) {
        await new Promise<void>((resolve, reject) => listener.close((err) => (err ? reject(err) : resolve())));
      }
    },
  };

  // Where a redirected download lands: its own port, so another origin.
  const downloadServer = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    fake.downloads.push({ path, authorization: req.headers.authorization });
    const found = findAsset(Number(path.match(/^\/download\/(\d+)$/)?.[1]));
    if (!found) return json(res, 404, { message: "Not Found" });
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(found.asset.content);
  });
  let downloadOrigin = "";

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
      fake.apiAuthorization = req.headers.authorization;
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
          if (fake.downloadRedirect) {
            res.writeHead(302, { Location: `${downloadOrigin}/download/${found.asset.id}` });
            return res.end();
          }
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

  const listen = (listener: http.Server) =>
    new Promise<string>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(listener.address() as AddressInfo).port}`));
    });
  fake.baseUrl = await listen(server);
  downloadOrigin = await listen(downloadServer);
  return fake;
}
