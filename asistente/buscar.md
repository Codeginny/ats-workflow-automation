# Buscar ofertas

Busca avisos de empleo remotos en español en portales públicos y los puntúa.

Buscá ofertas nuevas para Caro según `perfil/preferencias.yaml` (todas las familias de `puestos_objetivo`). Si el pedido trae palabras extra (ej. "fintech"), sumalas a la búsqueda.

Fuentes: `perfil/fuentes.yaml`, sólo páginas públicas y sin iniciar sesión (regla 4 de REGLAS.md). No entran todas en una pasada: revisá siempre las de `latam_y_espanol` y rotá el resto, empezando por las que no figuran en las líneas «Fuentes:» de las últimas búsquedas de `ofertas_encontradas.md`. Si una no carga, anotala y seguí.

Para cada oferta:
1. Descartá las que ya están en `seguimiento.csv` u `ofertas_encontradas.md` (mismo link o misma empresa y puesto) y las de `perfil/ofertas_descartadas.json`.
2. Ventana de fechas: publicadas este mes o el anterior y todavía abiertas. Aplicá `descartar_si`. Si la modalidad no figura, anotala como "confirmar". No descartes por pedir título universitario: anotalo como brecha.
3. Puntuá 0–100 con `puntaje` de preferencias y el maestro.
4. Agregá arriba de `ofertas_encontradas.md` una tabla con: puntaje, puesto, empresa, país, modalidad, idioma, salario (si figura), fecha, link y una columna «Encaje / brecha»: lo que pide la oferta y no está en el maestro, y un tip concreto para cubrirlo.

Al final, mostrale a Caro las 5 mejores y preguntale cuáles quiere preparar (desde la plataforma, con «Postularme»). No postules a nada por tu cuenta.
