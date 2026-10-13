import { z } from "zod";
import { hasValidSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { runTurn } from "@/lib/tally/agent";

// One turn with Tally, streamed to the chat page as newline-delimited JSON
// events (src/lib/tally/agent.ts): "waiting" while the model wakes, text
// as it's written, tools as they run, proposals to approve.
//
// A cold start alone can take ~4 minutes, so this gets the full 5.
export const maxDuration = 300;

const body = z.object({ conversationId: z.uuid().nullable(), text: z.string().trim().min(1).max(4_000) });

export async function POST(request: Request) {
  // The proxy checked the cookie's signature; this checks the session is
  // still live (signed out, revoked), as every owner action does.
  if (!(await hasValidSession())) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Expected { conversationId, text }" }, { status: 400 });

  // Tally's writes are always proposals (a single insert), so the plain
  // HTTP driver is enough — no transaction held open through a cold start.
  const turn = runTurn(getDb(), parsed.data);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await turn.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    },
    async cancel() {
      await turn.return(undefined);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
