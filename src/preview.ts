import * as fs from "fs";
import * as path from "path";
import * as http from "http";

/** Serve exported root-relative routes on loopback, with no vault access. */
export async function startPreviewServer(root: string): Promise<{server: http.Server; origin: string}> {
  const base = fs.realpathSync(root);
  const types: Record<string,string> = {".html":"text/html; charset=utf-8", ".css":"text/css", ".js":"text/javascript", ".json":"application/json", ".xml":"application/xml", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".gif":"image/gif"};
  const server = http.createServer((req,res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    try {
      const route = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
      let target = path.resolve(base, "." + route);
      if (target !== base && !target.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
      if (fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
      const real = fs.realpathSync(target);
      if (!real.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, {"Content-Type": types[path.extname(real)] || "application/octet-stream", "Cache-Control":"no-store"});
      if (req.method === "HEAD") res.end(); else res.end(fs.readFileSync(real));
    } catch { res.writeHead(404); res.end("Not found"); }
  });
  await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",() => {server.removeListener("error",reject);resolve();}); });
  const addr=server.address() as import("net").AddressInfo;
  return {server,origin:`http://127.0.0.1:${addr.port}`};
}
