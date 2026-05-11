---
version: alpha
name: Atlas OS
description: VS Code-compatible Atlas OS interface tokens extracted from atlas-os.dev.
colors:
  primary: "#4FB8FF"
  secondary: "#8B9DFF"
  tertiary: "#AFF5B4"
  neutral: "#8B96A8"
  surface: "#0A0D14"
  surface-elevated: "#0F1320"
  surface-panel: "#11162A"
  border: "#1D2435"
  border-subtle: "#161C2B"
  on-surface: "#E6EDF3"
  on-primary: "#001220"
  error: "#FF3333"
  warning: "#FFAA00"
typography:
  headline-display:
    fontFamily: "Orbitron, var(--vscode-font-family), Geist, Inter, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.04em"
  headline-lg:
    fontFamily: "var(--vscode-font-family), Geist, Inter, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.18
    letterSpacing: "0px"
  headline-md:
    fontFamily: "var(--vscode-font-family), Geist, Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0px"
  body-lg:
    fontFamily: "var(--vscode-font-family), Geist, Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0px"
  body-md:
    fontFamily: "var(--vscode-font-family), Geist, Inter, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0px"
  body-sm:
    fontFamily: "var(--vscode-font-family), Geist, Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0px"
  label-lg:
    fontFamily: "var(--vscode-font-family), Geist, Inter, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0px"
  label-md:
    fontFamily: "var(--vscode-font-family), Geist, Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0px"
  label-sm:
    fontFamily: "var(--vscode-editor-font-family), JetBrains Mono, ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0.08em"
rounded:
  none: "0px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  gutter: "12px"
  margin: "12px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "#79C9FF"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  button-secondary:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: "12px"
  input:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
  badge:
    backgroundColor: "#4FB8FF2A"
    textColor: "{colors.primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "3px 7px"
  badge-success:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.surface}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "3px 7px"
  badge-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.surface}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "3px 7px"
  text-muted:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.neutral}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.none}"
    padding: "0px"
  divider:
    backgroundColor: "{colors.border}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.none}"
    padding: "1px"
  divider-subtle:
    backgroundColor: "{colors.border-subtle}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.none}"
    padding: "1px"
  banner-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
  banner-error:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
---

## Overview

Atlas OS feels like a local-first command center: dark, disciplined, security-aware, and technical without becoming noisy. The website identity is futuristic and high-contrast, but the VS Code extension must feel native beside Copilot Chat, the Explorer, and the terminal. Use the Atlas electric blue and strict mono labels as the brand layer; let VS Code theme variables own the final foregrounds and backgrounds whenever possible.

## Colors

The extracted website palette uses a near-black navy canvas (`#0A0D14`), pale code-like text (`#E6EDF3`), muted blue-gray secondary text (`#8B96A8`), and electric cyan-blue (`#4FB8FF`) for primary action and focus. Purple-blue (`#8B9DFF`) supports model/provider accents, while matrix green (`#AFF5B4`) is reserved for connected, safe, or completed states. In VS Code, read `--vscode-*` foreground, focus, button, and border variables for native contrast, but bias main surfaces back toward the Atlas navy values so the extension does not collapse into a generic grey panel.

## Typography

The marketing site uses Orbitron for the large Atlas wordmark, Geist/Inter for prose, and JetBrains Mono for commands and labels. VS Code webviews should not load remote Google Fonts, so the product UI should use `var(--vscode-font-family)` for readable chat text and `var(--vscode-editor-font-family)` for tool names, command snippets, metrics, and small status labels. Orbitron is kept only as an optional installed-font fallback for compact branding.

## Layout

Use a dense Kilo/Claude/Copilot Chat-style vertical layout: compact top toolbar, centered empty state, scrollable transcript, and sticky bottom composer. The sidebar is a work surface, not a landing page. Keep spacing tight (`8px` to `16px`), reserve `24px` for empty states or major section changes, and keep controls aligned to VS Code's panel rhythm.

## Elevation & Depth

Depth is border-driven and tonal. Prefer 1px borders, subtle inner glows, and background tone steps over large shadows because VS Code themes vary widely and heavy shadows can look foreign inside the editor. A focused composer or running turn may use a small cyan outline or glow, but ordinary chat bubbles should remain quiet.

## Shapes

Corners are modern but restrained: `6px` for fields and pills, `8px` for message/tool surfaces, `12px` only for larger grouped panels. Avoid fully rounded cards except for status chips; Atlas should feel precise and engineered.

## Components

Primary buttons are cyan filled actions with dark text. Secondary buttons are tonal, bordered, and theme-aware. Cards represent repeated chat/tool items only, never page sections. Inputs use the VS Code input background with an Atlas-blue focus border. Badges and chips use mono labels, small caps, and sparse accent fills.

## Do's and Don'ts

- Do keep the UI native to VS Code by using `--vscode-*` variables before hard-coded colors.
- Do use Atlas blue for focus, active states, and streaming activity.
- Do use mono labels for tool calls, provider/model tags, and command snippets.
- Do keep the sidebar dense and scannable like Copilot Chat.
- Don't load remote fonts or images inside the webview.
- Don't use marketing hero layouts inside the extension.
- Don't overuse the green success color; reserve it for connected, completed, or safe states.
- Don't introduce decorative gradients that fight with user themes.