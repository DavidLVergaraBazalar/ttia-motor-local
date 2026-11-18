import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import {
  argsAbrir, carpetaRespaldoPorDefecto, estadoMcpClaude, formasAbsolutas, instalarCarril, jsonMcp, planInstalarEnMotor,
  destinosReales, parsearRepos, planQuitarDeMotor, quitarCarril, registrarMcp, settingsCarril, validarCarpetaCarril, validarToken, PROMPT_CARRIL,
  type Correr, type DepsInstalar,
} from "../src/carril.js";
import { normalizarConfig, rutaConfig } from "../src/config.js";
import { carpetaTemporal } from "./ayuda.js";

// v0.7: `motor-local carril instalar | abrir | estado | quitar`. Rutas con espacios y tildes, motor.json sin
// despachador, carril ya existente y token rechazado (simulado: nunca se llama a THE TOWN IA de verdad).

const TOKEN = "ttia_pat_TOKEN-DE-PRUEBA-1234567890";
const TOKEN_VIEJO = "ttia_pat_TOKEN-VIEJO-0987654321";

function fetchFalso(validos: string[]): { f: typeof fetch; llamadas: Array<{ auth: string; cuerpo: string }> } {
  const llamadas: Array<{ auth: string; cuerpo: string }> = [];
  const f = (async (_url: unknown, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).authorization);
    llamadas.push({ auth, cuerpo: String(init?.body) });
    if (!validos.some((t) => auth === `Bearer ${t}`)) return new Response("no", { status: 401 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, llamadas };
}

function correrFalso(respuestas: Array<{ codigo: number; salida: string }> = []): { correr: Correr; llamadas: Array<{ exe: string; args: string[]; entrada: string }> } {
  const llamadas: Array<{ exe: string; args: string[]; entrada: string }> = [];
  const correr: Correr = async (exe, args, entrada) => {
    llamadas.push({ exe, args, entrada });
    return respuestas.shift() ?? { codigo: 0, salida: "Added http MCP server ttia to user config" };
  };
  return { correr, llamadas };
}

describe("carril instalar: motor.json", () => {
  const tmp = carpetaTemporal();
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const carpeta = path.join(tmp, "Mis carriles ñandú", "PRUEBA Ó");

  it("motor.json sin despachador: lo crea con el carril, respaldo propio, chrome apagado y conserva todo lo demás", () => {
    const crudo = { carpetas_permitidas: ["C:\\Otra Cosa"], origenes: ["https://ttia.awki.ai"], modelo: "m", workspace: null, extra: { a: 1 } };
    const p = planInstalarEnMotor(crudo, "PRUEBA", carpeta, carpetaRespaldoPorDefecto(carpeta));
    const d = p.crudo.despachador as Record<string, unknown>;
    assert.equal(d.activo, true);
    assert.deepEqual(d.carriles, ["PRUEBA"]);
    assert.equal(d.chrome, false);
    assert.equal(d.carpeta_trabajo, path.join(tmp, "Mis carriles ñandú", "_respaldo"));
    assert.deepEqual(d.carpetas_carriles, { PRUEBA: carpeta });
    assert.deepEqual(p.crudo.carpetas_permitidas, ["C:\\Otra Cosa", carpeta, path.join(tmp, "Mis carriles ñandú", "_respaldo")]);
    assert.deepEqual(p.crudo.extra, { a: 1 });
    assert.equal(p.crudo.modelo, "m");
    assert.deepEqual(crudo.carpetas_permitidas, ["C:\\Otra Cosa"], "no muta el original");
    assert.ok(p.cambios.includes("despachador: creado"));
    // la carpeta de respaldo nunca es la del carril ni la primera permitida
    assert.notEqual(d.carpeta_trabajo, carpeta);
    assert.notEqual(d.carpeta_trabajo, "C:\\Otra Cosa");
  });

  it("carril ya existente y otro carril: no duplica, no pisa los demás ni la carpeta de respaldo propia", () => {
    const respaldoPropio = path.join(tmp, "respaldo propio");
    const crudo = {
      carpetas_permitidas: [tmp],
      despachador: { activo: true, carriles: ["APDAYC"], carpeta_trabajo: respaldoPropio, chrome: false, herramientas_permitidas: ["Read"], max_minutos: 30 },
    };
    const p1 = planInstalarEnMotor(crudo, "APDAYC", path.join(tmp, "APDAYC"), carpetaRespaldoPorDefecto(path.join(tmp, "APDAYC")));
    const d1 = p1.crudo.despachador as Record<string, unknown>;
    assert.deepEqual(d1.carriles, ["APDAYC"]);
    assert.equal(d1.carpeta_trabajo, respaldoPropio);
    assert.deepEqual(d1.herramientas_permitidas, ["Read"]);
    assert.equal(d1.max_minutos, 30);
    assert.deepEqual(p1.crudo.carpetas_permitidas, [tmp], "ya cubiertas por la carpeta padre");

    const p2 = planInstalarEnMotor(p1.crudo, "JUEGOS", path.join(tmp, "JUEGOS"), carpetaRespaldoPorDefecto(path.join(tmp, "JUEGOS")));
    assert.deepEqual((p2.crudo.despachador as Record<string, unknown>).carriles, ["APDAYC", "JUEGOS"]);
    assert.equal(Object.keys((p2.crudo.despachador as Record<string, Record<string, string>>).carpetas_carriles ?? {}).length, 2);

    const p3 = planInstalarEnMotor(p2.crudo, "juegos", path.join(tmp, "JUEGOS"), carpetaRespaldoPorDefecto(path.join(tmp, "JUEGOS")));
    assert.deepEqual(p3.cambios, [], "reinstalar lo mismo no cambia nada");
  });

  it("si la carpeta de respaldo es la del carril (o la contiene), se cambia por una propia", () => {
    const crudo = { carpetas_permitidas: [], despachador: { carpeta_trabajo: tmp } };
    const p = planInstalarEnMotor(crudo, "PRUEBA", carpeta, carpetaRespaldoPorDefecto(carpeta));
    assert.equal((p.crudo.despachador as Record<string, unknown>).carpeta_trabajo, carpetaRespaldoPorDefecto(carpeta));
    assert.ok(p.cambios.some((c) => /contiene la carpeta de un carril/.test(c)));
  });

  it("quitar saca el carril y su carpeta del mapa, deja los demás", () => {
    const crudo = { despachador: { carriles: ["A", "B"], carpetas_carriles: { A: "C:\\a", B: "C:\\b" } } };
    const { crudo: nuevo, estaba } = planQuitarDeMotor(crudo, "A");
    assert.equal(estaba, true);
    assert.deepEqual((nuevo.despachador as Record<string, unknown>).carriles, ["B"]);
    assert.deepEqual((nuevo.despachador as Record<string, unknown>).carpetas_carriles, { B: "C:\\b" });
    assert.equal(planQuitarDeMotor({}, "A").estaba, false);
  });

  it("repos del carril en motor.json: --repos los reemplaza, sin --repos se conservan, quitar los saca", () => {
    const repos = ["C:\\Code\\Repo Á", "D:\\otro"];
    const p1 = planInstalarEnMotor({}, "PRUEBA", carpeta, carpetaRespaldoPorDefecto(carpeta), repos);
    assert.deepEqual((p1.crudo.despachador as Record<string, unknown>).repos_carriles, { PRUEBA: repos });
    assert.deepEqual(p1.repos, repos);
    assert.ok(p1.cambios.some((c) => /repos_carriles\.PRUEBA/.test(c)));
    const p2 = planInstalarEnMotor(p1.crudo, "prueba", carpeta, carpetaRespaldoPorDefecto(carpeta));
    assert.deepEqual(p2.repos, repos, "sin --repos (reinstalar con --forzar) se conservan");
    assert.equal(p2.cambios.length, 0);
    const p3 = planInstalarEnMotor(p2.crudo, "PRUEBA", carpeta, carpetaRespaldoPorDefecto(carpeta), ["E:\\nuevo"]);
    assert.deepEqual(p3.repos, ["E:\\nuevo"]);
    assert.deepEqual(normalizarConfig(p3.crudo).despachador.repos_carriles, { PRUEBA: ["E:\\nuevo"] });
    const { crudo } = planQuitarDeMotor(p3.crudo, "PRUEBA");
    assert.deepEqual((crudo.despachador as Record<string, unknown>).repos_carriles, {});
    assert.throws(() => normalizarConfig({ despachador: { repos_carriles: { X: ["relativa"] } } }), /repos_carriles/);
    assert.throws(() => normalizarConfig({ despachador: { repos_carriles: { X: "C:\\a" } } }), /repos_carriles/);
  });

  it("normalizarConfig valida carpetas_carriles", () => {
    assert.deepEqual(normalizarConfig({ despachador: { carpetas_carriles: { juegos: "C:\\x y" } } }).despachador.carpetas_carriles, { JUEGOS: "C:\\x y" });
    assert.throws(() => normalizarConfig({ despachador: { carpetas_carriles: { JUEGOS: "relativa" } } }), /carpetas_carriles/);
  });

  it("la carpeta del carril no puede ser un disco, tu carpeta de usuario ni ~/.claude", () => {
    assert.throws(() => validarCarpetaCarril("C:\\", tmp), /disco/);
    assert.throws(() => validarCarpetaCarril(tmp, tmp), /usuario/);
    assert.throws(() => validarCarpetaCarril(path.join(tmp, ".claude", "x"), tmp), /\.claude/);
    assert.throws(() => validarCarpetaCarril("relativa", tmp), /ruta completa/);
  });
});

describe("carril instalar: .claude/settings.json", () => {
  const base = {
    carril: "PRUEBA",
    node: "C:\\Program Files\\Mi Motor ñ\\node\\node.exe",
    cli: "C:\\Program Files\\Mi Motor ñ\\dist\\cli.js",
    carpetaCarril: "D:\\Carriles Ó\\PRUEBA",
    carpetaMotor: "C:\\Program Files\\Mi Motor ñ",
    carpetaDatos: "C:\\Users\\Ana\\AppData\\Roaming\\AwkiOffice",
  };

  it("generico: hook con node y cli absolutos (nunca motor.cmd), allow solo formas exactas, deny de lo sensible", () => {
    const s = settingsCarril({ ...base, perfil: "generico" }) as { permissions: Record<string, string[]>; hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }; env: Record<string, string> };
    const cmd = s.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
    assert.equal(cmd, `"${base.node}" "${base.cli}" hook aprobacion`);
    assert.ok(!/motor\.cmd/i.test(JSON.stringify(s)));
    assert.equal(s.hooks.PreToolUse[0]?.matcher, "Bash|PowerShell");
    const { allow, ask, deny } = s.permissions as { allow: string[]; ask: string[]; deny: string[] };
    assert.ok(allow.includes("Bash(motor-local latido PRUEBA)"));
    assert.ok(allow.includes(`Bash("${base.node}" "${base.cli}" latido PRUEBA)`));
    for (const a of allow) assert.ok(!/push|merge|gh api|commit|PowerShell|^Bash$|Bash\(\*/.test(a), `allow peligroso: ${a}`);
    for (const a of ["Bash(git push*)", "Bash(gh pr merge*)", "Bash(gh api*)", "Bash(git commit*)"]) assert.ok(ask.includes(a), a);
    for (const d of ["Edit(.git/hooks/**)", "Edit(.git/config)", "Edit(~/.gitconfig)", "Edit(~/.claude/**)", "Edit(.claude/settings*.json)", "mcp__claude-in-chrome__*",
      "mcp__ttia__gastar_aprobacion", "Read(~/.claude.json)", "Edit(~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/**)"]) {
      assert.ok(deny.includes(d), d);
    }
    // Claude Code ignora Write(ruta) (solo mira Edit(ruta)) y nunca hace coincidir la forma //C:/ (probado el 18-nov).
    assert.ok(!deny.some((d) => d.startsWith("Write(")), "sin reglas Write(ruta): Claude Code las ignora");
    assert.ok(!deny.some((d) => /\/\/[A-Za-z]:\//.test(d)), "sin la forma //C:/");
    // Monitor con el nombre pelado en allow deja correr cualquier comando sin ask ni hook.
    assert.ok(!allow.includes("Monitor"), "Monitor no va en allow");
    for (const f of formasAbsolutas(base.carpetaMotor)) assert.ok(deny.includes(`Edit(${f}/**)`), f);
    for (const f of formasAbsolutas(base.carpetaDatos)) assert.ok(deny.includes(`Edit(${f}/**)`), f);
    assert.deepEqual(formasAbsolutas(base.carpetaMotor), ["//c/Program Files/Mi Motor ñ"]);
    assert.ok(deny.includes("Edit(//d/Carriles Ó/PRUEBA/.claude/**)"));
    assert.deepEqual(s.env, { TTIA_MOTOR_NODE: base.node, TTIA_MOTOR_CLI: base.cli, TTIA_CARRIL: "PRUEBA" });
    assert.ok(!ask.includes("Bash(sqlcmd*)"));
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s, "JSON válido de ida y vuelta");
  });

  it("apdayc: SQL, issues, correo y PowerShell en ask; el .147 negado en Bash, Read y Edit (Edit cubre Write)", () => {
    const s = settingsCarril({ ...base, perfil: "apdayc" }) as { permissions: Record<string, string[]> };
    for (const a of ["Bash(sqlcmd*)", "Bash(gh issue*)", "Bash(*graph*send*)", "PowerShell"]) assert.ok(s.permissions.ask?.includes(a), a);
    for (const d of ["Bash(*192.168.252.147*)", "Read(//192.168.252.147/**)", "Edit(//192.168.252.147/**)"]) {
      assert.ok(s.permissions.deny?.includes(d), d);
    }
    assert.ok(!s.permissions.allow?.includes("PowerShell"));
  });

  it("sin --repos: nada pelado que lea o edite; solo la carpeta del carril y leer skills y agentes", () => {
    const s = settingsCarril({ ...base, perfil: "generico" }) as { permissions: Record<string, unknown> };
    const allow = s.permissions.allow as string[];
    for (const pelado of ["Read", "Glob", "Grep", "Edit", "Write", "Monitor", "Bash", "PowerShell"]) assert.ok(!allow.includes(pelado), pelado);
    assert.ok(allow.includes("Read(//d/Carriles Ó/PRUEBA/**)"));
    assert.ok(allow.includes("Edit(//d/Carriles Ó/PRUEBA/**)"));
    assert.ok(allow.includes("Read(~/.claude/skills/**)"));
    assert.ok(allow.includes("Read(~/.claude/agents/**)"));
    assert.ok(!allow.some((a) => /^Edit\(~\/\.claude/.test(a)), "skills y agentes: solo lectura");
    assert.ok((s.permissions.deny as string[]).includes("Edit(~/.claude/**)"));
    assert.equal(s.permissions.additionalDirectories, undefined);
    // Cada regla de ruta del allow es Read o Edit con ruta absoluta //x/ o ~/: ninguna relativa.
    for (const a of allow.filter((x) => /^(Read|Edit)\(/.test(x))) assert.match(a, /^(Read|Edit)\((\/\/[a-z]\/|~\/)/, a);
  });

  it("con --repos: leer y editar en cada repo, y los repos como additionalDirectories", () => {
    const repos = ["C:\\Code\\Repo Á", "E:\\otro\\repo2"];
    const s = settingsCarril({ ...base, perfil: "juegos", repos }) as { permissions: Record<string, unknown> };
    const allow = s.permissions.allow as string[];
    for (const r of ["//c/Code/Repo Á", "//e/otro/repo2"]) {
      assert.ok(allow.includes(`Read(${r}/**)`), r);
      assert.ok(allow.includes(`Edit(${r}/**)`), r);
    }
    assert.deepEqual(s.permissions.additionalDirectories, repos);
    assert.ok(!allow.includes("Edit"));
    // el settings del carril sigue negando su propia .claude aunque esté dentro de una carpeta permitida
    assert.ok((s.permissions.deny as string[]).includes("Edit(//d/Carriles Ó/PRUEBA/.claude/**)"));
  });

  it("skills como junction: su destino real se puede leer pero no editar", () => {
    const s = settingsCarril({ ...base, perfil: "generico", destinosLectura: ["C:\\Users\\Ana\\vault\\skills"], destinosEdicion: ["E:\\real\\repo"] }) as { permissions: Record<string, string[]> };
    assert.ok(s.permissions.allow?.includes("Read(//c/Users/Ana/vault/skills/**)"));
    assert.ok(!s.permissions.allow?.includes("Edit(//c/Users/Ana/vault/skills/**)"));
    assert.ok(s.permissions.deny?.includes("Edit(//c/Users/Ana/vault/skills/**)"));
    assert.ok(s.permissions.allow?.includes("Edit(//e/real/repo/**)"));
  });

  it("destinosReales: solo las carpetas que son junction, con su destino", () => {
    const tmp = carpetaTemporal();
    try {
      const real = path.join(tmp, "real ñ");
      const enlace = path.join(tmp, "enlace");
      fs.mkdirSync(real);
      fs.symlinkSync(real, enlace, "junction");
      const r = destinosReales([enlace, real, path.join(tmp, "no-existe")]);
      assert.equal(r.length, 1);
      assert.equal(fs.realpathSync.native(r[0] as string).toLowerCase(), fs.realpathSync.native(real).toLowerCase());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parsearRepos: separa por ;, junta los --repos repetidos, quita repetidos y rechaza lo que no es un repo", () => {
    const home = "C:\\Users\\Ana";
    assert.deepEqual(parsearRepos(["C:\\a;D:\\b ; ", "\"E:\\c d\"", "c:\\A"], home), ["C:\\a", "D:\\b", "E:\\c d"]);
    assert.throws(() => parsearRepos(["relativa"], home), /rutas completas/);
    assert.throws(() => parsearRepos(["C:\\"], home), /disco/);
    assert.throws(() => parsearRepos([home], home), /usuario/);
    assert.throws(() => parsearRepos(["C:\\Users\\Ana\\.claude\\skills"], home), /\.claude/);
    assert.throws(() => parsearRepos(["C:\\x\\*"], home), /rutas completas/);
  });

  it("juegos: la base más el hueco documentado para los comandos de prueba exactos", () => {
    const s = settingsCarril({ ...base, perfil: "juegos" }) as Record<string, unknown>;
    assert.match(String(s["//por_completar"]), /godot --headless/);
    assert.ok(!(s.permissions as Record<string, string[]>).allow?.some((a) => /godot/.test(a)), "no se agrega solo");
  });

  it("respaldo (sin carril): sin latido ni TTIA_CARRIL", () => {
    const s = settingsCarril({ ...base, carril: null, perfil: "generico" }) as { permissions: Record<string, string[]>; env: Record<string, string> };
    assert.ok(!s.permissions.allow?.some((a) => /latido/.test(a)));
    assert.equal(s.env.TTIA_CARRIL, undefined);
  });
});

describe("carril instalar: token y MCP de Claude Code", () => {
  const tmp = carpetaTemporal();
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("validarToken: tools/list de solo lectura; 401 = rechazado; sin red = error", async () => {
    const { f, llamadas } = fetchFalso([TOKEN]);
    assert.equal((await validarToken("https://x/mcp", TOKEN, f)).estado, "valido");
    assert.match(llamadas[0]?.cuerpo ?? "", /"method":"tools\/list"/);
    assert.equal((await validarToken("https://x/mcp", TOKEN_VIEJO, f)).estado, "rechazado");
    const sinRed = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    assert.equal((await validarToken("https://x/mcp", TOKEN, sinRed)).estado, "error");
  });

  it("registrarMcp: el token va solo por stdin; si ya existe, lo quita y lo vuelve a agregar", async () => {
    const { correr, llamadas } = correrFalso([{ codigo: 1, salida: "MCP server ttia already exists in user config" }, { codigo: 0, salida: "ok" }, { codigo: 0, salida: "ok" }]);
    const r = await registrarMcp("claude", "https://ttia.awki.ai/mcp", TOKEN, correr);
    assert.equal(r.ok, true);
    assert.deepEqual(llamadas.map((l) => l.args.slice(0, 2).join(" ")), ["mcp add-json", "mcp remove", "mcp add-json"]);
    for (const l of llamadas) assert.ok(!l.args.join(" ").includes(TOKEN), "nunca en la línea de comandos");
    assert.equal(llamadas[0]?.entrada, jsonMcp("https://ttia.awki.ai/mcp", TOKEN));
    assert.deepEqual(llamadas[0]?.args, ["mcp", "add-json", "ttia", "-", "--scope", "user"]);
  });

  it("registrarMcp: si agregar falla por otra cosa, NO quita el que había y no muestra el token", async () => {
    const { correr, llamadas } = correrFalso([{ codigo: 1, salida: `refused ${TOKEN}` }]);
    const r = await registrarMcp("claude", "https://ttia.awki.ai/mcp", TOKEN, correr);
    assert.equal(r.ok, false);
    assert.equal(llamadas.length, 1);
    assert.ok(!r.detalle.includes(TOKEN));
  });

  it("estadoMcpClaude: igual, distinto, falta y el ttia local de la carpeta del carril", () => {
    const archivo = path.join(tmp, ".claude.json");
    assert.equal(estadoMcpClaude(archivo, TOKEN).estado, "falta");
    const carpeta = path.join(tmp, "Carril Ñ");
    fs.writeFileSync(archivo, JSON.stringify({
      mcpServers: { ttia: { type: "http", url: "u", headers: { Authorization: `Bearer ${TOKEN}` } } },
      projects: { [carpeta.replace(/\\/g, "/")]: { mcpServers: { ttia: {} } } },
    }));
    assert.equal(estadoMcpClaude(archivo, TOKEN).estado, "igual");
    assert.equal(estadoMcpClaude(archivo, TOKEN_VIEJO).estado, "distinto");
    assert.equal(estadoMcpClaude(archivo, TOKEN, carpeta).local, true);
  });
});

describe("carril instalar: de punta a punta (sin red y sin el Claude Code real)", () => {
  let tmp = "";
  let datos = "";
  let previo: string | undefined;
  beforeEach(() => {
    tmp = carpetaTemporal();
    datos = path.join(tmp, "AppData ñ", "AwkiOffice");
    previo = process.env.AWKI_OFFICE_DIR;
    process.env.AWKI_OFFICE_DIR = datos;
    fs.mkdirSync(datos, { recursive: true });
    fs.writeFileSync(path.join(datos, "motor.json"), JSON.stringify({ carpetas_permitidas: [], modelo: "claude-sonnet-5-5", extra: "se queda" }, null, 2));
  });
  afterEach(() => {
    if (previo === undefined) delete process.env.AWKI_OFFICE_DIR;
    else process.env.AWKI_OFFICE_DIR = previo;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function deps(o: { guardado: string | null; pegado?: string; validos: string[]; correr?: Correr }): DepsInstalar & { lineas: string[]; guardados: string[]; preguntas: number } {
    const lineas: string[] = [];
    const guardados: string[] = [];
    const d = {
      lineas, guardados, preguntas: 0,
      almacen: { obtener: () => o.guardado, guardar: (t: string) => void guardados.push(t) },
      pedir: async () => { d.preguntas++; return o.pegado ?? ""; },
      fetch: fetchFalso(o.validos).f,
      correr: o.correr ?? correrFalso().correr,
      claudeJson: path.join(tmp, "home", ".claude.json"),
      home: path.join(tmp, "home"),
      node: path.join(tmp, "Motor ñ", "node", "node.exe"),
      cli: path.join(tmp, "Motor ñ", "dist", "cli.js"),
      salida: (l: string) => void lineas.push(l),
      ahora: () => new Date(2026, 10, 18, 10, 30, 0),
    };
    return d;
  }

  it("token inválido (simulado): termina antes de tocar nada y lo dice claro", async () => {
    const antes = fs.readFileSync(rutaConfig(), "utf8");
    const d = deps({ guardado: null, pegado: TOKEN, validos: [] });
    const carpeta = path.join(tmp, "Carriles ñ", "PRUEBA");
    const r = await instalarCarril({ carril: "prueba", carpeta, perfil: "generico", tokenNuevo: false, forzar: false }, d);
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(rutaConfig(), "utf8"), antes, "motor.json intacto");
    assert.deepEqual(d.guardados, [], "no guarda un token rechazado");
    assert.ok(!fs.existsSync(carpeta), "no crea carpetas");
    assert.match(d.lineas.join("\n"), /Mi PC > Claude Code/);
    assert.ok(!d.lineas.join("\n").includes(TOKEN), "nunca imprime el token");
  });

  it("si motor.json no cierra (respaldo que choca con otro carril), termina ANTES de guardar el token o tocar el MCP", async () => {
    const padre = path.join(tmp, "c ñ");
    fs.writeFileSync(rutaConfig(), JSON.stringify({ carpetas_permitidas: [], despachador: { carriles: ["OTRO"], carpetas_carriles: { OTRO: path.join(padre, "_respaldo") } } }));
    const antes = fs.readFileSync(rutaConfig(), "utf8");
    const c = correrFalso();
    const d = deps({ guardado: null, pegado: TOKEN, validos: [TOKEN], correr: c.correr });
    await assert.rejects(instalarCarril({ carril: "X", carpeta: path.join(padre, "X"), perfil: "generico", tokenNuevo: false, forzar: false }, d), /respaldo/);
    assert.equal(d.preguntas, 0, "ni pide el token");
    assert.deepEqual(d.guardados, []);
    assert.equal(c.llamadas.length, 0, "no toca el MCP de Claude Code");
    assert.equal(fs.readFileSync(rutaConfig(), "utf8"), antes);
  });

  it("url_mcp distinta de la de THE TOWN IA: lo avisa antes de mandar el token", async () => {
    fs.writeFileSync(rutaConfig(), JSON.stringify({ carpetas_permitidas: [], despachador: { url_mcp: "https://otro.example/mcp" } }));
    const d = deps({ guardado: TOKEN, validos: [TOKEN] });
    await instalarCarril({ carril: "X", carpeta: path.join(tmp, "X"), perfil: "generico", tokenNuevo: false, forzar: false }, d);
    assert.match(d.lineas[0] ?? "", /AVISO: motor\.json apunta a otro servidor MCP \(https:\/\/otro\.example\/mcp\)/);
  });

  it("token con formato raro: ni lo valida", async () => {
    const d = deps({ guardado: null, pegado: "sk-ant-api03-no-es", validos: [] });
    const r = await instalarCarril({ carril: "X", carpeta: path.join(tmp, "X"), perfil: "generico", tokenNuevo: false, forzar: false }, d);
    assert.equal(r.ok, false);
    assert.match(d.lineas.join("\n"), /ttia_pat_/);
  });

  it("token guardado revocado: pide uno nuevo, lo valida, lo guarda y reemplaza el MCP de Claude Code", async () => {
    fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "home", ".claude.json"), JSON.stringify({ mcpServers: { ttia: { headers: { Authorization: `Bearer ${TOKEN_VIEJO}` } } } }));
    const c = correrFalso([{ codigo: 1, salida: "already exists" }, { codigo: 0, salida: "" }, { codigo: 0, salida: "" }]);
    const d = deps({ guardado: TOKEN_VIEJO, pegado: TOKEN, validos: [TOKEN], correr: c.correr });
    const r = await instalarCarril({ carril: "PRUEBA", carpeta: path.join(tmp, "Carriles ñ", "PRUEBA"), perfil: "generico", tokenNuevo: false, forzar: false }, d);
    assert.equal(r.ok, true);
    assert.equal(d.preguntas, 1);
    assert.deepEqual(d.guardados, [TOKEN]);
    assert.equal(c.llamadas.length, 3);
    assert.match(d.lineas.join("\n"), /reemplazado \(tenía otro token\)/);
    assert.ok(!d.lineas.join("\n").includes(TOKEN));
  });

  it("instala con rutas con espacios y tildes; reinstalar no cambia nada; un settings distinto no se pisa sin --forzar", async () => {
    const carpeta = path.join(tmp, "Mis Carriles ñandú", "Carril PRUEBA Ó");
    const d = deps({ guardado: TOKEN, validos: [TOKEN] });
    const opc = { carril: "PRUEBA", carpeta, perfil: "generico" as const, tokenNuevo: false, forzar: false };
    const r = await instalarCarril(opc, d);
    assert.equal(r.ok, true);
    assert.equal(d.preguntas, 0, "con un token válido guardado no lo vuelve a pedir");
    const cfg = JSON.parse(fs.readFileSync(rutaConfig(), "utf8")) as Record<string, Record<string, unknown>>;
    assert.equal(cfg.extra as unknown, "se queda");
    assert.deepEqual(cfg.despachador?.carriles, ["PRUEBA"]);
    assert.equal(cfg.despachador?.carpeta_trabajo, path.join(tmp, "Mis Carriles ñandú", "_respaldo"));
    assert.ok(fs.readdirSync(datos).some((f) => /^motor\.json\.respaldo-2026-11-18-103000$/.test(f)), "respaldo con fecha");
    const settings = path.join(carpeta, ".claude", "settings.json");
    assert.match(fs.readFileSync(settings, "utf8"), /hook aprobacion/);
    assert.ok(fs.existsSync(path.join(tmp, "Mis Carriles ñandú", "_respaldo", ".claude", "settings.json")), "el respaldo con su settings");

    const d2 = deps({ guardado: TOKEN, validos: [TOKEN] });
    await instalarCarril(opc, d2);
    assert.match(d2.lineas.join("\n"), /ya tenía este carril tal cual/);
    assert.match(d2.lineas.join("\n"), /ya estaba igual/);

    fs.writeFileSync(settings, '{"mio": true}\n');
    const d3 = deps({ guardado: TOKEN, validos: [TOKEN] });
    await instalarCarril({ ...opc, perfil: "apdayc" }, d3);
    assert.equal(fs.readFileSync(settings, "utf8"), '{"mio": true}\n');
    assert.match(d3.lineas.join("\n"), /NO lo toqué/);

    const d4 = deps({ guardado: TOKEN, validos: [TOKEN] });
    await instalarCarril({ ...opc, perfil: "apdayc", forzar: true }, d4);
    assert.match(fs.readFileSync(settings, "utf8"), /sqlcmd/);
    const respaldos = fs.readdirSync(path.join(carpeta, ".claude")).filter((f) => f.startsWith("settings.json.respaldo-"));
    assert.equal(respaldos.length, 1);
    assert.equal(fs.readFileSync(path.join(carpeta, ".claude", respaldos[0] as string), "utf8"), '{"mio": true}\n');
  });

  it("una carpeta de respaldo elegida por la persona se respeta: no se le escribe settings, solo se avisa", async () => {
    const suya = path.join(tmp, "respaldo de Ana");
    fs.writeFileSync(rutaConfig(), JSON.stringify({ carpetas_permitidas: [tmp], despachador: { carpeta_trabajo: suya } }));
    const d = deps({ guardado: TOKEN, validos: [TOKEN] });
    const r = await instalarCarril({ carril: "PRUEBA", carpeta: path.join(tmp, "Carriles", "PRUEBA"), perfil: "generico", tokenNuevo: false, forzar: false }, d);
    assert.equal(r.respaldo, suya);
    assert.ok(!fs.existsSync(path.join(suya, ".claude")), "no escribe en la carpeta de la persona");
    assert.match(d.lineas.join("\n"), /No la toqué: es tuya/);
  });

  it("--repos: los escribe en el settings y en motor.json; reinstalar con --forzar sin --repos los conserva", async () => {
    const carpeta = path.join(tmp, "C ñ", "PRUEBA");
    const repoA = path.join(tmp, "Repo Á");
    const repoB = path.join(tmp, "repo b");
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    const opc = { carril: "PRUEBA", carpeta, perfil: "generico" as const, tokenNuevo: false, forzar: false };
    const d1 = deps({ guardado: TOKEN, validos: [TOKEN] });
    await instalarCarril({ ...opc, repos: [`${repoA};${repoB}`] }, d1);
    const leer = (): { permissions: { allow: string[]; additionalDirectories?: string[] } } =>
      JSON.parse(fs.readFileSync(path.join(carpeta, ".claude", "settings.json"), "utf8"));
    for (const f of formasAbsolutas(repoA)) assert.ok(leer().permissions.allow.includes(`Edit(${f}/**)`), f);
    assert.deepEqual(leer().permissions.additionalDirectories, [repoA, repoB]);
    assert.match(d1.lineas.join("\n"), /Repos del carril \(lee y edita sin preguntar/);
    await instalarCarril({ ...opc, perfil: "juegos", forzar: true }, deps({ guardado: TOKEN, validos: [TOKEN] }));
    assert.deepEqual(leer().permissions.additionalDirectories, [repoA, repoB], "--forzar sin --repos los conserva");
    const cfg = JSON.parse(fs.readFileSync(rutaConfig(), "utf8")) as { despachador: { repos_carriles: Record<string, string[]> } };
    assert.deepEqual(cfg.despachador.repos_carriles, { PRUEBA: [repoA, repoB] });
  });

  it("--repos con una carpeta que no existe: termina antes de pedir el token", async () => {
    const d = deps({ guardado: null, pegado: TOKEN, validos: [TOKEN] });
    const antes = fs.readFileSync(rutaConfig(), "utf8");
    await assert.rejects(instalarCarril({ carril: "X", carpeta: path.join(tmp, "X"), perfil: "generico", tokenNuevo: false, forzar: false,
      repos: [path.join(tmp, "no-existe")] }, d), /No existe el repo/);
    assert.equal(d.preguntas, 0);
    assert.equal(fs.readFileSync(rutaConfig(), "utf8"), antes);
  });

  it("quitar: lo saca de motor.json con respaldo y no borra la carpeta", async () => {
    const carpeta = path.join(tmp, "C ñ", "PRUEBA");
    await instalarCarril({ carril: "PRUEBA", carpeta, perfil: "generico", tokenNuevo: false, forzar: false }, deps({ guardado: TOKEN, validos: [TOKEN] }));
    const r = quitarCarril("prueba", new Date(2026, 10, 18, 11, 0, 0));
    assert.equal(r.estaba, true);
    assert.ok(r.respaldo && fs.existsSync(r.respaldo));
    assert.deepEqual((JSON.parse(fs.readFileSync(rutaConfig(), "utf8")) as Record<string, Record<string, unknown>>).despachador?.carriles, []);
    assert.ok(fs.existsSync(path.join(carpeta, ".claude", "settings.json")));
  });
});

describe("carril abrir y la ayuda", () => {
  it("abre con nombre, Remote Control y la frase de arranque", () => {
    assert.deepEqual(argsAbrir("JUEGOS", "GDT - Godot"), ["--name", "GDT - Godot", "--remote-control", "GDT - Godot", PROMPT_CARRIL("JUEGOS")]);
    assert.equal(PROMPT_CARRIL("X"), "Eres la sesión del carril X: sigue la skill carril-ttia.");
    assert.throws(() => argsAbrir("X", 'a" & del'), /nombre/);
    // `--remote-control [name]` tiene el valor opcional: un nombre con guion adelante sería otra opción de claude.
    assert.throws(() => argsAbrir("X", "--dangerously-skip-permissions"), /nombre/);
    assert.throws(() => argsAbrir("X", "-p"), /nombre/);
  });

  it("--help y help imprimen el uso sin arrancar otro motor; un comando desconocido falla", () => {
    const tmp = carpetaTemporal();
    try {
      const raiz = path.resolve(import.meta.dirname, "..");
      const env = { ...process.env, AWKI_OFFICE_DIR: tmp };
      for (const a of ["--help", "help"]) {
        const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", a], { cwd: raiz, env, encoding: "utf8", timeout: 60_000 });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /carril instalar <CARRIL>/);
      }
      const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "arrancar-otro"], { cwd: raiz, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /No conozco/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
