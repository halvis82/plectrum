import { resolveLink } from "@/lib/server/resolve";

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url") ?? "";
  try {
    return Response.json(await resolveLink(url));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not resolve link" }, { status: 400 });
  }
}
