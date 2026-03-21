import type { LoaderFunctionArgs } from "@remix-run/node";

/** Used by Render (and others) for health checks — no auth. */
export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
