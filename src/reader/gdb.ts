// Minimal GDB remote-serial-protocol client for Eden's built-in GDB stub.
// All-stop mode: while the guest is running, the stub only listens for an
// interrupt (0x03), so every read is halt → read → continue.
import net from "node:net";

const checksum = (s: string) => {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum = (sum + s.charCodeAt(i)) & 0xff;
  return sum.toString(16).padStart(2, "0");
};

export class GdbClient {
  private sock!: net.Socket;
  private buf = "";
  private waiters: ((pkt: string) => void)[] = [];
  running = false;

  constructor(private host = "127.0.0.1", private port = 6543) {}

  async connect() {
    this.sock = net.createConnection({ host: this.host, port: this.port });
    this.sock.setNoDelay(true);
    this.sock.setEncoding("latin1");
    await new Promise<void>((res, rej) => {
      this.sock.once("connect", res);
      this.sock.once("error", rej);
    });
    this.sock.on("data", (d: string) => this.onData(d));
    await this.command("qSupported:multiprocess+;xmlRegisters=i386;qRelocInsn+");
    // Eden halts the guest until a debugger attaches, so it starts out stopped.
    await this.command("?");
  }

  private onData(d: string) {
    this.buf += d;
    for (;;) {
      this.buf = this.buf.replace(/^[+-]+/, "");
      const start = this.buf.indexOf("$");
      const end = this.buf.indexOf("#", start);
      if (start < 0 || end < 0 || this.buf.length < end + 3) return;
      const body = this.buf.slice(start + 1, end);
      this.buf = this.buf.slice(end + 3);
      this.sock.write("+");
      this.waiters.shift()?.(unescape(body));
    }
  }

  private next(timeoutMs = 5000) {
    return new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error("gdb: timeout")), timeoutMs);
      this.waiters.push((p) => { clearTimeout(t); res(p); });
    });
  }

  async command(cmd: string, timeoutMs?: number) {
    const reply = this.next(timeoutMs);
    this.sock.write(`$${cmd}#${checksum(cmd)}`);
    return reply;
  }

  async halt() {
    if (!this.running) return;
    const stop = this.next();
    this.sock.write("\x03");
    await stop;
    this.running = false;
  }

  resume() {
    // 'c' has no reply until the next stop, so don't wait on it.
    this.sock.write(`$c#${checksum("c")}`);
    this.running = true;
  }

  /** Read guest virtual memory; addr as bigint to keep 64-bit precision. */
  async readRaw(addr: bigint, len: number): Promise<Buffer> {
    const out: Buffer[] = [];
    const CHUNK = 0x800;
    for (let off = 0; off < len; off += CHUNK) {
      const n = Math.min(CHUNK, len - off);
      const r = await this.command(`m${(addr + BigInt(off)).toString(16)},${n.toString(16)}`);
      if (/^E[0-9a-f]{2}$/i.test(r)) throw new Error(`gdb: read 0x${(addr + BigInt(off)).toString(16)} failed (${r})`);
      out.push(Buffer.from(r, "hex"));
    }
    return Buffer.concat(out);
  }

  /** Halt, run fn, resume (if it was running before). */
  async paused<T>(fn: () => Promise<T>): Promise<T> {
    const wasRunning = this.running;
    await this.halt();
    try { return await fn(); } finally { if (wasRunning) this.resume(); }
  }

  /** `monitor <cmd>` via qRcmd; Eden's "get info" reports module and heap bases. */
  async monitor(cmd: string) {
    const r = await this.command("qRcmd," + Buffer.from(cmd).toString("hex"));
    return r.startsWith("O") ? Buffer.from(r.slice(1), "hex").toString() : Buffer.from(r, "hex").toString();
  }

  close() { this.sock.destroy(); }
}

// RSP binary escaping: '}' followed by byte ^ 0x20. Run-length ('*') is not
// used for 'm' replies in practice but handle it anyway.
function unescape(s: string) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "}") out += String.fromCharCode(s.charCodeAt(++i) ^ 0x20);
    else if (c === "*") out += out[out.length - 1].repeat(s.charCodeAt(++i) - 29);
    else out += c;
  }
  return out;
}
