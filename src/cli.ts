#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PERFILES, argsAbrir, carpetaDeCarril, estadoMcpClaude, hookDeSettings, instalarCarril, lanzarInteractivo, lineaComando, motorCorriendo,
  normalizarCarril, quitarCarril, rutaClaudeJson, validarToken, MENSAJE_TOKEN_RECHAZADO, type Perfil } from "./carril.js";
import { pedirSinEco } from "./clave.js";
import { CARRIL_VALIDO, URL_MCP_POR_DEFECTO, cargarConfig, crearConfigSiFalta, guardarCarpeta, guardarDespachador, rutaConfig, workspaceEfectivo, type ConfigMotor } from "./config.js";
import { bloqueSettings, correrHook, leerStdin } from "./hook.js";
import { almacenToken, almacenWindows, claveBorrar, claveEstado, claveSet, tokenBorrar, tokenEstado, tokenSet } from "./clave.js";
import { Despachador, diagnosticar, llamarMcp } from "./despachador.js";
import { carpetaSkillsOrigen, carpetaSkillsUsuario, instalarSkills, listarSkillsOrigen } from "./skills.js";
import { crearLogger } from "./log.js";
import { Emparejamiento } from "./emparejamiento.js";
import { ServidorMotor, VERSION } from "./servidor.js";
import { EjecutorClaude } from "./agente.js";
import { EjecutorSimulado } from "./simulado.js";
import { elegirCarpetaWindows } from "./dialogo.js";

