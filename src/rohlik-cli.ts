import { join } from "node:path";
import { Rohlik } from "./rohlik.ts";
import { Store } from "./store.ts";

// Rohlík sign-in and tool list from a shell, for checking the allowlist after Rohlík changes its server:
//   node src/rohlik-cli.ts login              prints the link to open
//   node src/rohlik-cli.ts code '<address>'   finishes with the address the browser ended on
//   node src/rohlik-cli.ts tools              lists every tool the server offers, allowed ones marked
// Uses KESHA_DATA_DIR (default ./data). In the container the login goes through the chat instead: !rohlik login

const dir = process.env.KESHA_DATA_DIR ?? "./data";
const store = new Store(join(dir, "kesha.sqlite"), "UTC");
// ROHLIK_DEBUG=1 prints every failed HTTP answer, e.g. why the identity server refused a code
const debugFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!res.ok) console.error(`${init?.method ?? "GET"} ${String(input instanceof Request ? input.url : input)} → ${res.status} ${await res.clone().text()}`);
  return res;
};
const rohlik = new Rohlik(store, process.env.ROHLIK_DEBUG ? { fetch: debugFetch } : {});
const [command, arg] = process.argv.slice(2);

try {
  if (command === "login") {
    console.log(`Open this, sign in, then run: node src/rohlik-cli.ts code '<the address the browser ended on>'\n\n${await rohlik.startLogin()}`);
  } else if (command === "code" && arg) {
    await rohlik.finishLogin(arg);
    console.log("Signed in to Rohlík.");
  } else if (command === "tools") {
    const allowed = new Set((await rohlik.tools()).map((t) => t.name));
    for (const t of await rohlik.listAllTools()) {
      console.log(`${allowed.has(t.name) ? "[allowed] " : ""}${t.name}: ${(t.description ?? "").split("\n")[0]}`);
      if (process.env.VERBOSE) console.log(JSON.stringify(t.inputSchema), "\n");
    }
  } else {
    console.log("usage: node src/rohlik-cli.ts login | code '<address>' | tools");
    process.exitCode = 2;
  }
} finally {
  store.db.close();
}
process.exit();
