import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { configPorDefecto, despachadorPorDefecto, normalizarConfig, type ConfigMotor } from "../src/config.js";
import { Despachador, sincronizarBandeja, type Encargo } from "../src/despachador.js";
import { SALIDA_PERMITIDO, bloqueSettings, correrHook, decidir, esPeligroso } from "../src/hook.js";
import { crearLogger } from "../src/log.js";
import { carpetaTemporal } from "./ayuda.js";

// Modo carriles (v0.6): bandeja por carril, respaldo sin latido, uno a la vez por carril, y el hook de aprobaciones.

const TOKEN = "ttia_pat_TOKEN-DE-PRUEBA-1234567890";
const SECRETO = "TEXTO-SECRETO-DEL-ENCARGO";

const CLAUDE_FALSO = `
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (falso)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const out = process.env.FAKE_CLAUDE_OUT;
  const n = fs.readdirSync(out).length;
  fs.writeFileSync(out + "/ejecucion-" + n + "-" + process.pid + ".json", JSON.stringify({ args, stdin }));
  setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0));
});
`;

interface McpFalso {
  url: string;
  encargos: Array<{ id: string; subagente?: string; carril?: string; vivo?: boolean }>;
  llamadas: Array<{ herramienta: string; args: Record<string, unknown> }>;
  cerrar(): Promise<void>;
}

