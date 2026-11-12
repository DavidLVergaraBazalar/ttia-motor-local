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

## Configuración

`%APPDATA%\AwkiOffice\motor.json` (se crea la primera vez):

```json
{
  "carpetas_permitidas": ["C:\\Users\\Ana\\Documentos\\Trabajo"],
  "origenes": ["http://localhost:8765", "http://127.0.0.1:8765", "https://ttia.awki.ai"],
  "modelo": "claude-sonnet-5-5",
  "puerto": 47821,
  "workspace": null
}
```

- `carpetas_permitidas`: lo único que el agente puede leer o escribir. **Si está vacía, el motor no ejecuta tareas.**
- `origenes`: páginas autorizadas a conectarse (`esquema://host[:puerto]`, sin ruta). El motor no arranca si uno está
  mal escrito o es `*`.
- `modelo`: por defecto `claude-sonnet-5-5`. `puerto`: por defecto 47821 (la web busca el motor ahí).
- `workspace`: id del workspace de Anthropic, **obligatorio con claves `sk-ant-usr-`** (también vale la variable
  `ANTHROPIC_WORKSPACE_ID`).

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
