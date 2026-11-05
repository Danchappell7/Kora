// ============================================================
// KANBO — the real database driver against PGlite.
//
// PGlite's own query() leaves a text parameter to ::jsonb alone; postgres.js,
// which the edge functions use, doesn't. So the suite runs every request through
// postgres@3.4.5 and db.ts's createApiDb, over the wire protocol: a small TCP
// bridge hands whole protocol messages to PGlite's execProtocolRaw. Faults that
// only the driver shows up can't hide here.
//
// `max: 1` because PGlite is one session. A handler that used the service
// connection while holding a user transaction would hang here, as it could under
// load on the live pool, so that shows up too.
// ============================================================
import net from "node:net";
import postgres from "npm:postgres@3.4.5";
import { createApiDb, type ApiDb } from "../../functions/_shared/api/db.ts";
import { PG_TYPES } from "../../functions/_shared/api/pgTypes.ts";

interface RawPg { execProtocolRaw(message: Uint8Array, opts?: { throwOnError?: boolean }): Promise<Uint8Array> }

export interface DriverDb { db: ApiDb; close(): Promise<void> }

/** How much of `buf` is whole protocol messages (the startup message has no type byte). */
function wholeMessages(buf: Buffer, started: boolean): number {
  let at = 0;
  if (!started) {
    if (buf.length < 4) return 0;
    const n = buf.readUInt32BE(0);
    if (buf.length < n) return 0;
    at = n;
  }
  while (buf.length >= at + 5) {
    const n = buf.readUInt32BE(at + 1);
    if (buf.length < at + 1 + n) break;
    at += 1 + n;
  }
  return at;
}

export async function driverDb(pg: unknown): Promise<DriverDb> {
  const raw = pg as RawPg;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let started = false;
    let chain: Promise<void> = Promise.resolve();
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const n = wholeMessages(buf, started);
      if (!n) return;
      const whole = Uint8Array.from(buf.subarray(0, n));
      buf = buf.subarray(n);
      started = true;
      chain = chain.then(async () => {
        if (whole[0] === 0x58 && whole.length === 5) { sock.end(); return; } // Terminate: PGlite stays open for the suite
        const out = await raw.execProtocolRaw(whole, { throwOnError: false });
        if (out?.length) sock.write(Buffer.from(out));
      }).catch((e) => { console.error(`bridge: ${(e as Error).message}`); sock.destroy(); });
    });
    sock.on("error", () => undefined);
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  // db.ts's own options, apart from the address and max
  const sql = postgres({
    host: "127.0.0.1", port, user: "postgres", database: "postgres", password: "x", ssl: false,
    prepare: false, max: 1, idle_timeout: 0, connect_timeout: 10, types: PG_TYPES,
  } as unknown as Parameters<typeof postgres>[0]);
  return {
    db: createApiDb(sql),
    async close() {
      await sql.end({ timeout: 1 }).catch(() => undefined);
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
