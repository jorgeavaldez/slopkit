import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { object, string } from "../src/schema.ts";

const cliModule = new URL("../src/server/cli.ts", import.meta.url).href;
const storeModule = new URL("../src/server/store.ts", import.meta.url).href;
export const NAME = "notebook";
export const VERSION_ONE = "1.0.0";
export const VERSION_TWO = "1.1.0";
export const VERSION_MIGRATED = "2.0.0";
const children = new Set<ChildProcess>();
const scratch: string[] = [];

export async function directory() {
  const home = await mkdtemp(join(tmpdir(), "slopkit-cli-"));
  scratch.push(home);

  return home;
}

export type Exit = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string };

export function launch(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  let err = "";
  let ended = false;

  const waits = new Set<{
    pattern: RegExp;
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }>();

  const finished = new Promise<Exit>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);

      for (const wait of waits) {
        const found = out
          .split("\n")
          .slice(0, -1)
          .find((line) => wait.pattern.test(line));

        if (found !== undefined) {
          waits.delete(wait);
          wait.resolve(found);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.once("close", (code, signal) => {
      ended = true;
      children.delete(child);

      for (const wait of waits) {
        wait.reject(new Error(`process exited before ${wait.pattern}: ${code}\n${out}\n${err}`));
      }

      waits.clear();
      resolve({ code, signal, out, err });
    });
  });

  return {
    child,
    finished,
    output: () => out,
    line: (pattern: RegExp): Promise<string> => {
      const found = out
        .split("\n")
        .slice(0, -1)
        .find((line) => pattern.test(line));

      if (found !== undefined) {
        return Promise.resolve(found);
      }

      if (ended) {
        return Promise.reject(new Error(`process already exited: ${out}\n${err}`));
      }

      return new Promise<string>((resolve, reject) => {
        waits.add({ pattern, resolve, reject });
      });
    },
    stop: (signal: NodeJS.Signals = "SIGTERM") => {
      if (!ended) {
        child.kill(signal);
      }

      return finished;
    },
  };
}

function execute(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return launch(command, args, env).finished;
}