const AYUDA = `THE TOWN IA - motor local v${VERSION}

Uso:
  motor-local                      Arranca el motor (usa Claude con tu clave guardada)
  motor-local --simulado           Arranca sin llamar a Claude (para probar la web, sin gastar)
  motor-local clave set            Guarda tu API key de Claude en el Administrador de credenciales
  motor-local clave borrar         Borra la clave guardada
  motor-local clave estado         Dice si hay una clave guardada (nunca la muestra)
  motor-local carpeta agregar <ruta>   Permite al agente trabajar en esa carpeta
  motor-local carpeta quitar <ruta>    Le quita el acceso a esa carpeta
  motor-local carpeta lista            Muestra las carpetas permitidas
  motor-local token set            Guarda tu token de THE TOWN IA (Mi PC > Claude Code) en el Administrador de credenciales
  motor-local token borrar | estado
  motor-local despachador activar | desactivar | estado | una-vez
                                   Despachador: lanza TU Claude Code para tomar los encargos de THE TOWN IA
  motor-local skills instalar | lista   Copia las skills de THE TOWN IA a ~/.claude/skills
  motor-local latido <CARRIL>      Avisa a THE TOWN IA que la sesion de ese carril esta viva (lo usa su Monitor;
                                   no cambia «trabajando», que lo pone la sesion)
  motor-local hook mostrar         Muestra el bloque de .claude/settings.json del hook de aprobaciones (no lo escribe)
  motor-local hook aprobacion      El hook PreToolUse en si (lo llama Claude Code, no tu): bloquea push, merge, PR y
                                   subidas a Play o YouTube sin una aprobacion de THE TOWN IA para ese comando exacto
  motor-local carril instalar <CARRIL> [--carpeta <ruta>] [--repos "<ruta1>;<ruta2>"] [--perfil generico|apdayc|juegos]
                              [--token-nuevo] [--forzar]
                                   Conecta un carril de Claude Code en esta PC de una vez: valida y guarda el token
                                   (motor y MCP ttia de Claude Code), motor.json, carpetas y .claude/settings.json.
                                   La sesion solo lee y edita sin preguntar en su carpeta y en los --repos
  motor-local carril abrir <CARRIL> [--nombre <nombre>] [--imprimir]
                                   Abre Claude Code en la carpeta del carril, con nombre, Remote Control y la frase
                                   de arranque
  motor-local carril estado        Carriles, carpetas, settings, token y MCP de esta PC
  motor-local carril quitar <CARRIL>   Lo saca de motor.json (no borra carpetas)
  motor-local --ayuda | --help     Muestra este texto

Configuracion: ${rutaConfig()}
Workspace de Anthropic (claves sk-ant-usr-): campo "workspace" de motor.json o variable ANTHROPIC_WORKSPACE_ID.
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--ayuda") || args.includes("-h") || args.includes("--help") || args[0] === "help" || args[0] === "ayuda") {
    console.log(AYUDA);
    return 0;
  }

  if (args[0] === "carril") return comandoCarril(args.slice(1));

  if (args[0] === "clave") {
    switch (args[1]) {
      case "set":
        await claveSet();
        console.log("Listo: la clave quedo guardada en el Administrador de credenciales de Windows.");
        return 0;
      case "borrar":
        console.log(claveBorrar() ? "Clave borrada." : "No habia ninguna clave guardada.");
        return 0;
      case "estado":
        console.log(claveEstado() ? "Hay una clave de Claude guardada." : "No hay clave guardada. Usa: motor-local clave set");
        return 0;
      default:
        console.error("Uso: motor-local clave set | borrar | estado");
        return 1;
    }
  }

  if (args[0] === "carpeta") {
    const accion = args[1];
    if (accion === "lista") {
      crearConfigSiFalta();
      const lista = cargarConfig().carpetas_permitidas;
      console.log(lista.length ? lista.join("\n") : "No hay carpetas permitidas. Agrega una: motor-local carpeta agregar <ruta>");
      return 0;
    }
    if ((accion === "agregar" || accion === "quitar") && args[2]) {
      try {
        const lista = guardarCarpeta(args.slice(2).join(" "), accion);
        console.log(`Listo. Carpetas permitidas:\n${lista.join("\n") || "(ninguna)"}`);
        console.log("Si el motor esta corriendo, escribe 'recargar' en su consola.");
        return 0;
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
    }
    console.error("Uso: motor-local carpeta agregar <ruta> | quitar <ruta> | lista");
    return 1;
  }

  if (args[0] === "token") {
    switch (args[1]) {
      case "set":
        await tokenSet();
        console.log("Listo: el token quedo guardado en el Administrador de credenciales de Windows.");
        return 0;
      case "borrar":
        console.log(tokenBorrar() ? "Token borrado." : "No habia ningun token guardado.");
        return 0;
      case "estado":
        console.log(tokenEstado() ? "Hay un token de THE TOWN IA guardado." : "No hay token guardado. Usa: motor-local token set");
        return 0;
      default:
        console.error("Uso: motor-local token set | borrar | estado");
        return 1;
    }
  }

  if (args[0] === "skills") {
    if (args[1] === "lista") {
      const lista = listarSkillsOrigen();
      console.log(lista.length ? lista.join("\n") : `No encontre skills en ${carpetaSkillsOrigen()}`);
      return 0;
    }
    if (args[1] === "instalar") {
      const r = instalarSkills();
      if (r.length === 0) console.log(`No encontre skills para instalar en ${carpetaSkillsOrigen()}`);
      for (const x of r) console.log(`${x.nombre}: ${x.estado}${x.motivo ? ` - ${x.motivo}` : ""}`);
      console.log(`Destino: ${carpetaSkillsUsuario()}. Si Claude Code esta abierto, reinicialo para que las vea.`);
      return 0;
    }
    console.error("Uso: motor-local skills instalar | lista");
    return 1;
  }

  if (args[0] === "latido") {
    // Lo corre el Monitor de la sesion de un carril cada minuto: si la sesion muere, el Monitor muere con ella y el
    // latido se corta (y a los respaldo_minutos el despachador hace sus encargos). No gasta tokens de Claude.
    // Es un PULSO: «sigo vivo». THE TOWN IA conserva «trabajando» y su encargo si la sesion lo habia puesto y ese
    // encargo sigue en curso en esta PC (asi el latido de cada minuto no pisa lo que declaro la sesion).
    const carril = (args[1] ?? "").trim().toUpperCase();
    if (!CARRIL_VALIDO.test(carril)) {
      console.error("Uso: motor-local latido <CARRIL>");
      return 1;
    }
    const token = almacenToken.obtener();
    if (!token) {
      console.error("Falta el token de THE TOWN IA (motor-local token set).");
      return 1;
    }
    try {
      await llamarMcp(cargarConfig().despachador.url_mcp, token, "latido", { carril, pulso: true }, 15_000);
      return 0;
    } catch (e) {
      console.error(`No pude dar el latido: ${e instanceof Error ? e.message.slice(0, 160) : "error"}`);
      return 1;
    }
  }

  if (args[0] === "hook") {
    if (args[1] === "mostrar") {
      console.log("Agrega esto a .claude/settings.json de la carpeta del carril (o al de tu usuario):\n");
      console.log(bloqueSettings(process.execPath, path.resolve(process.argv[1] ?? "dist/cli.js")));
      return 0;
    }
    if (args[1] === "aprobacion") {
      // Con aprobacion: stdout permissionDecision allow. Sin ella: codigo 2. Si este proceso falla, Claude Code sigue
      // con el «ask» del settings: la frontera son los permisos, no el hook.
      let url = URL_MCP_POR_DEFECTO;
      try {
        url = cargarConfig().despachador.url_mcp;
      } catch {
        /* config rota: URL por defecto */
      }
      return correrHook(url, () => {
        try {
          return almacenToken.obtener();
        } catch {
          return null;
        }
      }, leerStdin, (s) => process.stdout.write(s + "\n"), (s) => process.stderr.write(s + "\n"));
    }
    console.error("Uso: motor-local hook mostrar | aprobacion");
    return 1;
  }

  if (args[0] === "despachador") {
    crearConfigSiFalta();
    const accion = args[1];
    if (accion === "activar" || accion === "desactivar") {
      try {
        const d = guardarDespachador({ activo: accion === "activar" });
        console.log(d.activo ? "Despachador ACTIVADO. Arrancara junto con el motor." : "Despachador desactivado.");
        if (d.activo) {
          const cfg = cargarConfig();
          for (const l of await diagnosticar(cfg, tokenEstado())) console.log("  " + l);
          if (tokenEstado()) {
            try {
              const n = await new Despachador({ config: () => cfg, token: () => almacenToken.obtener(), log: crearLogger(undefined, false) }).declararSubagentes();
              console.log(`Subagentes declarados a THE TOWN IA: ${n}.`);
            } catch (e) {
              console.warn(`No pude declarar los subagentes ahora: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          console.log("Si el motor esta corriendo, reinicialo (o escribe 'recargar' en su consola).");
        }
        return 0;
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
    }
    if (accion === "estado") {
      for (const l of await diagnosticar(cargarConfig(), tokenEstado())) console.log(l);
      return 0;
    }
    if (accion === "una-vez") {
      const cfg = cargarConfig();
      const d = new Despachador({ config: () => cfg, token: () => almacenToken.obtener(), log: crearLogger(), aviso: (m) => console.warn(m) });
      const r = await d.ciclo();
      if (r === "sin_encargos") console.log("No hay encargos pendientes para esta PC.");
      if (r === "despachado") {
        console.log("Encargo despachado a Claude Code. Esperando a que termine...");
        await d.esperar();
        console.log("Terminado.");
      }
      return r === "error" || r === "no_listo" ? 1 : 0;
    }
    console.error("Uso: motor-local despachador activar | desactivar | estado | una-vez");
    return 1;
  }

  // Cualquier otra cosa no arranca un segundo motor (antes `--help` lo hacía y chocaba con el puerto).
  if (args.some((a) => a !== "--simulado")) {
    console.error(`No conozco "${args.join(" ")}".\n\n${AYUDA}`);
    return 1;
  }
  const simulado = args.includes("--simulado");
  const creada = crearConfigSiFalta();
  let config: ConfigMotor = cargarConfig();
  const log = crearLogger();
  if (creada) console.log(`Cree la configuracion inicial en ${rutaConfig()}`);

  if (!simulado && !claveEstado() && config.despachador.activo) {
    console.warn("AVISO: no hay clave de API de Claude. Solo funcionara el despachador (usa tu sesion de Claude Code); los chats en tu PC desde la web necesitan: motor-local clave set");
  } else if (!simulado && !claveEstado()) {
    console.error("No hay una clave de Claude guardada. Ejecuta primero: motor-local clave set (o prueba con --simulado).");
    return 1;
  }
  const workspace = workspaceEfectivo(config); // lanza con un mensaje claro si es invalido
  if (config.carpetas_permitidas.length === 0) {
    console.warn(
      `AVISO: no hay carpetas permitidas. El motor no ejecutara tareas hasta que agregues una en "carpetas_permitidas" de ${rutaConfig()}.`,
    );
  }

  const despachador = new Despachador({
    config: () => config,
    token: () => almacenToken.obtener(),
    log,
    aviso: (m) => console.warn(m),
  });
  const emparejamiento = new Emparejamiento();
  const ejecutor = simulado ? new EjecutorSimulado() : new EjecutorClaude(() => config, almacenWindows, log);
  const servidor = new ServidorMotor({
    config: () => config,
    ejecutor,
    emparejamiento,
    log,
    simulado,
    despachador: () => despachador.estado,
    hayClave: () => claveEstado(),
    hayWorkspace: () => {
      try {
        return workspaceEfectivo(config) !== null;
      } catch {
        return false;
      }
    },
    // La web puede pedir «agregar carpeta»: se abre el dialogo de Windows aqui y la persona la elige.
    elegirCarpeta: process.platform === "win32" ? () => elegirCarpetaWindows() : undefined,
    cambiarCarpeta: (ruta, accion) => {
      const lista = guardarCarpeta(ruta, accion);
      config = cargarConfig();
      console.log(`${accion === "agregar" ? "Carpeta agregada" : "Carpeta quitada"} desde la web: ${ruta}`);
      return lista;
    },
  });
  const puerto = await servidor.iniciar();
  if (config.despachador.activo) {
    console.log("Despachador activo: este motor tomara los encargos de THE TOWN IA con tu Claude Code.");
    despachador.iniciar();
  }

  const mostrarCodigo = (): void => {
    console.log("");
    console.log(`  Codigo de emparejamiento: ${emparejamiento.codigoActual}   (vale 5 minutos y se usa una sola vez)`);
    console.log("  Escribelo en la pagina de THE TOWN IA (https://ttia.awki.ai). Para generar otro, escribe 'nuevo' y Enter.");
    console.log("");
  };
  log.info(`motor ${VERSION} escuchando en 127.0.0.1:${puerto}`, { simulado, modelo: config.modelo });
  console.log(`THE TOWN IA - motor local ${VERSION}${simulado ? " (MODO SIMULADO: no se llama a Claude)" : ""}`);
  console.log(`Escuchando solo en 127.0.0.1:${puerto}. Origenes permitidos: ${config.origenes.join(", ")}`);
  console.log(workspace ? "Workspace de Anthropic: configurado." : "Workspace de Anthropic: ninguno (las claves sk-ant-usr- lo necesitan).");
  mostrarCodigo();

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (l) => {
      const t = l.trim().toLowerCase();
      if (t === "nuevo") {
        emparejamiento.nuevoCodigo();
        mostrarCodigo();
      } else if (t === "recargar") {
        config = cargarConfig();
        console.log("Configuracion recargada.");
        despachador.recargado();
        if (config.despachador.activo) despachador.iniciar();
        else void despachador.detener();
      } else if (t === "salir") {
        void servidor.detener().then(() => process.exit(0));
      }
    });
  }

  const cerrar = (): void => {
    void despachador.detener().then(() => servidor.detener()).then(() => process.exit(0));
  };
  process.on("SIGINT", cerrar);
  process.on("SIGTERM", cerrar);
  return -1; // sigue corriendo
}

