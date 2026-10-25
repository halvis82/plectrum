import { resolveLink } from "@/lib/server/resolve";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  try {
    return Response.json(await resolveLink(sp.get("url") ?? "", sp.has("alts")));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not resolve link" }, { status: 400 });
  }
}
