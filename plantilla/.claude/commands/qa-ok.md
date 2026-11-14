---
description: Aceptaste la funcionalidad de un ticket; abre su PR aprobado y en autocompletar
argument-hint: <id del ticket>
---

Actúa como coordinador. La persona probó el ticket **#$ARGUMENTS** y **aceptó la funcionalidad**.

1. `node orquestador/orq.ts pr $ARGUMENTS --probado` (en un ticket con dos repos abre los dos, back primero).
2. Si responde que hay commits sin probar, no lo fuerces: `qa $ARGUMENTS` y pide otra prueba.
3. Responde en una línea por repo: PR, enlace y «en autocompletar».
