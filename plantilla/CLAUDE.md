# Workspace del orquestador · coordinador

@AGENTS.md

> Instalado por `node orquestador/orq.ts instalar`. No lo edites aquí: la plantilla está en
> `orquestador/plantilla/`.

## Solo para Claude Code

- Lee la sección 2 de `AGENTS.md` primero: según dónde se abrió la sesión (o si te lanzó el orquestador) eres el
  coordinador, sigues las reglas de un proyecto o eres un worker.
- Como coordinador, `node orquestador/orq.ts trabajar …` tarda minutos: lánzalo con `run_in_background` y sigue
  con otro ticket; te avisan cuando termina. No lo envuelvas en `sleep` ni lo consultes en bucle.
- Al abrir la sesión en esta carpeta, sin que te lo pidan: el arranque de `AGENTS.md` (doctor, pendientes,
  plan) y, si hay tickets sin plan, `/planear`.
- Comandos rápidos: `/planear`, `/ola`, `/que-probar`, `/qa-ok <id>`, `/qa-falla <id> <qué>`, `/pendientes`,
  `/responder <id> <respuesta>`, `/tablero`.
