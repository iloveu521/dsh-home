// dsh-fork-to-preset — host side: HTTP routes for preset listing + fork execution.
// Client side fetches these endpoints (billing pattern).
export const inject = ["webServer"];

export function apply(ctx) {
  // POST /fork-to-preset/presets → list available agent presets
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/fork-to-preset",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      try {
        if (req.method === "POST" && path === "/fork-to-preset/presets") {
          const presets = ctx.get("agentPresets");
          if (!presets) {
            sendJson(res, 200, { presets: [] });
            return;
          }
          const list = await presets.list();
          sendJson(res, 200, {
            presets: list.map((p) => ({
              id: p.id,
              name: p.name || p.id,
              description: p.description || "",
              isDefault: p.id === presets.defaultId,
            })),
          });
          return;
        }
        sendJson(res, 404, { error: "not-found" });
      } catch (e) {
        sendJson(res, 500, { error: e.message || String(e) });
      }
    },
  }), "dsh-fork-to-preset: routes");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body) + "\n");
}