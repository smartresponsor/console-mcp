import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(required(args, "root"));
const host = required(args, "host");
const port = Number.parseInt(required(args, "port"), 10);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Invalid port.");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "text/plain; charset=utf-8", "Method Not Allowed\n", { Allow: "GET, HEAD" });
      return;
    }

    if (url.pathname === "/health") {
      send(res, 200, "application/json; charset=utf-8", `${JSON.stringify({ ok: true, root, host, port })}\n`);
      return;
    }

    const resolved = resolveRequestPath(url.pathname);
    if (!resolved.ok) {
      send(res, 403, "text/plain; charset=utf-8", "Forbidden\n");
      return;
    }

    if (resolved.relative.endsWith("/today") || resolved.relative === "today") {
      const redirected = await resolveTodayRedirect(resolved.absolute, resolved.relative);
      if (redirected) {
        res.writeHead(302, { Location: redirected, "Cache-Control": "no-store" });
        res.end();
        return;
      }
    }

    if (!existsSync(resolved.absolute)) {
      send(res, 404, "text/plain; charset=utf-8", "Not Found\n");
      return;
    }

    const entryStat = await stat(resolved.absolute);
    if (entryStat.isDirectory()) {
      const body = await renderDirectory(url.pathname, resolved.absolute);
      send(res, 200, "text/html; charset=utf-8", body);
      return;
    }

    if (!entryStat.isFile()) {
      send(res, 404, "text/plain; charset=utf-8", "Not Found\n");
      return;
    }

    await serveFile(req.method === "HEAD", res, resolved.absolute);
  } catch (error) {
    send(res, 500, "text/plain; charset=utf-8", `Gallery error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});

server.listen(port, host, () => {
  console.log(`visual-gallery listening on http://${host}:${port}/ root=${root}`);
});

function parseArgs(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

function required(values, name) {
  const value = values[name];
  if (!value) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}

function resolveRequestPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false };
  }

  const relative = decoded.replace(/^\/+/, "").replaceAll("/", path.sep);
  const absolute = path.resolve(root, relative);
  const rootComparable = `${root.toLowerCase()}${path.sep}`;
  const absoluteComparable = absolute.toLowerCase();
  if (absoluteComparable !== root.toLowerCase() && !absoluteComparable.startsWith(rootComparable)) {
    return { ok: false };
  }
  return { ok: true, absolute, relative: relative.replaceAll(path.sep, "/") };
}

async function resolveTodayRedirect(absolute, relative) {
  const manifestPath = path.join(absolute, "manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (typeof manifest.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.date)) {
      return null;
    }
    const component = relative.split("/")[0];
    if (typeof manifest.run_id === "string" && /^[A-Za-z0-9_.-]+$/.test(manifest.run_id)) {
      return `/${encodeURIComponent(component)}/${manifest.date}/${encodeURIComponent(manifest.run_id)}/`;
    }
    return `/${encodeURIComponent(component)}/${manifest.date}/`;
  } catch {
    return null;
  }
}

async function renderDirectory(requestPath, absolute) {
  const entries = (await readdir(absolute, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return right.name.localeCompare(left.name);
    });

  const normalized = requestPath.endsWith("/") ? requestPath : `${requestPath}/`;
  const cards = [];
  for (const entry of entries) {
    if (entry.name === "manifest.json") {
      continue;
    }
    const href = `${normalized}${encodeURIComponent(entry.name)}${entry.isDirectory() ? "/" : ""}`;
    if (entry.isDirectory()) {
      cards.push(`<a class="folder" href="${escapeHtml(href)}"><strong>${escapeHtml(entry.name)}</strong><span>folder</span></a>`);
      continue;
    }

    if (isImage(entry.name)) {
      cards.push(`<a class="shot" href="${escapeHtml(href)}"><img loading="lazy" src="${escapeHtml(href)}" alt="${escapeHtml(entry.name)}"><span>${escapeHtml(entry.name)}</span></a>`);
      continue;
    }

    cards.push(`<a class="file" href="${escapeHtml(href)}">${escapeHtml(entry.name)}</a>`);
  }

  const parent = normalized === "/" ? null : normalized.split("/").filter(Boolean).slice(0, -1);
  const parentHref = parent ? `/${parent.map(encodeURIComponent).join("/")}${parent.length ? "/" : ""}` : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Visual Gallery ${escapeHtml(normalized)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f5f5f7;color:#111}
header{position:sticky;top:0;background:rgba(245,245,247,.92);backdrop-filter:blur(14px);padding:14px 18px;border-bottom:1px solid #ddd;z-index:2}
header h1{font-size:18px;margin:0 0 6px;word-break:break-all}
header a{color:#06c;text-decoration:none}
main{padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
.folder,.shot,.file{display:flex;flex-direction:column;background:#fff;border-radius:14px;overflow:hidden;text-decoration:none;color:#111;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.folder,.file{padding:18px;min-height:68px;justify-content:center}
.folder span{font-size:12px;color:#777;margin-top:5px}
.shot img{width:100%;height:210px;object-fit:cover;background:#eee}
.shot span{font-size:12px;padding:10px;word-break:break-all}
@media(max-width:600px){main{grid-template-columns:repeat(2,minmax(0,1fr));padding:10px;gap:10px}.shot img{height:180px}}
</style>
</head>
<body>
<header><h1>${escapeHtml(normalized)}</h1>${parentHref ? `<a href="${escapeHtml(parentHref)}">← Back</a>` : "<span>Local visual artifacts</span>"}</header>
<main>${cards.join("") || "<p>No artifacts yet.</p>"}</main>
</body>
</html>`;
}

async function serveFile(headOnly, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
  }[ext];

  if (!mime) {
    send(res, 415, "text/plain; charset=utf-8", "Unsupported Media Type\n");
    return;
  }

  const fileStat = await stat(filePath);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": String(fileStat.size),
    "Cache-Control": ext === ".json" ? "no-store" : "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function isImage(name) {
  return /\.(png|jpe?g|webp|gif)$/i.test(name);
}

function send(res, status, contentType, body, extra = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