function source(schema: number, behavior: "ok" | "throw" | "degraded") {
  return `#!/usr/bin/env node
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, askUpdate, beginUpdate, recoverUpdate, settleAskedUpdates } from ${JSON.stringify(cliModule)};
import { SyncStore } from ${JSON.stringify(storeModule)};
const root = new URL('./', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const VERSION = pkg.version;
const SCHEMA = { base: 'create table notes(id text primary key, value text not null, deleted integer not null default 0, revision integer not null) strict;', replicated: ['notes'], baseVersion: 1, migrations: ${JSON.stringify(schema === 1 ? [] : ["alter table notes add column extra text;"])}, indexes: '' };
const open = home => new SyncStore(join(home, 'notebook.sqlite'), { name: 'notebook', schema: SCHEMA });
const jobsFor = store => store.createJobs({ encode: JSON.stringify, decode: JSON.parse });
const options = {
  name: 'notebook', root, schema: ${schema}, serves: 'fixture notes.',
  ...(process.env.NOTEBOOK_PROVEN_MS ? { provenAfterMs: Number(process.env.NOTEBOOK_PROVEN_MS) } : {}),
  commands: {
    custom: { usage: 'custom <words>', help: 'writes fixture arguments', run: async (args, home) => { writeFileSync(join(home, 'custom.json'), JSON.stringify(args)); return 7; } },
    seed: { usage: 'seed <id> <value>', help: 'seeds fixture notes', run: async (args, home) => {
      mkdirSync(home, { recursive: true, mode: 0o700 }); const store = open(home); store.transaction(() => { const revision = store.stamp(); store.db.prepare('insert into notes(id,value,revision) values (?,?,?)').run(args[0], args[1], revision); }); store.close(); return 0;
    } },
    'hold-wal': { usage: 'hold-wal', help: 'keeps fixture WAL live', run: async (args, home) => {
      const store = open(home);
      store.db.exec('pragma wal_autocheckpoint=0');
      // A signal listener alone cannot keep Node alive; retain the Store through an active server.
      const holder = createServer((_request, response) => response.end(String(store.revision())));
      await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
      try {
        store.transaction(() => {
          const revision = store.stamp();
          store.db.prepare('insert into notes(id,value,revision) values (?,?,?)').run('wal-only', 'kept from WAL', revision);
        });
        const stopped = new Promise(resolve => { process.once('SIGTERM', resolve); });
        console.log('fixture WAL kept');
        await stopped;
      } finally {
        await new Promise(resolve => holder.close(resolve));
        store.close();
      }
      return 0;
    } },
  },
  serve: async ({ home, version, say, web, env, update }) => {
    if (${JSON.stringify(behavior)} === 'throw') { throw new Error("fixture won't start"); }
    const store = open(home); const jobs = jobsFor(store);
    jobs.interrupt(job => recoverUpdate(job, version)); settleAskedUpdates(jobs);
    const config = (() => { try { return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')); } catch { return {}; } })();
    const observeEnvironment = phase => {
      if (config.environmentProof) { appendFileSync(config.environmentProof, JSON.stringify({ phase, version, home, mark: process.env.SLOPKIT_BOOT_CHECK ?? null, contextMark: env.SLOPKIT_BOOT_CHECK ?? null }) + '\\n'); }
    };
    observeEnvironment('serve');
    const rows = store.db.prepare('select id,value from notes order by id').all();
    if (config.proof) { appendFileSync(config.proof, JSON.stringify({ version, home, env: Object.keys(env).sort(), rows, web, pid: process.pid }) + '\\n'); }
    let releaseReady; const gate = new Promise(resolve => { releaseReady = resolve; });
    const apiRequests = [];
    const server = createServer((request, response) => {
      if (request.url === '/requests') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(apiRequests)); return; }
      if (request.url === '/' && config.doorRefused) { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ kind: 'signed-out' })); return; }
      if (request.url === '/api/') {
        const host = request.headers.host;
        apiRequests.push({ path: request.url, method: request.method, host, address: request.socket.localAddress, accept: request.headers.accept, cookie: request.headers.cookie, authorization: request.headers.authorization });
        const publicHost = web.host ? web.host.name + (web.host.https ? '' : ':' + (web.port === 0 ? server.address().port : web.port)) : undefined;
        const localHost = new URL(url).host;
        response.statusCode = host !== localHost && host !== publicHost ? 421 : host === publicHost ? (config.publicApiStatus ?? 401) : (config.apiStatus ?? 401);
        if (response.statusCode === 302) { response.setHeader('location', '/unexpected'); }
        if (config.logRequests) { say('info', 'fixture request refused', { host }); }
        const body = host === publicHost ? (config.publicApiBody ?? config.apiBody) : config.apiBody;
        response.setHeader('content-type', 'application/json'); response.end(body ?? JSON.stringify({ kind: 'signed-out' })); return;
      }
      if (request.url === '/gate') { response.end('released'); releaseReady(); return; }
      if (request.url === '/stop-start') { response.end('update requested'); update(); return; }
      if (request.url === '/update') { const asked = askUpdate(jobs, config.release || 'edge', version, { client: 'fixture_page', id: 1 }); response.on('finish', () => update()); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(asked)); return; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ version, rows, pid: process.pid }));
    });
    const bind = web.bind ?? '127.0.0.1';
    await new Promise(resolve => server.listen(0, bind, resolve)); const address = server.address();
    const local = bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
    const urlHost = config.urlHost ?? local;
    const url = 'http://' + (urlHost.includes(':') ? '[' + urlHost + ']' : urlHost) + ':' + address.port;
    if (config.manualReady) { console.log('fixture waiting · ' + url); await gate; }
    if (${JSON.stringify(behavior)} === 'degraded') { console.log('notebook degraded: web off: fixture cannot serve'); }
    say('info', 'fixture started', { version }); console.log('fixture serving ' + version + ' · ' + url + ' · ' + process.pid);
    let extra;
    return { ...(config.withoutUrl ? {} : { url }),
      // Without configured work this remains an older app's no-start return, for the existing install checks.
      ...(config.startProvider || config.startProof || config.startPort !== undefined || config.startFailure || config.holdStart || config.environmentProof ? { start: () => {
        observeEnvironment('start');
        if (config.startFailure === 'throw') { throw new Error('fixture start threw'); }
        return (async () => {
          if (config.holdStart) {
            process.once('SIGTERM', () => console.log('fixture stop noticed'));
            console.log('fixture start held · ' + url);
            await gate;
          }
          if (config.startProvider) {
            const target = new URL(config.startProvider); target.searchParams.set('version', version); target.searchParams.set('home', home);
            const reply = await fetch(target, { method: 'POST' });
            if (!reply.ok) { throw new Error('fixture provider refused start'); }
          }
          if (config.startPort !== undefined) {
            extra = createServer((_request, response) => response.end('app work listener ' + version));
            await new Promise((resolve, reject) => { extra.once('error', reject); extra.listen(config.startPort, '127.0.0.1', resolve); });
          }
          if (config.startFailure === 'reject') { throw new Error('fixture start rejected'); }
          if (config.startProof) { appendFileSync(config.startProof, JSON.stringify({ version, home }) + '\\n'); }
        })();
      } } : {}),
      claim: () => { const claimed = beginUpdate(jobs, version); appendFileSync(join(home, 'events.jsonl'), JSON.stringify({ event: 'claim', claimed, state: claimed ? jobs.get(claimed.id)?.state : null }) + '\\n'); return claimed; },
      close: async () => { const open = jobs.open('update')[0]; appendFileSync(join(home, 'events.jsonl'), JSON.stringify({ event: 'close', state: open?.state, ...(config.holdStart ? { serving: existsSync(join(home, 'serving.json')) } : {}) }) + '\\n'); if (extra?.listening) { await new Promise(resolve => extra.close(resolve)); } await new Promise(resolve => server.close(resolve)); store.close(); say('info', 'fixture stopped'); if (config.holdStart) { console.log('fixture held start closed'); } },
    };
  },
};
const args = process.argv.slice(2);
if (process.env.NOTEBOOK_PROBE_LOOP === '1' && args[0] === 'probe') {
  let active = true; process.once('SIGTERM', () => { active = false; });
  console.log('fixture probing');
  while (active) { await runCli(args, options); await new Promise(resolve => setImmediate(resolve)); }
} else {
  process.exitCode = await runCli(args, options);
}
`;
}