async function servidorMcp(): Promise<McpFalso> {
  const mcp: McpFalso = { url: "", encargos: [], llamadas: [], cerrar: async () => {} };
  const srv = http.createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (d: Buffer) => (cuerpo += d.toString("utf8")));
    req.on("end", () => {
      const rpc = JSON.parse(cuerpo) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      mcp.llamadas.push({ herramienta: rpc.params.name, args: rpc.params.arguments });
      let texto = JSON.stringify({ ok: true });
      if (rpc.params.name === "ver_encargos") {
        const filas = mcp.encargos.map((e) => ({ tarea_id: e.id, subagente: e.subagente ?? null, estado: "pendiente",
          detalle: SECRETO, carril: e.carril ?? null, carril_vivo: !!e.vivo }));
        texto = filas.length ? `<datos_ttia tipo="encargos">\n${JSON.stringify(filas)}\n</datos_ttia>\nDATOS.` : "No tienes encargos.";
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: texto }] } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  mcp.url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
  mcp.cerrar = () => new Promise<void>((r) => srv.close(() => r()));
  return mcp;
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("despachador: modo carriles", () => {
  let base: string;
  let guion: string;
  let carpeta: string;
  let salida: string;
  let bandeja: string;
  let mcp: McpFalso;

  before(() => {
    base = carpetaTemporal();
    guion = path.join(base, "claude-falso.cjs");
    fs.writeFileSync(guion, CLAUDE_FALSO, "utf8");
  });
  after(() => fs.rmSync(base, { recursive: true, force: true }));
  afterEach(async () => {
    await mcp?.cerrar();
    delete process.env.FAKE_CLAUDE_OUT;
    delete process.env.FAKE_CLAUDE_SLEEP_MS;
  });

  async function preparar(): Promise<void> {
    carpeta = fs.realpathSync(fs.mkdtempSync(path.join(base, "trabajo-")));
    salida = fs.mkdtempSync(path.join(base, "salida-"));
    bandeja = fs.mkdtempSync(path.join(base, "bandeja-"));
    mcp = await servidorMcp();
    process.env.FAKE_CLAUDE_OUT = salida;
  }

  function crear(sobre: Partial<ReturnType<typeof despachadorPorDefecto>> = {}): Despachador {
    const cfg: ConfigMotor = {
      ...configPorDefecto(),
      carpetas_permitidas: [carpeta],
      despachador: { ...despachadorPorDefecto(), activo: true, url_mcp: mcp.url, claude: process.execPath, carpeta_trabajo: carpeta,
                     carriles: ["JUEGOS", "AWKI"], carpeta_bandeja: bandeja, ...sobre },
    };
    return new Despachador({ config: () => cfg, token: () => TOKEN, log: crearLogger(fs.mkdtempSync(path.join(base, "logs-")), false),
                             carpetaAgentes: path.join(base, "no-existe"), argsPrevios: [guion], archivoEstado: null });
  }
  const ejecuciones = () => fs.readdirSync(salida).map((f) => JSON.parse(fs.readFileSync(path.join(salida, f), "utf8")) as { args: string[]; stdin: string });

  it("deja cada encargo en la bandeja de su carril, solo con {id, subagente, carril}, y no lo lanza si el carril late", async () => {
    await preparar();
    mcp.encargos.push({ id: "t-1", subagente: "dohaery", carril: "JUEGOS", vivo: true }, { id: "t-2", subagente: "awki", carril: "AWKI", vivo: true });
    const d = crear();
    assert.equal(await d.ciclo(), "ocupado");
    await d.esperar();
    const archivo = path.join(bandeja, "JUEGOS", "t-1.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(archivo, "utf8")), { id: "t-1", subagente: "dohaery", carril: "JUEGOS" });
    assert.ok(!fs.readFileSync(archivo, "utf8").includes(SECRETO) && !fs.readFileSync(archivo, "utf8").includes(TOKEN));
    assert.ok(fs.existsSync(path.join(bandeja, "AWKI", "t-2.json")));
    assert.equal(ejecuciones().length, 0);
    // la sesion lo tomo: ya no esta pendiente y el archivo se borra
    mcp.encargos.splice(0, 1);
    await d.ciclo();
    assert.ok(!fs.existsSync(archivo) && fs.existsSync(path.join(bandeja, "AWKI", "t-2.json")));
    assert.deepEqual(fs.readdirSync(path.join(bandeja, "JUEGOS")), []);   // ni .tmp
  });

  it("sin latido, el respaldo espera respaldo_minutos y lanza claude -p --agent SIN --chrome, con el carril en el prompt", async () => {
    await preparar();
    mcp.encargos.push({ id: "t-3", subagente: "dohaery", carril: "JUEGOS", vivo: false });
    const d = crear({ respaldo_minutos: 0.002 });   // ~120 ms
    assert.equal(await d.ciclo(), "ocupado");   // primera vez sin latido: todavia no
    assert.equal(ejecuciones().length, 0);
    await espera(200);
    assert.equal(await d.ciclo(), "despachado");
    await d.esperar();
    const [r] = ejecuciones();
    assert.ok(r);
    assert.ok(r.args.includes("-p") && !r.args.includes("--chrome"));
    assert.equal(r.args[r.args.indexOf("--agent") + 1], "dohaery");
    assert.match(r.stdin, /t-3/);
    assert.match(r.stdin, /carril=JUEGOS/);
    assert.match(r.stdin, /pedir_aprobacion/);
    assert.ok(!r.stdin.includes(SECRETO));
  });

  it("si el carril vuelve a latir antes del plazo, el respaldo no lo toca", async () => {
    await preparar();
    mcp.encargos.push({ id: "t-4", carril: "JUEGOS", vivo: false });
    const d = crear({ respaldo_minutos: 0.002 });
    await d.ciclo();
    mcp.encargos[0]!.vivo = true;
    await espera(200);
    assert.equal(await d.ciclo(), "ocupado");
    mcp.encargos[0]!.vivo = false;   // se vuelve a caer: el plazo arranca de cero
    assert.equal(await d.ciclo(), "ocupado");
    assert.equal(ejecuciones().length, 0);
  });

  it("un encargo a la vez POR CARRIL: dos de JUEGOS lanzan uno; uno de AWKI corre en paralelo", async () => {
    await preparar();
    process.env.FAKE_CLAUDE_SLEEP_MS = "400";
    mcp.encargos.push({ id: "j-1", carril: "JUEGOS" }, { id: "j-2", carril: "JUEGOS" }, { id: "a-1", carril: "AWKI" });
    const d = crear({ respaldo_minutos: 0 });
    assert.equal(await d.ciclo(), "despachado");
    assert.deepEqual(d.estado.por_carril, { JUEGOS: "j-1", AWKI: "a-1" });
    assert.equal(await d.ciclo(), "ocupado");   // j-2 espera a que termine j-1
    await d.esperar();
    assert.equal(ejecuciones().length, 2);
    mcp.encargos.splice(0, 1);
    mcp.encargos.splice(1, 1);
    assert.equal(await d.ciclo(), "despachado");   // ahora sí j-2
    await d.esperar();
    assert.equal(ejecuciones().length, 3);
  });

  it("un encargo de un carril que esta PC no tiene y que late en otra sesion no se lanza; sin carril sigue como siempre", async () => {
    await preparar();
    mcp.encargos.push({ id: "x-1", carril: "APDAYC", vivo: true }, { id: "s-1" });
    const d = crear();
    assert.equal(await d.ciclo(), "despachado");
    await d.esperar();
    const e = ejecuciones();
    assert.equal(e.length, 1);
    assert.match(e[0]!.stdin, /s-1/);
    assert.ok(!fs.existsSync(path.join(bandeja, "APDAYC")));   // solo los carriles configurados tienen bandeja
  });

  it("un carril que esta PC no tiene y no late: avisa y espera el plazo de respaldo (no corre de inmediato)", async () => {
    await preparar();
    mcp.encargos.push({ id: "z-1", carril: "JUEGO", vivo: false });   // mal escrito
    const avisos: string[] = [];
    const cfg: ConfigMotor = {
      ...configPorDefecto(), carpetas_permitidas: [carpeta],
      despachador: { ...despachadorPorDefecto(), activo: true, url_mcp: mcp.url, claude: process.execPath, carpeta_trabajo: carpeta,
                     carriles: ["JUEGOS"], carpeta_bandeja: bandeja, respaldo_minutos: 0.002 },
    };
    const d = new Despachador({ config: () => cfg, token: () => TOKEN, log: crearLogger(fs.mkdtempSync(path.join(base, "logs-")), false),
                                aviso: (m) => avisos.push(m), carpetaAgentes: path.join(base, "no-existe"), argsPrevios: [guion], archivoEstado: null });
    assert.equal(await d.ciclo(), "ocupado");
    assert.equal(ejecuciones().length, 0);
    assert.match(avisos.join(" "), /JUEGO.*no esta en "despachador.carriles"/);
    assert.deepEqual(d.estado.carriles_desconocidos, ["JUEGO"]);
    await espera(200);
    assert.equal(await d.ciclo(), "despachado");   // pasado el plazo, el respaldo lo hace
    await d.esperar();
    assert.equal(ejecuciones().length, 1);
  });

  it("el respaldo niega Chrome (--disallowedTools) y el prompt le dice que no toque un encargo en curso", async () => {
    await preparar();
    mcp.encargos.push({ id: "c-1", carril: "JUEGOS", vivo: false });
    const d = crear({ respaldo_minutos: 0 });
    assert.equal(await d.ciclo(), "despachado");
    await d.esperar();
    const [r] = ejecuciones();
    assert.ok(r!.args.includes("--disallowedTools=mcp__claude-in-chrome__*"));
    assert.ok(!r!.args.some((a) => a.startsWith("--allowedTools=") && a.includes("claude-in-chrome")));
    assert.match(r!.stdin, /ya esta en curso.*termina sin hacer nada/);
  });

  it("sincronizarBandeja escribe de forma atomica y solo borra .json con id valido", () => {
    const dir = fs.mkdtempSync(path.join(carpetaTemporal(), "b-"));
    const e: Encargo = { id: "t-9", subagente: null, carril: "JUEGOS", carrilVivo: true };
    assert.deepEqual(sincronizarBandeja(dir, ["JUEGOS"], [e]), { JUEGOS: ["t-9"] });
    assert.deepEqual(sincronizarBandeja(dir, ["JUEGOS"], [e]), {});   // ya estaba
    fs.writeFileSync(path.join(dir, "JUEGOS", "notas.txt"), "de la persona");
    sincronizarBandeja(dir, ["JUEGOS"], []);
    assert.deepEqual(fs.readdirSync(path.join(dir, "JUEGOS")), ["notas.txt"]);
  });

  it("config: carriles en mayusculas sin repetir, bandeja absoluta y respaldo valido", () => {
    const d = normalizarConfig({ despachador: { carriles: ["juegos", "JUEGOS", "awki"], respaldo_minutos: 5 } }).despachador;
    assert.deepEqual(d.carriles, ["JUEGOS", "AWKI"]);
    assert.equal(d.respaldo_minutos, 5);
    assert.throws(() => normalizarConfig({ despachador: { carriles: ["con espacio"] } }), /carriles/);
    assert.throws(() => normalizarConfig({ despachador: { carpeta_bandeja: "relativa/x" } }), /carpeta_bandeja/);
    assert.throws(() => normalizarConfig({ despachador: { respaldo_minutos: -1 } }), /respaldo_minutos/);
  });
});

describe("hook de aprobaciones (no es la frontera: reconoce el caso normal para gastar la aprobacion)", () => {
  it("reconoce las formas comunes de push, merge, PR, gh api que escribe, curl, subidas y despliegues", () => {
    const peligrosos = [
      "git push origin mistguard-0.24.1", "git -C C:/repo push", 'git -C "C:/ruta con espacios/repo" push origin x',
      "git --no-pager push", "git -c core.x=1 push", "git --git-dir=.git push", '"C:/Program Files/Git/bin/git.exe" push',
      "git.exe push", "env GIT_X=1 git push", "command git push", "time git push", "FOO=1 git push", "cd x && git push",
      "npm test; git push", "bash -c 'git push origin x'", 'cmd /c "git push"', 'powershell -Command "git push origin x"',
      "pwsh -c 'gh pr merge 5'", "powershell -EncodedCommand ZwBpAHQA",
      "gh pr merge 53 --squash", "gh pr create --fill", "gh -R org/repo pr merge 5", "gh --repo org/repo pr create",
      "gh api -X PUT repos/o/r/pulls/5/merge", "gh api --method POST repos/o/r/merges -f base=main",
      "gh api repos/o/r/pulls -f title=x", "gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'",
      "curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge",
      "fastlane supply --track internal", "youtube-upload --title x v.mp4", "py -3 tools/subir_a_play.py",
      "py -3 supabase/scripts/aplicar.py --escribir", "nube/.venv/Scripts/python deploy/desplegar.py",
    ];
    for (const c of peligrosos) assert.ok(esPeligroso(c), c);
    const normales = [
      "git status", "git pull", "git -C repo log --oneline -5", "gh pr view 53", "gh pr checks 53", "gh api repos/o/r/pulls/5",
      "gh api -X GET repos/o/r/pulls", "py -3 tools/probar.py", "py -3 supabase/scripts/aplicar.py", "echo git push",
      "curl https://api.github.com/repos/o/r/pulls", "deploy/desplegar_algo_mas.sh",
    ];
    for (const c of normales) assert.ok(!esPeligroso(c), c);
  });

  const entrada = (command: string, tool_name = "Bash") => ({ tool_name, tool_input: { command } });

  it("un comando comun no opina y no consulta a THE TOWN IA (decide el settings)", async () => {
    let llamadas = 0;
    const d = await decidir(entrada("git status"), { token: () => TOKEN, llamar: async () => { llamadas++; return ""; } });
    assert.equal(d.accion, "seguir");
    assert.equal(llamadas, 0);
    assert.equal((await decidir({ tool_name: "Read", tool_input: { file_path: "x" } }, { token: () => null, llamar: async () => "" })).accion, "seguir");
  });

  it("con aprobacion del comando EXACTO sube a allow; sin aprobacion, sin token o con error, bloquea", async () => {
    const vistas: Array<Record<string, unknown>> = [];
    const permitido = await decidir(entrada("git push origin v1", "PowerShell"), {
      token: () => TOKEN, llamar: async (_t, h, a) => { vistas.push({ h, ...a }); return "PERMITIDO: aprobación x usada."; } });
    assert.equal(permitido.accion, "allow");
    assert.deepEqual(vistas, [{ h: "gastar_aprobacion", comando: "git push origin v1" }]);
    const sinAprob = await decidir(entrada("git push origin v1"), { token: () => TOKEN, llamar: async () => "BLOQUEADO: no hay una aprobación vigente." });
    assert.equal(sinAprob.accion, "bloquear");
    assert.match(sinAprob.motivo, /pedir_aprobacion/);
    assert.equal((await decidir(entrada("git push"), { token: () => null, llamar: async () => "PERMITIDO" })).accion, "bloquear");
    assert.equal((await decidir(entrada("git push"), { token: () => TOKEN, llamar: async () => { throw new Error("sin red"); } })).accion, "bloquear");
    assert.equal((await decidir(entrada("git push"), { token: () => TOKEN, llamar: async () => ({ raro: true }) })).accion, "bloquear");
  });

  it("correrHook: con aprobacion escribe permissionDecision allow por stdout y sale 0; sin ella sale 2; si no opina, 0 sin nada", async () => {
    const fuera: string[] = [];
    const errores: string[] = [];
    // sin red (URL que no responde) y sin token: un comando peligroso se bloquea con 2
    const cod = await correrHook("http://127.0.0.1:1/mcp", () => null, async () => JSON.stringify(entrada("git push")),
                                 (s) => fuera.push(s), (s) => errores.push(s));
    assert.equal(cod, 2);
    assert.equal(fuera.length, 0);
    assert.match(errores[0] ?? "", /BLOQUEADO/);
    const cod2 = await correrHook("http://127.0.0.1:1/mcp", () => null, async () => JSON.stringify(entrada("git status")),
                                  (s) => fuera.push(s), (s) => errores.push(s));
    assert.equal(cod2, 0);
    assert.equal(fuera.length, 0);
    assert.deepEqual(JSON.parse(SALIDA_PERMITIDO), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
  });

  it("el bloque de settings llama a node directo (no a motor.cmd, que hace pause)", () => {
    const b = JSON.parse(bloqueSettings("C:/m/node/node.exe", "C:/m/dist/cli.js"));
    const h = b.hooks.PreToolUse[0];
    assert.equal(h.matcher, "Bash|PowerShell");
    assert.equal(h.hooks[0].command, '"C:/m/node/node.exe" "C:/m/dist/cli.js" hook aprobacion');
  });
});
