# THE TOWN IA — motor local

Programa opcional para Windows que conecta tu PC con [THE TOWN IA](https://ttia.awki.ai). Con él, tus agentes
privados pueden trabajar con tus archivos y programas, siempre dentro de las carpetas que tú elijas y pidiéndote
permiso antes de escribir, borrar, ejecutar comandos o salir a internet. *Powered by Claude* (Claude Agent SDK de
Anthropic), con **tu propia clave de API**.

Si no lo instalas, la web sigue funcionando: solo no habrá agentes trabajando en tu PC.

## Instalar (usuarios)

1. Descarga **[TTIA-Motor-Setup.exe](https://github.com/DavidLVergaraBazalar/ttia-motor-local/releases/latest/download/TTIA-Motor-Setup.exe)**
   (Windows 10/11, 64 bits). También está en la app **Mi PC** de THE TOWN IA.
2. Ejecútalo. No pide permisos de administrador. Windows puede mostrar «editor desconocido» porque el instalador
   todavía no está firmado: **Más información > Ejecutar de todas formas**.
3. Elige la **carpeta de trabajo** de tu agente (por defecto, Documentos).
4. El instalador descarga de npm el Claude Agent SDK de Anthropic (necesita internet; tarda unos minutos).
5. Al terminar, guarda tu **clave de API de Claude** (se crea en [Claude Console](https://console.anthropic.com),
   empieza con `sk-ant-`). Queda en el Administrador de credenciales de Windows, nunca en un archivo.
6. Arranca el motor desde **Inicio > THE TOWN IA > Motor local** y escribe en la web el código de 6 dígitos.

Accesos del menú Inicio: *Motor local*, *Guardar mi clave de Claude*, *Probar sin clave (simulado)*,
*Ver carpetas permitidas* y *Desinstalar el motor*.

## Usarlo desde https://ttia.awki.ai

1. Arranca el motor. En su ventana aparece un **código de 6 dígitos** (vale 5 minutos, un solo uso; para otro,
   escribe `nuevo` y Enter).
2. Entra a https://ttia.awki.ai, abre el laptop y la app **Mi PC**. Chrome o Edge preguntan si la página puede
   acceder a tu red local: elige **Permitir** (es lo que deja a la página hablar con `127.0.0.1`). Safari no lo permite.
3. Escribe el código. El token queda solo en esa pestaña y se borra al cerrarla o al salir de tu cuenta.
4. En **Agentes > Perfil** de un agente **privado**, elige «Dónde trabaja: En mi PC». Su chat y sus tareas pasan por
   el motor. Cada vez que el agente quiera escribir, borrar, ejecutar un comando o salir a internet, la web muestra un
   **cartel rojo** con el detalle: **Aprobar** o **Denegar**. Sin respuesta en 5 minutos, se deniega.

## Comandos

En la carpeta de instalación (`%LOCALAPPDATA%\Programs\TTIA Motor Local`) usa `motor.cmd`; desde el código fuente,
`node dist/cli.js`.

```powershell
motor.cmd                          # arranca el motor
motor.cmd --simulado               # arranca sin llamar a Claude (para probar la web sin gastar)
motor.cmd clave set                # guarda tu clave de API (la pide sin mostrarla)
motor.cmd clave estado | borrar
motor.cmd carpeta agregar "C:\Users\Ana\Documentos\Trabajo"
motor.cmd carpeta quitar  "C:\Users\Ana\Documentos\Trabajo"
motor.cmd carpeta lista
```

Desde la web también puedes manejar las carpetas: en **Mi PC**, «Agregar carpeta» abre en tu PC la ventana de
Windows para elegirla (la página nunca decide la ruta) y «Quitar» le saca el acceso. No se puede dar acceso a un
disco entero (`C:\`).

## Despachador: que tu Claude Code tome los encargos solo

Con el despachador, los agentes **«En mi Claude Code»** de THE TOWN IA ya no necesitan que dejes una sesión de Claude
Code abierta con `/loop`: el motor revisa cada minuto si hay un encargo para tu PC y, si lo hay, lanza **tu** Claude Code
para que lo tome (`tomar_encargo`), lo haga y lo entregue. Uno a la vez.

**Requisitos**

- [Claude Code](https://claude.com/claude-code) instalado y con la **sesión iniciada con tu propia cuenta**. El motor lanza
  el Claude Code oficial, sin modificarlo, con la cuenta de cada persona: no comparte ni guarda credenciales de Anthropic.
- Para encargos que usan el navegador (por ejemplo las skills de abajo): Chrome con la extensión **Claude for Chrome** y
  tu sesión de la empresa ya iniciada.
- El servidor MCP de THE TOWN IA agregado a Claude Code con el nombre `ttia` (las herramientas se ven como `mcp__ttia__*`);
  las instrucciones están en **Mi PC > Claude Code** dentro de THE TOWN IA.
- Tu **token** de THE TOWN IA (empieza con `ttia_pat_`), también de **Mi PC > Claude Code**.

**Activarlo**

```powershell
motor.cmd token set                 # guarda el token en el Administrador de credenciales de Windows (no en un archivo)
motor.cmd despachador estado        # revisa los requisitos
motor.cmd despachador una-vez       # prueba: revisa, despacha UN encargo y sale
motor.cmd despachador activar       # a partir de ahora arranca junto con el motor
motor.cmd despachador desactivar
```

Con el despachador activo, `motor.cmd` (el motor normal) corre el bucle además del servidor para la web.

**Qué hace y qué no**

- Lanza `claude -p --chrome --agent <subagente> --output-format stream-json --verbose --allowedTools=<lista>` en la
  carpeta `carpeta_trabajo` (una de tus carpetas permitidas) y le pasa por entrada estándar la instrucción de tomar el
  encargo. **El texto del encargo nunca se ejecuta como comando**: el motor ni siquiera lo lee; solo Claude Code lo recibe
  de THE TOWN IA como dato.
- Al empezar cada ciclo declara a THE TOWN IA tus subagentes (`~/.claude/agents/*.md`), enviando **solo** `name` y
  `description` (máximo 500 caracteres) de cada uno. No lee ningún otro archivo.
- **Permisos por defecto**: `mcp__ttia__*`, `mcp__claude-in-chrome__*`, `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Skill`,
  `Task`, `Agent`, `TodoWrite`, `WebSearch` y `WebFetch`. **Bash no está permitido por defecto**; si lo quieres, agrega
  `"Bash"` a `despachador.herramientas_permitidas` en `motor.json`. Lo que no está permitido falla en modo `-p`: por eso el
  encargo le indica a Claude Code que use `preguntar` (te avisa en THE TOWN IA) en vez de hacerlo.
- **Tiempo máximo** (`max_minutos`, 60 por defecto): si un encargo lo pasa, el motor corta el proceso, lo devuelve a la cola
  (`soltar_encargo`) y deja el motivo con `reportar_avance`.
- Si no encuentra `claude`, o Claude Code no tiene la sesión iniciada, **no despacha** y lo dice en la consola del motor y en
  `despachador estado`.
- El token solo viaja en el encabezado `Authorization` hacia la `url_mcp` configurada (https; no sigue redirecciones). El log
  local guarda solo metadatos: id del encargo, subagente, inicio, fin, código de salida y duración. Nunca el texto del
  encargo, la salida de Claude ni el token.
- En **Mi PC**, la web muestra el estado del despachador (activo, último ciclo, encargo en curso).

## Skills de THE TOWN IA para Claude Code

La carpeta [`skills/`](skills) trae skills públicas para Claude Code. El instalador y `motor.cmd skills instalar` las
copian a `%USERPROFILE%\.claude\skills` (sin pisar una skill ajena del mismo nombre: solo reemplaza las que tienen
`ttia: true` en su cabecera; si hay otra, la salta y te avisa). `motor.cmd skills lista` muestra cuáles trae.

- **`conectar-google-empresa`**: con Claude for Chrome y tu sesión de Google ya iniciada (nunca escribe contraseñas), crea
  en el Google Cloud **de tu empresa** la app OAuth (Gmail, Drive, Hojas y Calendario) y guarda el Client ID y el secreto
  en la bóveda de THE TOWN IA. Sin verificación de Google ni CASA, porque el proyecto es propio y de menos de 100 usuarios.
  Al conectar verás «Google no ha verificado esta aplicación»: es normal, elige *Avanzado > Continuar*.
- **`conectar-microsoft-empresa`**: registra la app en Microsoft Entra de tu organización (con `az` si lo tienes, o por la
  consola), con permisos delegados de correo, calendario y archivos, y guarda sus credenciales en la bóveda. El
  consentimiento de administrador lo da la persona administradora.

Ninguna de las dos escribe secretos en el chat, en los avances ni en archivos.

## Configuración

`%APPDATA%\AwkiOffice\motor.json` (se crea la primera vez):

```json
{
  "carpetas_permitidas": ["C:\\Users\\Ana\\Documentos\\Trabajo"],
  "origenes": ["http://localhost:8765", "http://127.0.0.1:8765", "https://ttia.awki.ai"],
  "modelo": "claude-sonnet-5-5",
  "puerto": 47821,
  "workspace": null,
  "despachador": {
    "activo": false,
    "cada_segundos": 60,
    "url_mcp": "https://ttia.awki.ai/mcp",
    "claude": "claude",
    "carpeta_trabajo": null,
    "chrome": true,
    "max_minutos": 60,
    "herramientas_permitidas": ["mcp__ttia__*", "mcp__claude-in-chrome__*", "Read", "Glob", "Grep", "Edit", "Write", "Skill", "Task", "Agent", "TodoWrite", "WebSearch", "WebFetch"]
  }
}
```

- `carpetas_permitidas`: lo único que el agente puede leer o escribir. **Si está vacía, el motor no ejecuta tareas.**
- `origenes`: páginas autorizadas a conectarse (`esquema://host[:puerto]`, sin ruta). El motor no arranca si uno está
  mal escrito o es `*`.
- `modelo`: por defecto `claude-sonnet-5-5`. `puerto`: por defecto 47821 (la web busca el motor ahí).
- `workspace`: id del workspace de Anthropic, **obligatorio con claves `sk-ant-usr-`** (también vale la variable
  `ANTHROPIC_WORKSPACE_ID`).
- `despachador`: ver la sección anterior. `claude` es el ejecutable de Claude Code (o su ruta completa);
  `carpeta_trabajo` (`null` = la primera de `carpetas_permitidas`) tiene que ser una carpeta permitida;
  `herramientas_permitidas` admite solo nombres sin espacios (`Read`, `mcp__ttia__*`…).

Los cambios se leen al reiniciar el motor o escribiendo `recargar` en su ventana.

## Seguridad

- Escucha **solo en 127.0.0.1** y valida `Origin` y `Host` (rechaza páginas no listadas y DNS rebinding).
- Sin el token de sesión del emparejamiento, todo mensaje se rechaza: otra aplicación de tu PC no puede manejar al
  agente.
- El agente solo trabaja dentro de las carpetas permitidas: el motor fija el `cwd`, verifica cada ruta ya normalizada
  (`..`, enlaces simbólicos y junctions incluidos) en un hook `PreToolUse` y en `canUseTool`, y carga el SDK con
  `settingSources: []` para que ninguna regla o hook de otros archivos de configuración apruebe cosas solo.
- Leer dentro de las carpetas: automático. Escribir, borrar, bash/PowerShell, internet o herramientas MCP: siempre
  pide permiso en la web, haya o no contenido externo en el turno.
- La clave va al proceso del SDK solo por variable de entorno; no se escribe en disco ni en los logs.
- Log local en `%APPDATA%\AwkiOffice\logs\`: solo metadatos (ids, estados, errores). Sin prompts ni claves.
- El **despachador** (opcional, apagado por defecto) es otro camino: lanza tu Claude Code con la lista
  `despachador.herramientas_permitidas` (sin Bash por defecto) y solo en `carpeta_trabajo`; lo que no esté permitido falla
  en lugar de pedirte permiso. Su token vive en el Administrador de credenciales y nunca va al log.

Protocolo completo entre la web y el motor: [`docs/protocolo-motor.md`](docs/protocolo-motor.md).

## Desarrollo

Requisitos: Node.js 22 y Windows.

```powershell
npm ci
npm run typecheck
npm test                 # node:test vía tsx
npm run build            # genera dist/
npm run cliente-prueba   # humo: motor en --simulado, empareja, manda una tarea y aprueba el permiso
```

### Publicar una versión

1. Sube `version` en `package.json` y `VERSION` en `src/servidor.ts`.
2. Crea la etiqueta `vX.Y.Z` y súbela. GitHub Actions (`.github/workflows/motor.yml`) corre las pruebas, arma el
   paquete (`instalador/preparar.ps1`: código + Node portable verificado por SHA256), construye el instalador con
   Inno Setup (`instalador/motor.iss`) y publica `TTIA-Motor-Setup.exe` en Releases.

El instalador **no** lleva el Claude Agent SDK: lo descarga de npm en la PC del usuario, sin modificar
(ver [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

## Licencia

[MIT](LICENSE) para el código de este repositorio. Las dependencias tienen sus propias licencias
([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)); el Claude Agent SDK se rige por los términos de Anthropic.
THE TOWN IA no está afiliado a Anthropic.
