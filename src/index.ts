import type { ExportedHandler } from "@cloudflare/workers-types";
import { STATE_KEY } from "./constants";
import { runOnce } from "./monitor";
import type { Env, WorkerState } from "./types";

const worker: ExportedHandler<Env> = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env, new Date(event.scheduledTime)));
  },
  async fetch(request, env) {
    if (request.method === "POST") {
      const result = await runOnce(env, new Date());
      return Response.json({ ok: true, ...result });
    }

    if (request.method === "GET") {
      const state = await env.EMAIL_STATE.get<WorkerState>(STATE_KEY, "json");
      return Response.json({
        ok: true,
        lastCheck: state?.lastCheck ?? null,
        hashesStored: state?.hashes?.length ?? 0,
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};

export default worker;
