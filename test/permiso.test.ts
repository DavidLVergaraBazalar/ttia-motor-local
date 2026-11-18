import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { hookDeSettings, settingsCarril } from "../src/carril.js";
import { llamarMcp } from "../src/despachador.js";
import { bloqueSettings } from "../src/hook.js";
import {
  ENTRADA_MAX, TIMEOUT_HOOK_S, armarPedido, canonico, correrHookPermiso, intervaloMs, llamadasEnTranscript, pedirYEsperar,
  rutaTranscript, salidaPermiso, vigiaTranscript, type DepsPermiso, type Pedido,
} from "../src/permiso.js";
import { carpetaTemporal } from "./ayuda.js";

const ENV = { TTIA_CARRIL: "apdayc" } as NodeJS.ProcessEnv;
const BASH = { command: "cd ~/repos/OBSIDIAN-SECOND-BRAIN; git pull; wc -l estado-actual.md", description: "Traer el vault" };
/** Lo que manda Claude Code 2.1.327 (copiado de la prueba del 18-nov con `claude -p`, rutas cambiadas). */
function entradaCC(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "d53b481c-3820-4d12-90f6-b83009f54391", transcript_path: "C:\\t\\proj\\d53b481c-3820-4d12-90f6-b83009f54391.jsonl",
    cwd: "D:\\CODE APD\\_carriles\\APDAYC", permission_mode: "default", hook_event_name: "PermissionRequest",
    tool_name: "Bash", tool_input: BASH,
    permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: BASH.command }], behavior: "allow", destination: "localSettings" }],
    ...extra,
  };
}

describe("permiso: qué se manda a THE TOWN IA", () => {
  it("arma el pedido con la llamada exacta, la carpeta, el motivo y el subagente", () => {
    const { pedido } = armarPedido(entradaCC({ agent_id: "a37", agent_type: "apdayc" }), ENV);
    assert.deepEqual(pedido, { carril: "APDAYC", herramienta: "Bash", entrada: JSON.stringify(BASH),
      carpeta: "D:\\CODE APD\\_carriles\\APDAYC", motivo: "Traer el vault", subagente: "apdayc" });
  });

  it("sin carril, carril raro, herramientas que ya preguntan, sin input o demasiado grande: no se manda", () => {
    assert.equal(armarPedido(entradaCC(), {}).pedido, null);
    assert.equal(armarPedido(entradaCC(), { TTIA_CARRIL: "con espacio" }).pedido, null);
    for (const t of ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]) assert.equal(armarPedido(entradaCC({ tool_name: t }), ENV).pedido, null);
    assert.equal(armarPedido(entradaCC({ tool_name: "Bash; rm" }), ENV).pedido, null);
    assert.equal(armarPedido(entradaCC({ tool_input: "git pull" }), ENV).pedido, null);
    assert.equal(armarPedido(entradaCC({ tool_input: { content: "x".repeat(ENTRADA_MAX) } }), ENV).pedido, null);
    assert.ok(armarPedido(entradaCC({ tool_name: "mcp__awki__ver_cliente", tool_input: { id: 1 } }), ENV).pedido);
  });

  it("salida: allow y deny en el formato de PermissionRequest; local no opina", () => {
    assert.deepEqual(JSON.parse(salidaPermiso({ accion: "allow", motivo: "" }) ?? ""),
      { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    assert.deepEqual(JSON.parse(salidaPermiso({ accion: "deny", motivo: "no" }) ?? ""),
      { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } });
    assert.equal(salidaPermiso({ accion: "local", motivo: "x" }), null);
  });

  it("no satura el límite del MCP: 5 s los primeros 2 min, luego 10 s", () => {
    assert.equal(intervaloMs(0), 5_000);
    assert.equal(intervaloMs(119_999), 5_000);
    assert.equal(intervaloMs(120_000), 10_000);
  });
});

