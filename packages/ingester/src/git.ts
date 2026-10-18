// マシンの git を呼ぶ。作業ツリーは作らず、bare のリポジトリに tag の commit だけを浅く取る。

import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}

export type TreeEntry = {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  readonly size: number | undefined; // blob 以外は undefined
  readonly path: string;
};

// 資格情報を使わせない。手元の設定（~/.gitconfig）も読ませない。
const ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
};

export type GitOptions = {
  readonly timeoutMs: number;
  // https のほかに許すプロトコル。テストで file を使うためだけにある。
  readonly allowProtocols?: readonly string[];
};

export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions,
  stdin?: string,
): Promise<Buffer> {
  const protocols = ["https", ...(options.allowProtocols ?? [])];
  const full = [
    "-c",
    "protocol.allow=never",
    ...protocols.flatMap((p) => ["-c", `protocol.${p}.allow=always`]),
    "-c",
    "credential.helper=",
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("git", full, {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...ENV },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new GitError(args, signal === null ? Buffer.concat(err).toString() : `killed by ${signal}`));
    });
    child.stdin.end(stdin);
  });
}

// `git ls-tree -r -l -z` の出力。
export function parseLsTree(out: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  // パスが UTF-8 でなければ TypeError（呼ぶ側で bad_path にする）。
  for (const record of new TextDecoder("utf-8", { fatal: true }).decode(out).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, object, size] = record.slice(0, tab).split(/ +/) as [string, string, string, string];
    entries.push({ mode, type, object, size: size === "-" ? undefined : Number(size), path: record.slice(tab + 1) });
  }
  return entries;
}

// `git cat-file --batch` の出力を、求めた順の中身に分ける。
export function parseCatFileBatch(out: Buffer, count: number): Buffer[] {
  const blobs: Buffer[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const nl = out.indexOf(0x0a, at);
    const header = out.subarray(at, nl).toString();
    const [, type, size] = header.split(" ");
    if (type !== "blob" || size === undefined) throw new Error(`unexpected cat-file header \`${header}\``);
    const start = nl + 1;
    blobs.push(out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
}
