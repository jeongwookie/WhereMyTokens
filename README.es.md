<img src="assets/source-icon.png" width="80" align="right" />

# WhereMyTokens

**Aplicación de bandeja del sistema de Windows para monitorear el uso de tokens de Claude Code en tiempo real.**

Creada por un desarrollador coreano que usa Claude Code a diario — resolviendo mi propia necesidad.

Se instala silenciosamente en la barra de tareas y muestra el uso de Claude Code — tokens, costos, actividad de sesiones y límites de uso — de un vistazo.

![Platform](https://img.shields.io/badge/platform-Windows_10%2F11-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Release](https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens)

> [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md)

> 💾 **Sin sincronización en la nube** — solo lee archivos locales de Claude. Tus datos nunca salen de tu máquina.

<table>
  <tr>
    <th width="50%">Modo Claro</th>
    <th width="50%">Modo Oscuro</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-light.png" alt="Light mode" /></td>
    <td><img src="assets/screenshot-dark.png" alt="Dark mode" /></td>
  </tr>
</table>

<table>
  <tr>
    <th width="33%">Rhythm y Estadísticas Pico</th>
    <th width="33%">Mapa de Calor 7 Días</th>
    <th width="33%">Configuración</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-rhythm.png" alt="Rhythm tab" /></td>
    <td><img src="assets/screenshot-heatmap.png" alt="7-day heatmap" /></td>
    <td><img src="assets/screenshot-settings.png" alt="Settings" /></td>
  </tr>
</table>

## Descargar

**[⬇ Descargar Última Versión](https://github.com/jeongwookie/WhereMyTokens/releases/latest)**

1. Descarga `WhereMyTokens-v1.9.1-win-x64.zip`
2. Extrae el zip en cualquier ubicación
3. Ejecuta `WhereMyTokens.exe`

Sin instalador necesario — la aplicación se abre automáticamente y se ubica en la bandeja del sistema.

---

## Características

### Seguimiento de Sesiones
- **Detección en tiempo real** — Terminal, VS Code, Cursor, Windsurf y más con estado en tiempo real: `active` / `waiting` / `idle` / `compacting`
- **Agrupación en 2 niveles** — sesiones agrupadas por proyecto git → rama, con estadísticas de commits y líneas por proyecto
- **Ocultación automática de inactivas** — las sesiones inactivas se colapsan progresivamente; las de 6h+ se ocultan automáticamente (expandible)
- **Advertencias de ventana de contexto** — barra por sesión; ámbar al 50%, naranja al 80%, rojo al 95%+
- **Barras de uso de herramientas** — barra de color proporcional + etiquetas de herramientas (Bash, Edit, Read, …)

### Límites de Uso y Alertas
- **Barras de límite de uso** — uso de 5h y 1sem desde la API de Anthropic, con barras de progreso, contadores de reinicio y grados de eficiencia de caché
- **Puente Claude Code** — regístrate como plugin `statusLine` para datos en tiempo real sin sondeo de API
- **Notificaciones de Windows** — en umbrales de uso configurables (50% / 80% / 90%)
- **Presupuesto Extra Usage** — créditos mensuales usados / límite / utilización %

### Análisis y Actividad
- **Estadísticas del encabezado** — alternancia today/all-time: costo, llamadas API, sesiones, eficiencia de caché, ahorros, desglose de tokens (In/Out/Cache)
- **Pestañas de actividad** — mapa de calor de 7 días, calendario de 5 meses (estilo GitHub), distribución por hora, comparación de 4 semanas
- **Pestaña Rhythm** — distribución de costos por franja horaria (Morning/Afternoon/Evening/Night) con barras de gradiente, estadísticas detalladas del pico, zona horaria local
- **Desglose por modelo** — totales de tokens y costos por modelo con barras de gradiente
- **Activity Breakdown** — análisis de tokens de salida por sesión en 10 categorías (Thinking, Edit/Write, Read, Search, Git, etc.)

### Producción de Código y Productividad
- **Métricas basadas en Git** — commits, líneas netas cambiadas, **$/100 Lines** (costo por 100 líneas añadidas)
- **Hoy vs todo el tiempo** — hoy muestra el costo real por línea con el promedio para comparación
- **Descubrimiento automático** — todos los proyectos en los que has usado Claude vía `~/.claude/projects/`
- **Solo tus commits** — filtrado por `git config user.email`

### Personalización
- **Tema Auto/Claro/Oscuro** — sigue la preferencia del sistema por defecto
- **Visualización de costos** — USD o KRW con tasa de cambio configurable
- **Widget siempre visible** — permanece encima; minimiza vía botón del encabezado, icono de bandeja o atajo global
- **Etiqueta de bandeja** — muestra % de uso, cantidad de tokens o costo directamente en la barra de tareas
- **Gestión de proyectos** — oculta o excluye completamente proyectos del seguimiento
- **Iniciar con Windows** — inicio automático opcional

---

## Inicio Rápido

### 1. Abrir el panel
Haz clic en el icono de la bandeja (o presiona el atajo global `Ctrl+Shift+D`).

### 2. Conectar puente Claude Code (opcional)
**Settings → Claude Code Integration → Setup** — habilita datos de límite de uso en tiempo real sin sondeo de API.

### 3. Configurar
- **Moneda** — USD o KRW
- **Alertas** — establece umbrales de uso (50% / 80% / 90%)
- **Tema** — Auto (sigue el sistema) / Claro / Oscuro
- **Etiqueta de bandeja** — elige qué mostrar en la barra de tareas

---

## Datos y Privacidad

WhereMyTokens solo lee archivos locales — sin sincronización en la nube, sin telemetría.

| Archivo | Propósito |
|---------|-----------|
| `~/.claude/sessions/*.json` | Metadatos de sesión (pid, cwd, modelo) |
| `~/.claude/projects/**/*.jsonl` | Registros de conversación (tokens, costos) |
| `~/.claude/.credentials.json` | Token OAuth — solo para obtener tus estadísticas de uso de Anthropic |
| `%APPDATA%\WhereMyTokens\live-session.json` | Datos del puente escritos por el plugin `statusLine` |

---

## Instalar desde Código Fuente

### Requisitos

- Windows 10 / 11
- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) instalado y con sesión iniciada

### Compilar y Ejecutar

```bash
git clone https://github.com/jeongwookie/WhereMyTokens.git
cd WhereMyTokens
npm install
npm run build
npm start
```

---

## Demo

<div align="center">

https://github.com/user-attachments/assets/98b6f8d7-6fc6-4c12-aef1-af6300db0728

</div>

---

## Aviso Legal

Los costos mostrados son **estimaciones equivalentes a la API**, no facturación real. Las suscripciones Claude Max/Pro son tarifas mensuales fijas. La visualización de costos muestra cuánto valor de uso estás obteniendo de tu suscripción.

---

## Contribuir

Los issues y pull requests son bienvenidos. Por favor, abre un issue primero para discutir los cambios que te gustaría hacer.

---

## Agradecimientos

Inspirado en [duckbar](https://github.com/rofeels/duckbar) — la contraparte para macOS.

---

## Licencia

MIT
