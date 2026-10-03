import { pubkeyFromSeed } from "./stub-flair.js";

export function startFetchFlair(seeds: Record<string, Buffer>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).pathname;
    if (path === "/Health") return new Response("ok");
    const match = path.match(/^\/Agent\/(.+)$/);
    if (match && seeds[decodeURIComponent(match[1]!)]) {
      const name = decodeURIComponent(match[1]!);
      return Response.json({ id: name, name, publicKey: pubkeyFromSeed(seeds[name]!).toString("base64") });
    }
    return Response.json([]);
  }) as typeof fetch;
  return { url: "http://flair.test", stop: () => { globalThis.fetch = previous; } };
}
