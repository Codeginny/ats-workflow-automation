# Seguimiento

Revisa el tracker, actualiza estados y redacta mensajes de seguimiento.

Si el pedido trae un cambio (ej. "#3 entrevista el jueves 10hs con Ana"), aplicalo primero.

1. Si Caro pasó un cambio de estado, aplicalo con `python herramientas/tracker.py estado <id> <estado> --notas "..."`.
2. Corré `python herramientas/tracker.py seguimientos`. Para cada una vencida, redactá un mensaje corto y cordial (máx. 70 palabras) en el canal que se usó. No lo envíes: dejá el texto para que Caro lo copie.
3. Si alguna lleva más de 21 días en 📤 Enviado sin respuesta, proponé pasarla a `rechazado`.
4. Regenerá el panel: `python herramientas/tracker.py panel` (y `excel`).
5. Mostrá un resumen: total por estado, tasa de respuesta y qué tipo de ofertas responden mejor (tipo de empresa, familia de puesto, fuente, puntaje) para ajustar la búsqueda.
