/**
 * Server HTML for SSR tests: `react-dom/static` prerender, which waits for every Suspense
 * boundary and returns the complete document.
 *
 * Uses `prerenderToNodeStream`: under Node, `react-dom/static` resolves to its Node build, which
 * only gained the web-stream `prerender` in React 19.2. The node-stream variant exists from 19.0
 * (the declared react floor), so the same tests run at the floor and at the dev version.
 */

import type { ReactNode } from "react";
import { prerenderToNodeStream } from "react-dom/static";

export async function prerenderHtml(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(node);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