interface OpcCarril {
  pos: string[];
  carpeta?: string;
  perfil?: string;
  nombre?: string;
  /** --repos (repetible; cada valor puede traer varias rutas separadas por ";"). */
  repos?: string[];
  tokenNuevo: boolean;
  forzar: boolean;
  imprimir: boolean;
}

function leerOpcionesCarril(args: string[]): OpcCarril {
  const o: OpcCarril = { pos: [], tokenNuevo: false, forzar: false, imprimir: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const igual = /^(--carpeta|--perfil|--nombre|--repos)=(.*)$/.exec(a);
    const nombre = igual ? (igual[1] as string) : a;
    if (["--carpeta", "--perfil", "--nombre", "--repos"].includes(nombre)) {
      const v = igual ? igual[2] : args[++i];
      if (v === undefined || v === "") throw new Error(`Falta el valor de ${nombre}.`);
      if (nombre === "--carpeta") o.carpeta = v;
      else if (nombre === "--perfil") o.perfil = v;
      else if (nombre === "--repos") (o.repos ??= []).push(v);
      else o.nombre = v;
    } else if (a === "--token-nuevo") o.tokenNuevo = true;
    else if (a === "--forzar") o.forzar = true;
    else if (a === "--imprimir") o.imprimir = true;
    else if (a.startsWith("--")) throw new Error(`No conozco la opción ${a}.`);
    else o.pos.push(a);
  }
  return o;
}

