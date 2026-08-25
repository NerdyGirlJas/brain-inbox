import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const KEY = "root-system-data";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const store = getStore("root-restore-system");

  if (req.method === "GET") {
    const data = await store.get(KEY, { type: "text" });
    return new Response(data ?? "null", {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  if (req.method === "POST") {
    const body = await req.text();
    await store.set(KEY, body);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
};