export type Release = { version: string; schema: number; tarball: string; package: string };

export async function pack(
  parent: string,
  version: string,
  schema = 1,
  behavior: "ok" | "throw" | "degraded" = "ok"
): Promise<Release> {
  const root = join(parent, `source-${version}`);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: NAME,
      version,
      type: "module",
      homepage: "https://github.com/fixture/notebook",
      bin: { notebook: "bin.js" },
      files: ["bin.js", "install.js"],
      scripts: { postinstall: "node install.js" },
    })
  );
  await writeFile(join(root, "bin.js"), source(schema, behavior), { mode: 0o755 });

  await writeFile(
    join(root, "install.js"),
    `
import { readFileSync } from 'node:fs';
const barrier = process.env.NOTEBOOK_INSTALL_BARRIER;
if (barrier && process.env.npm_config_prefix === process.env.NOTEBOOK_BLOCK_PREFIX) {
  const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
  const url = new URL(barrier);
  url.searchParams.set('version', version);
  url.searchParams.set('prefix', process.env.npm_config_prefix);
  const reply = await fetch(url, { method: 'POST' });
  if (!reply.ok) { throw new Error('fixture installation barrier refused'); }
}
`
  );

  const packed = await execute(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", parent, root],
    { PATH: process.env.PATH, HOME: parent, NPM_CONFIG_CACHE: join(parent, "cache") }
  );

  if (packed.code !== 0) {
    throw new Error(`fixture pack failed: ${packed.err}`);
  }

  return { version, schema, tarball: join(parent, `${NAME}-${version}.tgz`), package: root };
}

export async function mirror(releases: Map<string, Release>) {
  const requests: { method: string; path: string }[] = [];

  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ method: request.method ?? "GET", path });
    const matched = /^\/(edge|v[^/]+)\/notebook\.tgz$/.exec(path);
    const release = matched?.[1] === undefined ? undefined : releases.get(matched[1]);

    if (!release) {
      response.writeHead(404);
      response.end("no such fixture release");

      return;
    }

    const bytes = readFileSync(release.tarball);
    response.writeHead(200, { "content-type": "application/gzip", "content-length": bytes.length });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address union is decoded at this loopback I/O boundary
  if (address === null || typeof address === "string") {
    throw new Error("missing mirror address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((_resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            _resolve();
          }
        });
      });
    },
  };
}

export async function installed(release: Release, releaseUrl: string) {
  const base = await directory();
  const home = join(base, "home");
  const user = join(base, "user");
  const prefix = join(base, "prefix");
  // runCli, not the fixture, must create the application home.
  await mkdir(user);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: user,
    NOTEBOOK_HOME: home,
    NOTEBOOK_RELEASES: releaseUrl,
    NPM_CONFIG_CACHE: join(base, "cache"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    FIXTURE_POISON: "must never enter boot check",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
  };

  const result = await execute(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      release.tarball,
    ],
    env
  );

  if (result.code !== 0) {
    throw new Error(`fixture install failed: ${result.err}`);
  }

  const bin = join(prefix, "bin", NAME);
  const root = join(prefix, "lib", "node_modules", NAME);

  return {
    base,
    home,
    user,
    prefix,
    root,
    bin,
    env,
    run: (args: string[], extra: NodeJS.ProcessEnv = {}) =>
      execute(bin, args, { ...env, ...extra }),
    start: (extra: NodeJS.ProcessEnv = {}) => launch(bin, ["serve"], { ...env, ...extra }),
    package: async () =>
      object({ version: string() }).parse(
        JSON.parse(await readFile(join(root, "package.json"), "utf-8"))
      ),
  };
}

export async function cleanup() {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill("SIGKILL");
        })
    )
  );

  await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function installGate() {
  const entered = Promise.withResolvers<{ version: string; prefix: string }>();
  let held: ServerResponse | undefined;

  const release = () => {
    const response = held;
    held = undefined;
    response?.end("continue");
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    held = response;
    entered.resolve(
      object({ version: string(), prefix: string() }).parse({
        version: url.searchParams.get("version"),
        prefix: url.searchParams.get("prefix"),
      })
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address union is decoded at this loopback I/O boundary
  if (address === null || typeof address === "string") {
    throw new Error("missing installation barrier address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/install`,
    entered: entered.promise,
    release,
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