/** Cómo se llama al motor en esta PC (para imprimir el siguiente paso). */
function comandoMotor(cli: string): string {
  const cmd = path.resolve(path.dirname(cli), "..", "motor.cmd");
  return fs.existsSync(cmd) ? `"${cmd}"` : `"${process.execPath}" "${cli}"`;
}

const USO_CARRIL = "Uso: motor-local carril instalar <CARRIL> [--carpeta <ruta>] [--repos \"<ruta1>;<ruta2>\"] [--perfil generico|apdayc|juegos] [--token-nuevo] [--forzar]\n" +
  "     motor-local carril abrir <CARRIL> [--nombre <nombre>] [--imprimir] | estado | quitar <CARRIL>";

async function comandoCarril(args: string[]): Promise<number> {
  let o: OpcCarril;
  try {
    o = leerOpcionesCarril(args.slice(1));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USO_CARRIL}`);
    return 1;
  }
  const cli = path.resolve(process.argv[1] ?? "dist/cli.js");
  try {
    switch (args[0]) {
      case "instalar": {
        if (!/\.js$/i.test(cli)) {
          console.error("carril instalar escribe la ruta del motor en el hook: córrelo desde el motor instalado (motor.cmd) o desde dist\\cli.js (npm run build).");
          return 1;
        }
        const perfil = (o.perfil ?? "generico").toLowerCase();
        if (!PERFILES.includes(perfil as Perfil)) throw new Error(`Perfil desconocido: ${perfil}. Usa ${PERFILES.join(", ")}.`);
        if (o.pos.length !== 1) throw new Error(USO_CARRIL);
        const r = await instalarCarril(
          { carril: o.pos[0] as string, carpeta: o.carpeta, perfil: perfil as Perfil, tokenNuevo: o.tokenNuevo, forzar: o.forzar, repos: o.repos },
          { almacen: almacenToken, pedir: pedirSinEco, claudeJson: rutaClaudeJson(), home: os.homedir(), node: process.execPath, cli,
            salida: (l) => console.log(l) },
        );
        if (!r.ok) return 1;
        for (const x of instalarSkills()) console.log(`Skill ${x.nombre}: ${x.estado}${x.motivo ? ` (${x.motivo})` : ""}`);
        const cfg = cargarConfig();
        console.log("\nComprobación:");
        for (const l of await diagnosticar(cfg, tokenEstado())) console.log(`  ${l}`);
        console.log(await motorCorriendo(cfg.puerto)
          ? `  Motor: corriendo en 127.0.0.1:${cfg.puerto}. Escribe 'recargar' en su ventana para que tome el carril (o reinícialo).`
          : "  Motor: no está corriendo. Ábrelo (Menú Inicio > THE TOWN IA > Motor local) para que haga de bandeja y respaldo.");
        const carril = normalizarCarril(o.pos[0]);
        console.log(`\nSiguiente paso: ${comandoMotor(cli)} carril abrir ${carril}`);
        if (r.mcpPendiente) console.log("Antes: corre este mismo carril instalar desde una terminal normal para registrar el MCP ttia en Claude Code.");
        return 0;
      }
      case "abrir": {
        if (o.pos.length !== 1) throw new Error(USO_CARRIL);
        const carril = normalizarCarril(o.pos[0]);
        const cfg = cargarConfig();
        if (!cfg.despachador.carriles.includes(carril)) console.warn(`AVISO: ${carril} no está en motor.json. Primero: carril instalar ${carril}`);
        const carpeta = o.carpeta ? path.resolve(o.carpeta) : carpetaDeCarril(cfg, carril).ruta;
        if (!fs.existsSync(carpeta)) {
          console.error(`No existe la carpeta del carril (${carpeta}). Primero: carril instalar ${carril}`);
          return 1;
        }
        const a = argsAbrir(carril, o.nombre ?? carril);
        console.log(`Carpeta: ${carpeta}\nComando: ${lineaComando(cfg.despachador.claude, a)}`);
        console.log("Arranca con Remote Control. Si no aparece en la lista de Remote Control, escribe /remote-control dentro de la sesión.");
        if (o.imprimir) return 0;
        return lanzarInteractivo(cfg.despachador.claude, a, carpeta);
      }
      case "estado": {
        const cfg = cargarConfig();
        const d = cfg.despachador;
        console.log(`Configuración: ${rutaConfig()}`);
        console.log(`Despachador: ${d.activo ? "ACTIVO" : "apagado"}; respaldo en ${d.carpeta_trabajo ?? cfg.carpetas_permitidas[0] ?? "(ninguna)"}; Chrome ${d.chrome ? "SÍ" : "no"}`);
        if (!d.carriles.length) console.log("Carriles: ninguno. Agrega uno: carril instalar <CARRIL>");
        for (const c of d.carriles) {
          const { ruta, origen } = carpetaDeCarril(cfg, c);
          const existe = fs.existsSync(ruta);
          const archivo = path.join(ruta, ".claude", "settings.json");
          const h = hookDeSettings(archivo);
          const settings = !fs.existsSync(archivo) ? "FALTA" : !h.hay ? "presente, SIN el hook de aprobaciones"
            : h.node && !fs.existsSync(h.node) ? `presente, pero el hook apunta a un node que no existe (${h.node}): carril instalar ${c} --forzar`
            : "presente, con el hook de aprobaciones";
          const repos = d.repos_carriles[c] ?? [];
          const textoRepos = repos.length
            ? repos.map((r) => `${r}${fs.existsSync(r) ? "" : " (NO EXISTE)"}`).join("; ")
            : `ninguno (solo su carpeta; agrégalos con carril instalar ${c} --repos "<ruta1>;<ruta2>" --forzar)`;
          console.log(`- ${c}\n    carpeta: ${ruta} (${origen}${existe ? "" : ", NO EXISTE"})\n    repos: ${textoRepos}\n    settings: ${settings}`);
        }
        const token = almacenToken.obtener();
        let lineaToken = "FALTA (carril instalar <CARRIL> lo pide)";
        if (token) {
          const v = await validarToken(d.url_mcp, token);
          lineaToken = v.estado === "valido" ? "válido" : v.estado === "rechazado" ? `RECHAZADO. ${MENSAJE_TOKEN_RECHAZADO}` : `no pude comprobarlo (${v.detalle})`;
        }
        console.log(`Token del motor: ${lineaToken}`);
        const m = estadoMcpClaude(rutaClaudeJson(), token);
        const textoMcp = { igual: "mismo token que el motor", distinto: "OTRO token que el motor (dará 401): carril instalar <CARRIL> lo reemplaza",
          falta: "no registrado (carril instalar <CARRIL> lo registra)", ilegible: `no pude leer ${rutaClaudeJson()}` }[m.estado];
        console.log(`MCP ttia de Claude Code (scope user): ${textoMcp}`);
        console.log(await motorCorriendo(cfg.puerto) ? `Motor: corriendo en 127.0.0.1:${cfg.puerto}` : "Motor: no está corriendo");
        return 0;
      }
      case "quitar": {
        if (o.pos.length !== 1) throw new Error(USO_CARRIL);
        const r = quitarCarril(o.pos[0] as string);
        if (!r.estaba) {
          console.log("Ese carril no estaba en motor.json.");
          return 0;
        }
        console.log(`Quitado de motor.json (respaldo en ${r.respaldo}). No borré su carpeta ni su settings.`);
        console.log("Si el motor está corriendo, escribe 'recargar' en su ventana.");
        return 0;
      }
      default:
        console.error(USO_CARRIL);
        return 1;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

main().then(
  (cod) => {
    if (cod >= 0) process.exit(cod);
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
