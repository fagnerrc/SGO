// Shared CORS handling for every Edge Function in this project.
// Functions under _shared/ are never deployed as their own endpoint —
// Supabase's convention for code shared between functions.
//
// Browsers send a preflight OPTIONS request before any cross-origin POST
// with a JSON body, and refuse to expose the real response unless it (and
// the OPTIONS response) carry Access-Control-Allow-Origin. curl/Node's
// fetch never do this preflight dance, which is exactly why every earlier
// round of testing against these functions (curl, and the Node-based QA
// scripts) never caught this — only a real browser enforces it. Found by
// testing supabase/src/ against the live project through an actual
// browser, not by any prior automated check.

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
