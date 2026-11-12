# Componentes de terceros

La licencia MIT de este repositorio cubre **solo el código de este repositorio** (`src/`, `test/`, `scripts/`,
`instalador/`). Las dependencias tienen sus propias licencias y no se incluyen en el repo.

| Componente | Licencia | Cómo llega a tu PC |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` y su binario nativo (`@anthropic-ai/claude-agent-sdk-win32-x64`) | © Anthropic PBC, todos los derechos reservados. Uso sujeto a los términos de Anthropic: https://code.claude.com/docs/en/legal-and-compliance | **No se redistribuye.** El instalador lo descarga de npm en tu PC, sin modificar, tal como lo publica Anthropic. |
| Node.js | MIT y licencias de sus componentes: https://github.com/nodejs/node/blob/main/LICENSE | Va dentro del instalador (`node\`). |
| `@napi-rs/keyring` | MIT | Se descarga de npm al instalar. |
| `ws` | MIT | Se descarga de npm al instalar. |

El motor se conecta a Claude con **tu propia clave de API** de Anthropic (Claude Console). El uso de Claude se rige
por los términos de Anthropic. THE TOWN IA no está afiliado a Anthropic; «Claude» es una marca de Anthropic PBC.