describe("permiso: ¿ya se respondió en la terminal?", () => {
  const usoLinea = (id: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
  const resultadoLinea = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

  it("encuentra la llamada aunque cambie el orden de las claves, y sus resultados", () => {
    const jsonl = [usoLinea("t1", BASH), "basura {", usoLinea("t2", { description: BASH.description, command: BASH.command }),
      usoLinea("t3", { command: "otra" }), resultadoLinea("t1")].join("\n");
    const r = llamadasEnTranscript(jsonl, "Bash", BASH);
    assert.deepEqual(r.usos, ["t1", "t2"]);
    assert.ok(r.conResultado.has("t1") && !r.conResultado.has("t2"));
    assert.equal(canonico({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("anota las abiertas la primera vez y dice «sí» cuando todas tienen resultado", () => {
    const dir = carpetaTemporal();
    const archivo = path.join(dir, "s.jsonl");
    fs.writeFileSync(archivo, [usoLinea("viejo", BASH), resultadoLinea("viejo")].join("\n") + "\n");
    const vigia = vigiaTranscript(archivo, "Bash", BASH);
    assert.equal(vigia(), false);   // la del pedido todavía no está escrita
    fs.appendFileSync(archivo, usoLinea("nuevo", BASH) + "\n");
    assert.equal(vigia(), false);   // la anota
    assert.equal(vigia(), false);   // sigue sin resultado
    fs.appendFileSync(archivo, resultadoLinea("nuevo") + "\n");
    assert.equal(vigia(), true);
    assert.equal(vigiaTranscript(path.join(dir, "no-existe.jsonl"), "Bash", BASH)(), false);
    assert.equal(vigiaTranscript(null, "Bash", BASH)(), false);
  });

  it("el transcript de un subagente está en <sesion>/subagents/agent-<id>.jsonl", () => {
    assert.equal(rutaTranscript(entradaCC()), "C:\\t\\proj\\d53b481c-3820-4d12-90f6-b83009f54391.jsonl");
    assert.equal(rutaTranscript(entradaCC({ agent_id: "a3744566af3440a4f" })),
      path.join("C:\\t\\proj", "d53b481c-3820-4d12-90f6-b83009f54391", "subagents", "agent-a3744566af3440a4f.jsonl"));
    assert.equal(rutaTranscript(entradaCC({ agent_id: "../../x" })), "C:\\t\\proj\\d53b481c-3820-4d12-90f6-b83009f54391.jsonl");
    assert.equal(rutaTranscript({}), null);
  });
});

/** Un THE TOWN IA de mentira con la secuencia de estados que devuelve ver_permiso. */
function falso(estados: Array<string | Error>, opc: { pedir?: string | Error; gastar?: string; terminal?: () => boolean } = {}) {
  const llamadas: Array<{ h: string; a: Record<string, unknown> }> = [];
  let t = 0;
  const deps: DepsPermiso = {
    llamar: async (h, a) => {
      llamadas.push({ h, a });
      if (h === "pedir_permiso") {
        if (opc.pedir instanceof Error) throw opc.pedir;
        return opc.pedir ?? `PEDIDO ${JSON.stringify({ aprobacion_id: "ap-1", vence_en: new Date(30 * 60_000).toISOString() })}`;
      }
      if (h === "ver_permiso") {
        const e = estados.shift() ?? "PENDIENTE";
        if (e instanceof Error) throw e;
        return e;
      }
      if (h === "gastar_permiso") return opc.gastar ?? "PERMITIDO: permiso ap-1 usado.";
      return "CANCELADA";
    },
    dormir: async (ms) => { t += ms; },
    ahora: () => t,
    respondidaEnTerminal: opc.terminal ?? (() => false),
  };
  return { deps, llamadas, nombres: () => llamadas.map((x) => x.h) };
}
const PEDIDO: Pedido = { carril: "APDAYC", herramienta: "Bash", entrada: JSON.stringify(BASH) };

describe("permiso: esperar la decisión de la web", () => {
  it("aprobada: la gasta con la MISMA llamada y responde allow", async () => {
    const f = falso(["PENDIENTE", "PENDIENTE", "APROBADA"]);
    const r = await pedirYEsperar(PEDIDO, f.deps);
    assert.equal(r.accion, "allow");
    const g = f.llamadas.find((x) => x.h === "gastar_permiso");
    assert.deepEqual(g?.a, { aprobacion_id: "ap-1", herramienta: "Bash", entrada: PEDIDO.entrada });
  });

  it("rechazada: deny con un mensaje para la sesión", async () => {
    const r = await pedirYEsperar(PEDIDO, falso(["RECHAZADA"]).deps);
    assert.equal(r.accion, "deny");
    assert.match(r.motivo, /rechazó en THE TOWN IA/);
  });

  it("todo lo demás cae en la terminal (nunca allow por defecto)", async () => {
    for (const e of ["VENCIDA", "CANCELADA", "USADA", "DESCONOCIDA: no es tuyo", "RARO"]) {
      assert.equal((await pedirYEsperar(PEDIDO, falso([e]).deps)).accion, "local", e);
    }
    assert.equal((await pedirYEsperar(PEDIDO, falso([], { pedir: "LOCAL: sin encargo" }).deps)).accion, "local");
    assert.equal((await pedirYEsperar(PEDIDO, falso([], { pedir: new Error("ECONNREFUSED") }).deps)).accion, "local");
    assert.equal((await pedirYEsperar(PEDIDO, falso([], { pedir: "PEDIDO {roto" }).deps)).accion, "local");
    assert.equal((await pedirYEsperar(PEDIDO, falso(["APROBADA"], { gastar: "BLOQUEADO: la llamada no es la que se aprobó." }).deps)).accion, "local");
  });

  it("sin red un rato sigue esperando; cinco errores seguidos, cancela y cae en la terminal", async () => {
    const caida = new Error("HTTP 429");
    assert.equal((await pedirYEsperar(PEDIDO, falso([caida, caida, "APROBADA"]).deps)).accion, "allow");
    const f = falso([caida, caida, caida, caida, caida]);
    assert.equal((await pedirYEsperar(PEDIDO, f.deps)).accion, "local");
    assert.equal(f.nombres().at(-1), "cancelar_permiso");
  });

  it("si la persona respondió en la terminal, cancela la tarjeta y no opina", async () => {
    let vueltas = 0;
    const f = falso([], { terminal: () => ++vueltas >= 3 });
    const r = await pedirYEsperar(PEDIDO, f.deps);
    assert.equal(r.accion, "local");
    assert.match(r.motivo, /terminal/);
    assert.deepEqual(f.nombres(), ["pedir_permiso", "ver_permiso", "ver_permiso", "cancelar_permiso"]);
  });

  it("deja de esperar al vencer (o al tope) y cancela", async () => {
    const f = falso([]);
    const r = await pedirYEsperar(PEDIDO, f.deps, 60_000);
    assert.equal(r.accion, "local");
    assert.equal(f.nombres().at(-1), "cancelar_permiso");
    assert.ok(f.nombres().filter((n) => n === "ver_permiso").length <= 12);
  });
});

describe("permiso: el hook de punta a punta contra un MCP de mentira por HTTP", () => {
  async function servidor(responder: (h: string, a: Record<string, unknown>) => string) {
    const vistos: Array<{ h: string; a: Record<string, unknown>; auth: string }> = [];
    const srv = http.createServer((req, res) => {
      let cuerpo = "";
      req.on("data", (d: Buffer) => (cuerpo += d.toString("utf8")));
      req.on("end", () => {
        const rpc = JSON.parse(cuerpo) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
        vistos.push({ h: rpc.params.name, a: rpc.params.arguments, auth: String(req.headers.authorization ?? "") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: responder(rpc.params.name, rpc.params.arguments) }] } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
    return { url, vistos, cerrar: () => new Promise<void>((r) => srv.close(() => r())) };
  }
  const TOKEN = "ttia_pat_prueba_de_mentira";

  it("aprobada en la web: imprime allow; la entrada viaja tal cual", async () => {
    let n = 0;
    const s = await servidor((h) => h === "pedir_permiso" ? `PEDIDO ${JSON.stringify({ aprobacion_id: "ap-9", vence_en: new Date(Date.now() + 1_800_000).toISOString() })}`
      : h === "ver_permiso" ? (++n < 2 ? "PENDIENTE" : "APROBADA") : h === "gastar_permiso" ? "PERMITIDO: permiso ap-9 usado." : "CANCELADA");
    const fuera: string[] = [];
    try {
      const cod = await correrHookPermiso((t, h, a) => llamarMcp(s.url, t, h, a, 5_000), () => TOKEN,
        async () => JSON.stringify(entradaCC()), (x) => fuera.push(x), () => {}, ENV, async () => {});
      assert.equal(cod, 0);
      assert.deepEqual(JSON.parse(fuera[0] ?? ""), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
      assert.deepEqual(s.vistos.map((v) => v.h), ["pedir_permiso", "ver_permiso", "ver_permiso", "gastar_permiso"]);
      assert.equal(s.vistos[0]?.a.entrada, JSON.stringify(BASH));
      assert.equal(s.vistos[0]?.a.carril, "APDAYC");
      assert.ok(s.vistos.every((v) => v.auth === `Bearer ${TOKEN}`));
    } finally {
      await s.cerrar();
    }
  });

  it("servidor caído, sin token o sin carril: sale 0 sin decidir (decide la terminal)", async () => {
    for (const [token, env] of [[TOKEN, ENV], [null, ENV], [TOKEN, {}]] as Array<[string | null, NodeJS.ProcessEnv]>) {
      const fuera: string[] = [];
      const cod = await correrHookPermiso((t, h, a) => llamarMcp("http://127.0.0.1:1/mcp", t, h, a, 2_000), () => token,
        async () => JSON.stringify(entradaCC()), (x) => fuera.push(x), () => {}, env, async () => {});
      assert.equal(cod, 0);
      assert.deepEqual(fuera, []);
    }
    assert.equal(await correrHookPermiso(async () => "x", () => TOKEN, async () => "no es json", () => {}, () => {}, ENV), 0);
  });
});

describe("permiso: carril instalar lo deja en el settings", () => {
  const base = {
    carril: "PRUEBA", perfil: "apdayc" as const,
    node: "C:\\Program Files\\Mi Motor ñ\\node\\node.exe", cli: "C:\\Program Files\\Mi Motor ñ\\dist\\cli.js",
    carpetaCarril: "D:\\Carriles Ó\\PRUEBA", carpetaMotor: "C:\\Program Files\\Mi Motor ñ",
    carpetaDatos: "C:\\Users\\Ana\\AppData\\Roaming\\AwkiOffice",
  };

  it("PermissionRequest para todas las herramientas, con node directo, y las herramientas del hook negadas a la sesión", () => {
    const s = settingsCarril(base) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>>; permissions: { deny: string[] }; env: Record<string, string> };
    const g = s.hooks.PermissionRequest?.[0];
    assert.equal(g?.matcher, "*");
    assert.equal(g?.hooks[0]?.command, `"${base.node}" "${base.cli}" hook permiso`);
    assert.equal(g?.hooks[0]?.timeout, TIMEOUT_HOOK_S);
    assert.ok(TIMEOUT_HOOK_S * 1000 > 29.5 * 60_000, "el timeout del settings es mayor que la espera del hook");
    assert.equal(s.env.TTIA_CARRIL, "PRUEBA");   // de ahí saca el carril el hook
    for (const d of ["mcp__ttia__pedir_permiso", "mcp__ttia__ver_permiso", "mcp__ttia__gastar_permiso", "mcp__ttia__cancelar_permiso"]) {
      assert.ok(s.permissions.deny.includes(d), d);
    }
    assert.ok(JSON.parse(bloqueSettings("C:/n.exe", "C:/c.js")).hooks.PermissionRequest);
  });

  it("carril estado distingue un settings de la 0.7 (sin permisos) de uno de la 0.8", () => {
    const dir = carpetaTemporal();
    const nuevo = path.join(dir, "nuevo.json");
    fs.writeFileSync(nuevo, JSON.stringify(settingsCarril(base)));
    assert.deepEqual(hookDeSettings(nuevo), { hay: true, node: base.node, permiso: true });
    const viejo = path.join(dir, "viejo.json");
    const s = settingsCarril(base) as { hooks: Record<string, unknown> };
    delete s.hooks.PermissionRequest;
    fs.writeFileSync(viejo, JSON.stringify(s));
    assert.equal(hookDeSettings(viejo).permiso, false);
  });
});
