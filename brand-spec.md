# Sistema visual: agenda inmobiliaria

Una interfaz utilitaria de alta legibilidad, con superficies frías y el verde reservado para las acciones principales.

```css
:root {
  --bg:      oklch(98% 0.005 250);
  --surface: oklch(100% 0 0);
  --fg:      oklch(22% 0.02 240);
  --muted:   oklch(50% 0.018 240);
  --border:  oklch(90% 0.008 240);
  --accent:  oklch(58% 0.16 145);

  --font-display: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
  --font-body:    -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;
}
```

## Reglas de postura

- Priorizar densidad útil y jerarquía mediante alineación, no mediante decoración.
- Usar cifras tabulares y la fuente monoespaciada para horas y fechas.
- Separar filas y columnas con bordes finos; no usar franjas alternas.
- Mostrar estados en etiquetas compactas con fondos semánticos suaves.
- Evitar imágenes hero, titulares sobredimensionados y texto promocional.
